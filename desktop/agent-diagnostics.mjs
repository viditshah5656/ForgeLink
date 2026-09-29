import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const TOOL_COMMANDS = {
  git: ['git'], python: ['python', 'python3', 'py'], node: ['node'], npm: ['npm'],
  pnpm: ['pnpm'], yarn: ['yarn'], bun: ['bun'], uv: ['uv'], conda: ['conda'],
  java: ['java'], go: ['go'], rustc: ['rustc'], dotnet: ['dotnet'],
  docker: ['docker'], wsl: ['wsl'], gh: ['gh'], ffmpeg: ['ffmpeg'],
  sevenZip: ['7z', '7za'], curl: ['curl'], ssh: ['ssh'], kubectl: ['kubectl'],
  cmake: ['cmake'], gcc: ['gcc'], clang: ['clang'], nvcc: ['nvcc'],
};

export async function inspectPathEnvironment({ pathValue = process.env.PATH || '', platform = process.platform, names = TOOL_COMMANDS } = {}) {
  const separator = platform === 'win32' ? ';' : ':';
  const directories = [...new Set(pathValue.split(separator).filter(Boolean).map((item) => path.resolve(item)))].slice(0, 64);
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const listings = await Promise.all(directories.map(async (directory) => {
    try { return new Set((await fs.readdir(directory)).map((item) => platform === 'win32' ? item.toLowerCase() : item)); }
    catch { return new Set(); }
  }));
  const tools = {};
  for (const [name, commands] of Object.entries(names)) {
    const matches = [];
    for (let index = 0; index < directories.length; index += 1) {
      const directory = directories[index];
      for (const command of commands) {
        for (const extension of extensions) {
          const filename = platform === 'win32' && !command.toLowerCase().endsWith(extension) ? `${command}${extension}` : command;
          if (!listings[index].has(platform === 'win32' ? filename.toLowerCase() : filename)) continue;
          const candidate = path.join(directory, filename);
          try {
            if ((await fs.stat(candidate)).isFile()) matches.push(candidate);
          } catch {}
        }
      }
    }
    tools[name] = { available: matches.length > 0, selected: matches[0] ?? null, alternatives: matches.slice(1, 8), conflict: matches.length > 1, provider: matches.length ? 'PATH' : null, version: name === 'node' && matches[0] === process.execPath ? process.version : null };
  }
  return { directories, tools };
}

const ENV_NAMES = ['PATH', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'JAVA_HOME', 'DOTNET_ROOT', 'CUDA_PATH', 'NODE_ENV', 'PYTHONPATH'];
export function environmentSnapshot(env = process.env) {
  const values = {};
  for (const name of ENV_NAMES) if (typeof env[name] === 'string') values[name] = env[name].slice(0, 12000);
  return { capturedAt: new Date().toISOString(), platform: process.platform, values };
}

export function environmentDiff(left, right) {
  const names = [...new Set([...Object.keys(left.values || {}), ...Object.keys(right.values || {})])].sort();
  return { changes: names.flatMap((name) => left.values?.[name] === right.values?.[name] ? [] : [{ name, before: left.values?.[name] ?? null, after: right.values?.[name] ?? null }]) };
}

