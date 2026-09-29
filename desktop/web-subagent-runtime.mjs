/**
 * A single, independent, stateless Responses API worker for ForgeLink.
 *
 * Each invocation owns its own transcript. Only caller supplied function tools
 * can be invoked; built-in hosted tools and local process execution are absent.
 * API keys are deliberately kept out of returned results and thrown errors.
 */

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MAX_TURNS = 6;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_500;
const DEFAULT_MAX_TOTAL_OUTPUT_TOKENS = 9_000;
const DEFAULT_MAX_TOTAL_INPUT_TOKENS = 120_000;
const DEFAULT_MAX_TOOL_CALLS = 24;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 24_000;
const DEFAULT_MAX_OUTPUT_CHARS = 32_000;
const MAX_PROMPT_CHARS = 100_000;
const MAX_INSTRUCTIONS_CHARS = 24_000;

function boundedInteger(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function requireText(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new TypeError(`${name} must be nonempty text of at most ${maximum} characters`);
  }
  return value;
}

function validatedTools(tools) {
  if (!Array.isArray(tools) || tools.length > 32) {
    throw new TypeError('tools must be an array of at most 32 function definitions');
  }
  const names = new Set();
  for (const tool of tools) {
    if (!tool || tool.type !== 'function' || typeof tool.name !== 'string' ||
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name) || names.has(tool.name) ||
        !tool.parameters || tool.parameters.type !== 'object') {
      throw new TypeError('Only uniquely named function tools with object parameters are allowed');
    }
    names.add(tool.name);
  }
  return names;
}

function outputText(response) {
  const pieces = [];
  for (const item of response.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') pieces.push(part.text);
    }
  }
  return pieces.join('\n').trim();
}

function toolOutput(value, maxChars) {
  let serialized;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  } catch {
    serialized = JSON.stringify({ error: 'Tool result could not be serialized' });
  }
  if (typeof serialized !== 'string') serialized = 'null';
  if (serialized.length <= maxChars) return serialized;
  return JSON.stringify({ truncated: true, output: serialized.slice(0, maxChars) });
}

function parsedArguments(item) {
  if (typeof item.arguments !== 'string' || item.arguments.length > 100_000) {
    throw new TypeError('Invalid function call arguments');
  }
  const value = JSON.parse(item.arguments);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Function call arguments must be a JSON object');
  }
  return value;
}

