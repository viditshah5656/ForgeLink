import { spawn } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_CHARS = 120_000;
const MAX_ERROR_CHARS = 8_000;

function pathEntries(value) {
  return String(value ?? '').split(delimiter).filter(Boolean);
}

function isExecutableFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function candidateFromPath(env) {
  const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const entry of pathEntries(env.PATH)) {
    const candidate = join(entry, executableName);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function vscodeExtensionCandidates(env) {
  if (process.platform !== 'win32') return [];
  const home = env.USERPROFILE ?? env.HOME;
  const roots = [
    env.VSCODE_EXTENSIONS,
    home && join(home, '.vscode', 'extensions'),
    home && join(home, '.vscode-insiders', 'extensions'),
    home && join(home, '.cursor', 'extensions'),
  ].filter(Boolean);
  const platformDirs = [
    join('bin', 'windows-x86_64', 'codex.exe'),
    join('bin', 'windows-aarch64', 'codex.exe'),
    join('bin', 'windows-x86_64', 'codex'),
  ];
  const candidates = [];
  for (const root of roots) {
    try {
      const entries = requireDirectoryEntries(root);
      for (const entry of entries) {
        if (!/^openai\.chatgpt-/i.test(entry)) continue;
        for (const relative of platformDirs) candidates.push(join(root, entry, relative));
      }
    } catch {
      // An absent or unreadable editor extension directory is not an error.
    }
  }
  return candidates.reverse();
}

function requireDirectoryEntries(path) {
  // Kept behind a helper so missing extension folders remain an optional lookup.
  return readdirSync(path);
}

/** Resolve the Codex executable from CODEX_BIN, PATH, or an installed VS Code extension. */
export function codexExecutable({ env = process.env } = {}) {
  const configured = String(env.CODEX_BIN ?? '').trim();
  if (configured && isExecutableFile(configured)) return configured;
  const pathCandidate = candidateFromPath(env);
  if (pathCandidate) return pathCandidate;
  return vscodeExtensionCandidates(env).find(isExecutableFile);
}

function childEnvironment(env = process.env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/^(?:OPENAI_.*|AZURE_OPENAI_.*|CODEX_ACCESS_TOKEN|CODEX_API_KEY|CODEX_.*(?:KEY|TOKEN|BASE|URL|ENDPOINT))$/i.test(key)
      || /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|COOKIE)/i.test(key)) {
      delete clean[key];
    }
  }
  return clean;
}

function spawnHidden(command, args, options) {
  return spawn(command, args, {
    windowsHide: true,
    ...options,
  });
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const killer = spawnHidden('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {});
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
  }
  const forceTimer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
  }, 1_500);
  forceTimer.unref?.();
}

function runCaptured(command, args, { timeoutMs = 5_000, env = process.env } = {}) {
  return new Promise((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawnHidden(command, args, {
      env: childEnvironment(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_ERROR_CHARS) stdout += chunk.toString('utf8').slice(0, MAX_ERROR_CHARS - stdout.length);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_ERROR_CHARS) stderr += chunk.toString('utf8').slice(0, MAX_ERROR_CHARS - stderr.length);
    });
    child.once('error', (error) => finish({ error }));
    child.once('close', (code, signal) => finish({ code, signal, stdout, stderr }));
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({ timedOut: true, stdout, stderr });
    }, timeoutMs);
    timer.unref?.();
  });
}

/** Check the local Codex CLI's existing ChatGPT sign-in without exposing CLI output. */
export async function codexLoginStatus({ executable = codexExecutable(), timeoutMs = 5_000 } = {}) {
  if (!executable) return { available: false, authenticated: false, status: 'codex_not_found' };
  const result = await runCaptured(executable, ['login', 'status'], { timeoutMs });
  if (result.error) return { available: false, authenticated: false, status: 'codex_unavailable' };
  if (result.timedOut) return { available: true, authenticated: false, status: 'status_check_timed_out' };
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.toLowerCase();
  const authenticated = result.code === 0 && /logged in|authenticated|chatgpt account/.test(combined)
    && !/not logged in|unauthenticated|not authenticated/.test(combined);
  return {
    available: true,
    authenticated,
    status: authenticated ? 'authenticated' : result.code === 0 ? 'not_authenticated' : 'login_required',
  };
}

