import { spawn } from 'node:child_process';
import path from 'node:path';
import { redactDiagnostic } from './agent-diagnostics.mjs';

const VERSION_ARGS = { java: ['-version'], go: ['version'], sevenZip: [], gcc: ['--version'], clang: ['--version'] };

function fixedCommand(program, args, timeoutMs = 1800, maxOutput = 1000) {
  return new Promise((resolve) => {
    const child = spawn(program, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ available: false, error: 'TIMEOUT' }), timeoutMs);
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(0, maxOutput); });
    child.stderr.on('data', (chunk) => { output = (output + chunk).slice(0, maxOutput); });
    child.once('error', (error) => finish({ available: false, error: error.code || 'SPAWN_FAILED' }));
    child.once('close', (code) => finish({ available: code === 0, exitCode: code, output: redactDiagnostic(output.trim()).slice(0, maxOutput) || null }));
  });
}

export async function probeToolVersions(tools, { limit = 25 } = {}) {
  const entries = Object.entries(tools).filter(([, item]) => item.selected).slice(0, limit);
  const results = {};
  for (let offset = 0; offset < entries.length; offset += 4) {
    const batch = entries.slice(offset, offset + 4);
    const values = await Promise.all(batch.map(async ([name, item]) => {
      if (/\.(cmd|bat)$/i.test(item.selected)) return [name, { available: true, error: 'SCRIPT_WRAPPER_NOT_PROBED' }];
      const { output, ...probe } = await fixedCommand(item.selected, VERSION_ARGS[name] ?? ['--version']);
      return [name, { ...probe, version: output?.split(/\r?\n/)[0].slice(0, 200) ?? null }];
    }));
    for (const [name, value] of values) results[name] = value;
  }
  return results;
}