function interrupted(signal) {
  if (signal?.aborted) {
    const error = new Error('Subagent cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

async function retryDelay(milliseconds, signal) {
  interrupted(signal);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Subagent cancelled')); }
    signal?.addEventListener('abort', abort, { once: true });
  });
  interrupted(signal);
}

/**
 * Run one model backed subagent. A separate invocation creates a separate
 * transcript and API conversation. The caller is responsible for scoping the
 * executeTool callback to this worker's assigned resources.
 */
export async function runWebSubagent({
  apiKey,
  model,
  prompt,
  instructions = 'Complete only the assigned task. Use only the available tools. Report findings and evidence concisely.',
  tools = [],
  executeTool,
  signal,
  maxTurns,
  maxOutputTokens,
  maxTotalOutputTokens,
  maxTotalInputTokens,
  maxToolCalls,
  maxToolOutputChars,
  maxOutputChars,
  fetchImpl = globalThis.fetch,
  baseUrl,
} = {}) {
  requireText(apiKey, 'apiKey', 8_192);
  requireText(model, 'model', 256);
  requireText(prompt, 'prompt', MAX_PROMPT_CHARS);
  requireText(instructions, 'instructions', MAX_INSTRUCTIONS_CHARS);
  if (baseUrl !== undefined && baseUrl !== 'https://api.openai.com/v1') {
    throw new TypeError('Only the official OpenAI API endpoint is allowed');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const allowedTools = validatedTools(tools);
  if (allowedTools.size && typeof executeTool !== 'function') {
    throw new TypeError('executeTool is required when tools are provided');
  }
  const turnLimit = boundedInteger(maxTurns, DEFAULT_MAX_TURNS, 20, 'maxTurns');
  const turnOutputLimit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 16_384, 'maxOutputTokens');
  const totalOutputLimit = boundedInteger(maxTotalOutputTokens, DEFAULT_MAX_TOTAL_OUTPUT_TOKENS, 65_536, 'maxTotalOutputTokens');
  const totalInputLimit = boundedInteger(maxTotalInputTokens, DEFAULT_MAX_TOTAL_INPUT_TOKENS, 500_000, 'maxTotalInputTokens');
  const toolCallLimit = boundedInteger(maxToolCalls, DEFAULT_MAX_TOOL_CALLS, 128, 'maxToolCalls');
  const toolOutputLimit = boundedInteger(maxToolOutputChars, DEFAULT_MAX_TOOL_OUTPUT_CHARS, 100_000, 'maxToolOutputChars');
  const outputCharLimit = boundedInteger(maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, 100_000, 'maxOutputChars');

  const transcript = [{ role: 'user', content: prompt }];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const toolCalls = [];
  let lastOutput = '';
  let turns = 0;
  let outputBudget = totalOutputLimit;

  while (turns < turnLimit && outputBudget > 0 && usage.inputTokens < totalInputLimit) {
    interrupted(signal);
    const request = {
      model,
      instructions,
      input: transcript,
      tools,
      tool_choice: allowedTools.size ? 'auto' : 'none',
      parallel_tool_calls: false,
      max_output_tokens: Math.min(turnOutputLimit, outputBudget),
      store: false,
    };
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetchImpl(RESPONSES_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
          signal,
        });
      } catch (error) {
        interrupted(signal);
        // Transport errors can contain URLs or headers supplied by intermediaries.
        throw new Error(`Responses API request failed (${error?.name === 'AbortError' ? 'aborted' : 'network error'})`);
      }
      if (!response || ![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) break;
      await response.body?.cancel?.().catch(() => {});
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      const milliseconds = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(5000, retryAfter * 1000) : 250 * (2 ** attempt);
      await retryDelay(milliseconds, signal);
    }
    if (!response?.ok) {
      throw new Error(`Responses API returned HTTP ${Number(response?.status) || 'error'}`);
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('Responses API returned invalid JSON');
    }
    if (!result || !Array.isArray(result.output)) {
      throw new Error('Responses API returned an invalid response');
    }
    turns += 1;
    const currentUsage = result.usage ?? {};
    usage.inputTokens += Number.isFinite(currentUsage.input_tokens) ? currentUsage.input_tokens : 0;
    usage.outputTokens += Number.isFinite(currentUsage.output_tokens) ? currentUsage.output_tokens : 0;
    usage.totalTokens += Number.isFinite(currentUsage.total_tokens) ? currentUsage.total_tokens : 0;
    outputBudget -= Number.isFinite(currentUsage.output_tokens)
      ? Math.max(0, currentUsage.output_tokens)
      : request.max_output_tokens;

    const text = outputText(result);
    if (text) lastOutput = text.slice(0, outputCharLimit);
    const calls = result.output.filter((item) => item?.type === 'function_call');
    if (!calls.length) {
      return {
        status: result.status === 'completed' ? 'completed' : 'incomplete',
        output: lastOutput,
        usage,
        turns,
        toolCalls,
      };
    }
    if (result.status !== 'completed' || turns >= turnLimit || outputBudget <= 0 || usage.inputTokens >= totalInputLimit ||
        toolCalls.length + calls.length > toolCallLimit) {
      return { status: 'incomplete', output: lastOutput, usage, turns, toolCalls };
    }

    // Stateless continuation: replay every returned item, including encrypted
    // reasoning items, then append results keyed to the matching call_id.
    transcript.push(...result.output);
    for (const call of calls) {
      interrupted(signal);
      const trace = { name: call.name, callId: call.call_id, status: 'rejected' };
      let value;
      if (typeof call.call_id !== 'string' || !call.call_id) {
        throw new Error('Responses API returned a function call without a call ID');
      }
      if (!allowedTools.has(call.name)) {
        value = { error: 'Tool is not allowed for this subagent' };
      } else {
        try {
          const args = parsedArguments(call);
          value = await executeTool({ name: call.name, arguments: args, callId: call.call_id, signal });
          trace.status = 'completed';
        } catch {
          interrupted(signal);
          value = { error: 'Tool execution failed' };
          trace.status = 'failed';
        }
      }
      toolCalls.push(trace);
      transcript.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: toolOutput(value, toolOutputLimit),
      });
    }
  }
  return { status: 'incomplete', output: lastOutput, usage, turns, toolCalls };
}