export function redactDiagnostic(text) {
  return String(text)
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g, '[CREDENTIAL REDACTED]')
    .replace(/\b(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(password|api[_-]?key|token|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]');
}

export function inspectShellProfile(text) {
  const lines = text.split(/\r?\n/).slice(0, 5000);
  const aliases = [];
  const functions = [];
  const pathChanges = [];
  const configEntries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    let match = line.match(/^(?:alias\s+)([\w.-]+)=(.+)$/) || line.match(/^Set-Alias\s+(?:-Name\s+)?([\w.-]+)\s+(?:-Value\s+)?(.+)$/i);
    if (match) aliases.push({ line: index + 1, name: match[1], target: redactDiagnostic(match[2]).slice(0, 200) });
    match = line.match(/^(?:function\s+)([\w.-]+)/i) || line.match(/^([\w.-]+)\s*\(\)\s*\{/);
    if (match) functions.push({ line: index + 1, name: match[1] });
    if (/\b(?:PATH|Path)\b/.test(line) && /(?:=|\+=|export|SetEnvironmentVariable)/i.test(line)) pathChanges.push({ line: index + 1, text: redactDiagnostic(line).slice(0, 200) });
    if (/^(?:auto_activate_base|changeps1|envs_dirs|pkgs_dirs|channels|default_channels)\s*:/i.test(line)) configEntries.push({ line: index + 1, text: redactDiagnostic(line).slice(0, 200) });
  }
  return { aliases: aliases.slice(0, 100), functions: functions.slice(0, 100), pathChanges: pathChanges.slice(0, 100), configEntries: configEntries.slice(0, 100), truncated: lines.length >= 5000 };
}

function requestId(text) {
  const match = text.match(/\b(?:request[_-]?id|trace[_-]?id|correlation[_-]?id|x-request-id)["']?\s*[=:]\s*["']?([A-Za-z0-9_-]{8,80})/i);
  return match?.[1] ?? null;
}

export function parseLog(text, limit = 100) {
  if (/^\s*<\?xml[^>]*>\s*<(?:testsuites|testsuite)\b|^\s*<(?:testsuites|testsuite)\b/i.test(text)) {
    const tests = [...text.matchAll(/<testcase\b([^>]*)>([\s\S]*?)<\/testcase>|<testcase\b([^>]*)\/>/gi)].slice(-Math.min(limit, 500));
    return tests.map((match) => {
      const attributes = match[1] || match[3] || '';
      const attribute = (name) => attributes.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
      const body = match[2] || '';
      return { format: 'junit', timestamp: null, level: /<(?:failure|error)\b/i.test(body) ? 'ERROR' : /<skipped\b/i.test(body) ? 'WARN' : 'INFO', component: attribute('classname'), requestId: requestId(body), message: redactDiagnostic(attribute('name') || 'testcase').slice(0, 500), durationSeconds: Number(attribute('time') || 0) };
    });
  }
  const rows = text.split(/\r?\n/).filter(Boolean).slice(-Math.min(limit * 8, 4000));
  const entries = [];
  for (const line of rows) {
    let parsed;
    try { parsed = JSON.parse(line); } catch {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const message = String(parsed.message ?? parsed.msg ?? parsed.log ?? parsed.error ?? '');
      entries.push({ format: parsed.log !== undefined && parsed.stream ? 'docker-json' : 'json', timestamp: parsed.timestamp ?? parsed.time ?? parsed.at ?? null, level: parsed.level ?? parsed.severity ?? (/stderr/i.test(parsed.stream || '') ? 'ERROR' : null), component: parsed.component ?? parsed.service ?? parsed.stream ?? null, requestId: parsed.requestId ?? parsed.request_id ?? parsed.traceId ?? parsed.trace_id ?? parsed.correlationId ?? requestId(line), message: redactDiagnostic(message).slice(0, 500) });
      continue;
    }
    const stack = /^\s+(?:at\s+.+|File ".+", line \d+|\^+)|^[\w.]+(?:Error|Exception):/.test(line);
    if (stack && entries.length && entries.at(-1).level === 'ERROR' && (entries.at(-1).stack?.length ?? 0) < 20) {
      entries.at(-1).stack ??= [];
      entries.at(-1).stack.push(redactDiagnostic(line).slice(0, 500));
      entries.at(-1).requestId ??= requestId(line);
      continue;
    }
    if (/^Traceback \(most recent call last\):/.test(line)) { entries.push({ format: 'python-traceback', timestamp: null, level: 'ERROR', component: null, requestId: requestId(line), message: line, stack: [] }); continue; }
    const match = line.match(/^(\d{4}-\d\d-\d\d[T ][^\s]+)?\s*(?:\[)?(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)(?:\])?\s*[:|-]?\s*(.*)$/i);
    const nginx = !match && line.match(/^(\S+) \S+ \S+ \[([^\]]+)\] "([A-Z]+ [^\"]+)" (\d{3}) /);
    const pytest = !match && line.match(/^(FAILED|ERROR|PASSED)\s+([^\s]+)(?:\s+-\s+(.+))?$/);
    const level = nginx ? (Number(nginx[4]) >= 500 ? 'ERROR' : Number(nginx[4]) >= 400 ? 'WARN' : 'INFO') : pytest ? (pytest[1] === 'PASSED' ? 'INFO' : 'ERROR') : match ? match[2].toUpperCase() : /(?:Error|Exception):/.test(line) ? 'ERROR' : null;
    entries.push({ format: nginx ? 'access' : pytest ? 'pytest' : match ? 'levelled' : 'plain', timestamp: nginx?.[2] ?? match?.[1] ?? null, level, component: pytest?.[2] ?? null, requestId: requestId(line), status: nginx ? Number(nginx[4]) : undefined, message: redactDiagnostic(pytest?.[3] ?? nginx?.[3] ?? match?.[3] ?? line).slice(0, 500) });
  }
  return entries.slice(-Math.min(limit, 500));
}

export function correlateLogEntries(entries, id) {
  return entries.filter((entry) => entry.requestId === id).slice(0, 200);
}

export function explainDiagnosticError(message) {
  const rules = [
    [/ENOENT|not found/i, ['NOT_FOUND', 'Check the path or executable name and current workspace.']],
    [/EACCES|EPERM|access denied|permission/i, ['PERMISSION_DENIED', 'Check the folder grant and OS permissions.']],
    [/EADDRINUSE|address already in use/i, ['PORT_IN_USE', 'Inspect local listeners and select or free the port.']],
    [/ECONNREFUSED|connection refused/i, ['SERVICE_UNAVAILABLE', 'Check whether the local service is running and listening.']],
    [/ETIMEDOUT|timed out/i, ['TIMEOUT', 'Check service health and retry with a bounded timeout.']],
    [/certificate|self.signed|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i, ['TLS_ERROR', 'Inspect the local certificate and trust chain.']],
  ];
  const matched = rules.find(([pattern]) => pattern.test(message));
  return { errorCode: matched?.[1][0] ?? 'UNKNOWN', message: redactDiagnostic(message).slice(0, 500), possibleRecovery: matched?.[1][1] ?? 'Inspect the source error and relevant local logs.' };
}

export function parseUnifiedDiff(text) {
  const files = [];
  let current = null;
  let hunk = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      current = { path: line.slice(11).split(' b/').at(-1), hunks: [], addedLines: 0, removedLines: 0, binary: false, renamedFrom: null, status: 'modified' };
      files.push(current); hunk = null;
    } else if (!current) continue;
    else if (line.startsWith('rename from ')) { current.renamedFrom = line.slice(12); current.status = 'renamed'; }
    else if (line.startsWith('new file mode ')) current.status = 'added';
    else if (line.startsWith('deleted file mode ')) current.status = 'deleted';
    else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) current.binary = true;
    else if (line.startsWith('@@')) {
      const coordinates = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      hunk = { header: line, oldStart: Number(coordinates?.[1] ?? 0), newStart: Number(coordinates?.[3] ?? 0), addedLines: 0, removedLines: 0, lines: [], truncated: false };
      hunk.oldCursor = hunk.oldStart; hunk.newCursor = hunk.newStart;
      current.hunks.push(hunk);
    } else if (hunk && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      const type = line[0] === '+' ? 'add' : line[0] === '-' ? 'remove' : 'context';
      if (type === 'add') { current.addedLines++; hunk.addedLines++; }
      if (type === 'remove') { current.removedLines++; hunk.removedLines++; }
      if (hunk.lines.length < 80) hunk.lines.push({ type, oldLine: type === 'add' ? null : hunk.oldCursor++, newLine: type === 'remove' ? null : hunk.newCursor++, text: redactDiagnostic(line.slice(1)).slice(0, 300) });
      else { hunk.truncated = true; if (type !== 'add') hunk.oldCursor++; if (type !== 'remove') hunk.newCursor++; }
    }
  }
  for (const file of files) for (const item of file.hunks) { delete item.oldCursor; delete item.newCursor; }
  return { files: files.slice(0, 200), truncated: files.length > 200 };
}