export async function inspectPathSources({ platform = process.platform, env = process.env } = {}) {
  const current = String(env.PATH || env.Path || '');
  const separator = platform === 'win32' ? ';' : ':';
  const result = { process: current.split(separator).filter(Boolean).map((entry) => path.resolve(entry)).slice(0, 128) };
  if (platform !== 'win32') return { ...result, user: null, machine: null, sourcesAvailable: ['process'] };
  const script = '$x=@{}; foreach($scope in @("User","Machine")){ $x[$scope]=[Environment]::GetEnvironmentVariable("Path",$scope) }; $x | ConvertTo-Json -Compress';
  const probe = await fixedCommand('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], 2500, 32768);
  if (!probe.available || !probe.output) return { ...result, user: null, machine: null, sourcesAvailable: ['process'], sourceError: probe.error || 'QUERY_FAILED' };
  try {
    const values = JSON.parse(probe.output);
    const split = (value) => String(value || '').split(';').filter(Boolean).slice(0, 128).map((entry) => entry.replace(/%([^%]+)%/g, (_, name) => env[name] ?? `%${name}%`));
    return { ...result, user: split(values.User), machine: split(values.Machine), sourcesAvailable: ['process', 'user', 'machine'] };
  } catch { return { ...result, user: null, machine: null, sourcesAvailable: ['process'], sourceError: 'INVALID_SOURCE_DATA' }; }
}

function unwrap(schema) {
  let current = schema;
  let required = true;
  let defaultValue;
  for (let index = 0; index < 5; index += 1) {
    const kind = current?._def?.typeName;
    if (kind === 'ZodOptional') { required = false; current = current._def.innerType; }
    else if (kind === 'ZodDefault') { required = false; defaultValue = current._def.defaultValue(); current = current._def.innerType; }
    else if (kind === 'ZodNullable') { current = current._def.innerType; }
    else break;
  }
  return { current, required, defaultValue };
}

export function describeZodInput(schema, depth = 0) {
  if (!schema || depth > 4) return { type: 'unknown' };
  const { current, required, defaultValue } = unwrap(schema);
  const kind = current?._def?.typeName;
  const type = ({ ZodString: 'string', ZodNumber: 'number', ZodBoolean: 'boolean', ZodArray: 'array', ZodObject: 'object', ZodEnum: 'enum', ZodLiteral: 'literal', ZodUnion: 'union', ZodDiscriminatedUnion: 'union', ZodRecord: 'record' })[kind] || 'unknown';
  const result = { type, required };
  if (defaultValue !== undefined) result.default = defaultValue;
  if (current?.description) result.description = current.description;
  if (kind === 'ZodEnum') result.values = [...current._def.values];
  if (kind === 'ZodLiteral') result.value = current._def.value;
  if (kind === 'ZodArray') result.items = describeZodInput(current._def.type, depth + 1);
  if (kind === 'ZodObject') result.properties = Object.fromEntries(Object.entries(current.shape).map(([name, child]) => [name, describeZodInput(child, depth + 1)]));
  if (kind === 'ZodUnion') result.options = current._def.options.map((item) => describeZodInput(item, depth + 1));
  if (kind === 'ZodDiscriminatedUnion') result.options = [...current._def.options.values()].map((item) => describeZodInput(item, depth + 1));
  if (kind === 'ZodString' || kind === 'ZodNumber' || kind === 'ZodArray') {
    const checks = current._def.checks || [];
    if (checks.length) result.constraints = checks.map((check) => ({ kind: check.kind, value: check.value ?? null }));
  }
  return result;
}

const ERROR_RULES = [
  [/ENOENT|not found/i, 'NOT_FOUND', 'Check the path or command resolution.'],
  [/SECURITY_MAINTENANCE_REQUIRED/i, 'SECURITY_MAINTENANCE_REQUIRED', 'Call request_security_maintenance to open the ChatGPT approval card; wait for permission_status.maintenance.active before retrying.', 'request_security_maintenance'],
  [/outside the allowed root|outside a write-approved root/i, 'PATH_OUTSIDE_GRANT', 'Call request_path_access for the smallest existing containing directory in ChatGPT, then check permission_request_status.', 'request_path_access'],
  [/Full Headless Terminal is disabled|Full Terminal is disabled|Project commands are disabled|Project jobs are disabled/i, 'TERMINAL_PERMISSION_REQUIRED', 'Call request_terminal_access for the required mode in ChatGPT, then check permission_request_status.', 'request_terminal_access'],
  [/System Control is Off|Full System Control is required|Full (?:macOS|Linux|Windows) System Control is required/i, 'SYSTEM_PERMISSION_REQUIRED', 'Call request_system_control_access for the required mode in ChatGPT, then check permission_request_status.', 'request_system_control_access'],
  [/Permission request is unavailable, expired, or already resolved/i, 'PERMISSION_REQUEST_STALE', 'The approval card is no longer active. Create a fresh permission request and use the new card.'],
  [/EACCES|EPERM|access denied|permission/i, 'PERMISSION_DENIED', 'Check the approved folder grant and operating system ACLs.'],
  [/locked by/i, 'RESOURCE_LOCKED', 'Inspect or release the active path lease.'],
  [/EADDRINUSE|address already in use/i, 'PORT_IN_USE', 'Inspect local listener ownership and choose another port.'],
  [/ECONNREFUSED|connection refused/i, 'SERVICE_UNAVAILABLE', 'Check local service health and the listening port.'],
  [/ETIMEDOUT|timed out|TIMEOUT/i, 'TIMEOUT', 'Check service health and retry with a bounded timeout.'],
  [/certificate|self.signed|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i, 'TLS_ERROR', 'Inspect the local certificate and trust chain.'],
  [/changed since preview|changed outside/i, 'STALE_STATE', 'Preview the operation again against current files.'],
];

export function semanticError(error, operation, resource = null) {
  const raw = String(error?.message || error || 'Unknown error');
  const rule = ERROR_RULES.find(([pattern]) => pattern.test(raw));
  const code = rule?.[1] || (typeof error?.code === 'string' && /^[A-Z0-9_]{2,50}$/.test(error.code) ? error.code : 'UNKNOWN');
  return { error_code: code, message: redactDiagnostic(raw).slice(0, 500), operation, resource: resource == null ? null : redactDiagnostic(String(resource)).slice(0, 300), cause: typeof error?.code === 'string' ? error.code : null, details: { name: error?.name || 'Error' }, possible_recovery: rule?.[2] || 'Inspect the relevant local diagnostics and retry with current state.', ...(rule?.[3] ? { permission_request_tool: rule[3] } : {}) };
}

export function inspectProxyConfig(source, filename = '') {
  const lines = String(source).split(/\r?\n/).slice(0, 5000);
  const routes = [];
  const upstreams = [];
  let currentRoute = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const route = line.match(/^(?:location\s+|handle(?:_path)?\s+)([^\s{]+)/i);
    if (route) { currentRoute = route[1]; routes.push({ path: currentRoute, line: index + 1 }); }
    const target = line.match(/^(?:proxy_pass|reverse_proxy|to:)\s+([^\s;#]+)/i);
    if (target) upstreams.push({ route: currentRoute, target: redactDiagnostic(target[1]).slice(0, 200), line: index + 1 });
  }
  return { filename, routes: routes.slice(0, 100), upstreams: upstreams.slice(0, 100), truncated: lines.length >= 5000 || routes.length > 100 || upstreams.length > 100 };
}