function cleanOutput(value, root) {
  let text = String(value ?? '');
  const rootText = String(root ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (rootText) text = text.replace(new RegExp(rootText, 'gi'), '<workspace>');
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\b(OPENAI|CODEX)_API_KEY\s*[:=]\s*[^\s"']+/gi, '$1_API_KEY=[REDACTED]')
    .replace(/(?:[A-Za-z]:\\Users\\)[^\r\n"']+/gi, '<local-path>')
    .replace(/\/(?:home|Users)\/[^\r\n"']+/g, '<local-path>');
}

function parseJsonEvent(line, state) {
  if (!line || line.length > 2_000_000) return;
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event?.type === 'turn.started') state.turns += 1;
  if (typeof event?.final_agent_message === 'string') state.finalMessage = event.final_agent_message;
  if (typeof event?.message === 'string' && /agent_message|final/i.test(String(event.type ?? ''))) state.finalMessage = event.message;
  if (event?.type === 'item.completed' && event?.item?.type === 'agent_message' && typeof event.item.text === 'string') {
    state.finalMessage = event.item.text;
  }
  if (event?.type === 'turn.completed') state.completedTurns += 1;
  if (event?.type === 'turn.failed' && typeof event.error?.message === 'string') state.errorMessage = event.error.message;
}

function normalizedMode(mode) {
  return mode === 'workspace-write' ? 'workspace-write' : 'read-only';
}

function validateRoot(root) {
  if (typeof root !== 'string' || !root.trim()) throw new TypeError('A workspace root is required.');
  const absolute = resolve(root);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new TypeError('Workspace root must be an existing directory.');
  return realpathSync(absolute);
}

/**
 * Run one independent Codex CLI conversation using its existing ChatGPT login.
 * The child receives no OpenAI API key or API endpoint environment variables.
 */
export async function runCodexSubagent({
  prompt,
  instructions = '',
  model,
  root,
  mode = 'read-only',
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
  executable = codexExecutable(),
  env = process.env,
} = {}) {
  if (!executable) return { status: 'unavailable', output: '', exitCode: null, error: 'Codex CLI was not found.' };
  if (typeof prompt !== 'string' || !prompt.trim()) return { status: 'failed', output: '', exitCode: null, error: 'A non-empty task prompt is required.' };
  let workspace;
  try { workspace = validateRoot(root); } catch (error) {
    return { status: 'failed', output: '', exitCode: null, error: error.message };
  }
  if (signal?.aborted) return { status: 'cancelled', output: '', exitCode: null };

  const safeLimit = Number.isFinite(maxOutputChars) ? Math.max(256, Math.min(1_000_000, Math.floor(maxOutputChars))) : DEFAULT_MAX_OUTPUT_CHARS;
  const safeTimeout = Number.isFinite(timeoutMs) ? Math.max(1_000, Math.min(60 * 60 * 1000, Math.floor(timeoutMs))) : DEFAULT_TIMEOUT_MS;
  const childArgs = [
    'exec', '--json', '--sandbox', normalizedMode(mode), '--cd', workspace,
    '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--color', 'never',
    '--config', 'model_reasoning_effort="xhigh"',
  ];
  if (typeof model === 'string' && /^[A-Za-z0-9._:/+-]{1,100}$/.test(model)) childArgs.push('--model', model);
  childArgs.push('-');
  const fullPrompt = [
    instructions.trim() ? `Subagent operating instructions:\n${instructions.trim()}` : '',
    `Assigned task:\n${prompt.trim()}`,
  ].filter(Boolean).join('\n\n');

  return new Promise((resolveResult) => {
    const state = { finalMessage: '', errorMessage: '', turns: 0, completedTurns: 0 };
    let stdoutLineBuffer = '';
    let stderr = '';
    let outputChars = 0;
    let abortKind = '';
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const rawOutput = state.finalMessage || state.errorMessage;
      let output = cleanOutput(rawOutput, workspace);
      if (output.length > safeLimit) output = `${output.slice(0, safeLimit)}\n[output truncated]`;
      const status = abortKind === 'timeout' ? 'timed_out'
        : abortKind === 'cancelled' ? 'cancelled'
          : abortKind === 'output_limit' ? 'output_limit'
          : result.error ? 'unavailable'
            : result.code === 0 ? 'completed' : 'failed';
      resolveResult({
        status,
        output,
        exitCode: Number.isInteger(result.code) ? result.code : null,
        turns: state.completedTurns || state.turns || undefined,
        ...(status === 'failed' && stderr.trim() ? { error: cleanOutput(stderr, workspace).slice(0, MAX_ERROR_CHARS) } : {}),
      });
    };
    const onAbort = () => {
      if (settled) return;
      abortKind = 'cancelled';
      killProcessTree(child);
    };
    try {
      child = spawnHidden(executable, childArgs, {
        cwd: workspace,
        env: childEnvironment(env),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      resolveResult({ status: 'unavailable', output: '', exitCode: null, error: cleanOutput(error.message, workspace) });
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      // Always drain, but never retain unbounded JSONL or diagnostic data.
      outputChars += chunk.length;
      if (outputChars > safeLimit * 8 && !abortKind) {
        abortKind = 'output_limit';
        killProcessTree(child);
      }
      stdoutLineBuffer += chunk;
      if (stdoutLineBuffer.length > 2_000_000) stdoutLineBuffer = stdoutLineBuffer.slice(-2_000_000);
      let newline;
      while ((newline = stdoutLineBuffer.indexOf('\n')) !== -1) {
        const line = stdoutLineBuffer.slice(0, newline);
        stdoutLineBuffer = stdoutLineBuffer.slice(newline + 1);
        parseJsonEvent(line, state);
      }
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_ERROR_CHARS) stderr += chunk.slice(0, MAX_ERROR_CHARS - stderr.length);
    });
    child.once('error', (error) => finish({ error }));
    child.once('close', (code) => {
      if (stdoutLineBuffer) parseJsonEvent(stdoutLineBuffer, state);
      finish({ code });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      if (settled) return;
      abortKind = 'timeout';
      killProcessTree(child);
    }, safeTimeout);
    timer.unref?.();
    if (signal?.aborted) onAbort();
    else child.stdin?.end(fullPrompt, 'utf8');
  });
}
