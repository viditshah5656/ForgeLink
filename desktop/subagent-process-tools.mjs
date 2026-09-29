import fs from 'node:fs';
import path from 'node:path';

const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4096;

function tool(name, description, properties) {
  return { type: 'function', name, description, strict: true,
    parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } };
}

function normalizeCommand(command, args) {
  if (!['node', 'npm', 'python', 'pytest', 'git'].includes(command)) throw new Error('Process command must be node, npm, python, pytest, or git');
  if (!Array.isArray(args) || args.length > MAX_ARGS || args.some((arg) => typeof arg !== 'string' || arg.length > MAX_ARG_CHARS || arg.includes('\0'))) {
    throw new Error(`Process arguments must be an array of at most ${MAX_ARGS} strings, each no longer than ${MAX_ARG_CHARS} characters`);
  }
  if (command === 'node' && args.some((arg) => /^-(?:e|p|c)$|^--(?:eval|print|check)$/i.test(arg))) {
    throw new Error('Inline Node code and check-only modes are not available; run a project script or test file instead');
  }
  if (command === 'python' && args.some((arg) => ['-c', '-m', '-i'].includes(arg))) {
    throw new Error('Inline Python, module servers, and interactive interpreters are not available');
  }
  if (command === 'npm' && !['test', 'run', '--version', '--help'].includes(args[0]?.toLowerCase())) {
    throw new Error('Only npm test and named project scripts (npm run <script>) are available');
  }
  if (command === 'git' && !['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'grep', 'tag', 'describe'].includes(args[0]?.toLowerCase())) {
    throw new Error('Only local read-only Git inspection commands are available to agents');
  }
  return { command, args };
}

function executableFor(command, args) {
  if (command === 'node') return { program: process.execPath, args };
  if (command === 'npm' && process.platform === 'win32') {
    const candidates = [
      process.env.npm_execpath,
      path.resolve(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.resolve(path.dirname(process.execPath), '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].filter(Boolean);
    const cli = candidates.find((candidate) => path.isAbsolute(candidate) && fs.existsSync(candidate));
    if (!cli) throw new Error('Could not locate npm-cli.js for shell-free Windows process execution');
    return { program: process.execPath, args: [cli, ...args] };
  }
  return { program: command, args };
}

/** Task-owned process tools for an explicitly granted, isolated worker workspace. */
export function createSubagentProcessTools({ jobManager, terminalManager, terminalShells = [], terminalEnv, isEnabled = () => true, safetyCheck = async () => {}, root, owner, swarmId = null, taskId = null, signal } = {}) {
  if (!jobManager || typeof jobManager.start !== 'function') throw new TypeError('A ForgeLink JobManager is required');
  if (typeof root !== 'string' || !root) throw new TypeError('A private workspace root is required');
  if (typeof owner !== 'string' || !owner) throw new TypeError('A process owner ID is required');
  const owned = new Set();
  const ownedTerminals = new Set();
  let disposed = false;
  let disposePromise;
  const specs = [
    tool('process_start', 'Start one task-owned command inside the private agent workspace. The process still has the backend user OS permissions; jobs are automatically stopped when the agent exits.', {
      command: { type: 'string', enum: ['node', 'npm', 'python', 'pytest', 'git'] },
      args: { type: 'array', items: { type: 'string' }, description: 'Argument vector; no shell command string is accepted.' },
      timeoutSeconds: { type: 'integer', minimum: 1, maximum: 3600 },
    }),
    tool('process_status', 'Read the status of a process started by this agent.', { jobId: { type: 'string' } }),
    tool('process_output', 'Read bounded stdout and stderr from a process started by this agent.', {
      jobId: { type: 'string' }, stream: { type: 'string', enum: ['stdout', 'stderr', 'both'] }, maxChars: { type: 'integer', minimum: 1, maximum: 20000 },
    }),
    tool('process_wait', 'Wait up to 30 seconds for a task-owned process to finish.', { jobId: { type: 'string' } }),
    tool('process_stop', 'Stop a process started by this agent.', { jobId: { type: 'string' } }),
  ];
  if (terminalManager) specs.push(
    tool('terminal_create', 'Create an interactive ForgeLink terminal fixed to this isolated task workspace. Shell commands run with backend-user OS permissions.', {
      shell: { type: 'string', enum: terminalShells },
    }),
    tool('terminal_input', 'Send bounded text to this agent-owned interactive terminal.', {
      sessionId: { type: 'string' }, text: { type: 'string' }, enter: { type: 'boolean' },
    }),
    tool('terminal_output', 'Read bounded output from this agent-owned terminal.', {
      sessionId: { type: 'string' }, afterOffset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 20000 },
    }),
    tool('terminal_status', 'Inspect this agent-owned terminal session.', { sessionId: { type: 'string' } }),
    tool('terminal_signal', 'Interrupt or terminate this agent-owned terminal and its descendants.', {
      sessionId: { type: 'string' }, signal: { type: 'string', enum: ['interrupt', 'terminate', 'kill'] },
    }),
    tool('terminal_close', 'Close this agent-owned terminal and its descendants.', { sessionId: { type: 'string' } }),
    tool('terminal_snapshot', 'Read a bounded snapshot of this agent-owned terminal output.', {
      sessionId: { type: 'string' }, maxChars: { type: 'integer', minimum: 1, maximum: 20000 },
    }),
  );
  const ownedJob = (id) => {
    if (!owned.has(id)) throw new Error('Process job is not owned by this agent');
    return jobManager.status(id);
  };
  const ownedTerminal = (id) => {
    if (!terminalManager || !ownedTerminals.has(id)) throw new Error('Terminal session is not owned by this agent');
    return terminalManager.status(id);
  };
  const execute = async (name, input = {}) => {
    if (disposed) throw new Error('Agent process tools are closed');
    if (signal?.aborted) throw new Error('Agent was cancelled; no new process may be started');
    if (!isEnabled()) throw new Error('Agent process access is disabled because Full terminal mode is not enabled');
    if (!specs.some((entry) => entry.name === name)) throw new Error(`Unknown process tool: ${name}`);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Process tool arguments must be an object');
    if (name === 'process_start') {
      if ([...owned].filter((jobId) => { try { return jobManager.status(jobId).status === 'running'; } catch { return false; } }).length >= 4) throw new Error('An agent may run at most four process jobs at once');
      const { command, args } = normalizeCommand(input.command, input.args);
      await safetyCheck({ tool: 'agent_process_start', command, args, root });
      const timeoutSeconds = input.timeoutSeconds ?? 600;
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new RangeError('timeoutSeconds must be from 1 to 3600');
      const executable = executableFor(command, args);
      const result = jobManager.start({ ...executable, cwd: root, kind: 'native_agent',
        task: { swarmId, taskId, agentId: owner }, timeoutSeconds });
      owned.add(result.jobId);
      return result;
    }
    if (name === 'terminal_create') {
      if (!terminalManager) throw new Error('ForgeLink terminal manager is not configured');
      if ([...ownedTerminals].filter((id) => { try { return terminalManager.status(id).status === 'running'; } catch { return false; } }).length >= 2) throw new Error('An agent may have at most two interactive terminals at once');
      if (!terminalShells.includes(input.shell)) throw new Error('Requested shell is unavailable or not permitted');
      const session = terminalManager.create({ shell: input.shell, cwd: root, env: terminalEnv,
        owner: { swarmId, taskId, agentId: owner } });
      ownedTerminals.add(session.sessionId);
      return session;
    }
    if (name.startsWith('terminal_')) {
      const sessionId = input.sessionId;
      ownedTerminal(sessionId);
      if (name === 'terminal_status') return terminalManager.status(sessionId);
      if (name === 'terminal_input') {
        if (typeof input.text !== 'string' || input.text.length > 20_000 || input.text.includes('\0') || typeof input.enter !== 'boolean') {
          throw new Error('Terminal input must be at most 20,000 characters with an explicit enter flag');
        }
        if (input.enter !== true) throw new Error('Full Headless agent terminals require enter=true so each complete command can be safety-inspected.');
        if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(input.text)) throw new Error('Raw terminal control characters are disabled.');
        await safetyCheck({ tool: 'agent_terminal_input', command: input.text, args: [], root });
        return terminalManager.input(sessionId, input.text, true);
      }
      if (name === 'terminal_output') {
        const afterOffset = input.afterOffset ?? 0;
        const maxChars = input.maxChars ?? 20_000;
        if (!Number.isSafeInteger(afterOffset) || afterOffset < 0 || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 20_000) throw new Error('Invalid terminal output bounds');
        return terminalManager.read(sessionId, { afterOffset, maxChars });
      }
      if (name === 'terminal_snapshot') {
        const maxChars = input.maxChars ?? 4000;
        if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 20_000) throw new Error('Invalid terminal snapshot bound');
        return terminalManager.snapshot(sessionId, maxChars);
      }
      if (name === 'terminal_close') return terminalManager.close(sessionId);
      if (name === 'terminal_signal') {
        if (!['interrupt', 'terminate', 'kill'].includes(input.signal)) throw new Error('Unsupported terminal signal');
        return terminalManager.signal(sessionId, input.signal);
      }
    }
    const { jobId } = input;
    ownedJob(jobId);
    if (name === 'process_status') return jobManager.status(jobId);
    if (name === 'process_output') {
      const stream = input.stream ?? 'both';
      const maxChars = input.maxChars ?? 20000;
      if (!['stdout', 'stderr', 'both'].includes(stream) || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 20000) throw new Error('Invalid process output bounds');
      return jobManager.output(jobId, { stream, maxChars });
    }
    if (name === 'process_wait') return await jobManager.wait(jobId, 30000);
    return jobManager.cancel(jobId);
  };
  const dispose = () => {
    if (disposePromise) return disposePromise;
    disposed = true;
    disposePromise = (async () => {
      for (const jobId of owned) {
        try { if (jobManager.status(jobId).status === 'running') jobManager.cancel(jobId); } catch {}
      }
      await Promise.all([...owned].map(async (jobId) => {
        let result = await jobManager.wait(jobId, 5000);
        if (result.status === 'running' || result.status === 'cancelling' || result.status === 'timing_out') {
          jobManager.cancel(jobId);
          result = await jobManager.wait(jobId, 2000);
        }
        if (['running', 'cancelling', 'timing_out'].includes(result.status)) throw new Error(`Could not stop agent-owned process ${jobId} before workspace cleanup`);
      }));
      for (const sessionId of ownedTerminals) {
        const active = () => ['running', 'closing'].includes(terminalManager.status(sessionId).status);
        if (active()) terminalManager.close(sessionId);
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && active()) await new Promise((resolve) => setTimeout(resolve, 50));
        if (active()) {
          terminalManager.signal(sessionId, 'kill');
          const killDeadline = Date.now() + 2000;
          while (Date.now() < killDeadline && active()) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (active()) throw new Error(`Could not stop agent-owned terminal ${sessionId} before workspace cleanup`);
      }
    })();
    return disposePromise;
  };
  signal?.addEventListener('abort', () => { void dispose(); }, { once: true });
  return { specs, execute, dispose, owner };
}