export function generatedFileHint(filePath, head = '') {
  const generic = filePath.replaceAll('\\', '/');
  const normalized = generic.toLowerCase();
  const reasons = [];
  if (/(^|\/)(dist|build|generated|gen|coverage|\.next|\.vite|__pycache__|node_modules)(\/|$)/.test(normalized)) reasons.push('generated directory');
  if (/\.(min\.(js|css)|map|lock|pyc|class|o|obj|dll|exe)$/.test(normalized)) reasons.push('generated extension');
  if (/(@generated|auto[- ]generated|do not edit|generated by)/i.test(head.slice(0, 2000))) reasons.push('generated file header');
  const possibleSources = [];
  const mapping = generic.match(/^(.*)\/(?:dist|build)\/(.*)$/i);
  if (mapping) possibleSources.push(path.join(mapping[1], 'src', mapping[2].replace(/\.min(?=\.)/, '')));
  const sourceMap = head.match(/sourceMappingURL=([^\s*]+)/);
  if (sourceMap) possibleSources.push(path.resolve(path.dirname(filePath), sourceMap[1]));
  return { likelyGenerated: reasons.length > 0, reasons, possibleSources: [...new Set(possibleSources)].slice(0, 5), confidence: reasons.length > 1 ? 'high' : reasons.length ? 'medium' : 'low' };
}

export function fingerprint(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
