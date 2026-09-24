import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { minimatch } from "minimatch";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidGrantError, InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.join(here, "web");
const ACCESS_CONFIG_FILE = path.join(here, "access-config.json");
const AUDIT_LOG_FILE = path.join(here, "agent-audit.jsonl");
const MAX_SEARCH_FILE_SIZE = 1024 * 1024;

async function loadEnv() {
  const envFile = path.join(here, ".env");
  const contents = await fsp.readFile(envFile, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

await loadEnv();

const PORT = Number(process.env.PORT || "24024");
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || "24025");
const ROOT_INPUT = process.env.ALLOWED_ROOT || "C:\\Coding";
const LOGIN_PASSWORD = process.env.OAUTH_LOGIN_PASSWORD;
const NO_AUTH = process.argv.includes("--no-auth") || process.env.NO_AUTH === "1";
const publicUrlArg = process.argv.find((arg) => arg.startsWith("--public-url="));
const PUBLIC_ORIGIN = new URL(
  publicUrlArg?.slice("--public-url=".length) || process.env.PUBLIC_URL || `http://localhost:${PORT}`,
);
PUBLIC_ORIGIN.pathname = "/";
PUBLIC_ORIGIN.search = "";
PUBLIC_ORIGIN.hash = "";
const ISSUER_URL = new URL(PUBLIC_ORIGIN.href);
const MCP_URL = new URL("/mcp", PUBLIC_ORIGIN);
const RESOURCE_METADATA_URL = new URL("/.well-known/oauth-protected-resource", PUBLIC_ORIGIN);
const SCOPES = ["files:read", "files:write"];

if (!NO_AUTH && (!LOGIN_PASSWORD || LOGIN_PASSWORD.length < 20)) {
  throw new Error("OAUTH_LOGIN_PASSWORD is missing or too short in .env");
}
if (PUBLIC_ORIGIN.protocol !== "https:" && PUBLIC_ORIGIN.hostname !== "localhost" && PUBLIC_ORIGIN.hostname !== "127.0.0.1") {
  throw new Error("PUBLIC_URL must use HTTPS (except localhost tests)");
}

async function validateRoot(input) {
  const root = await fsp.realpath(path.resolve(String(input)));
  if (!(await fsp.stat(root)).isDirectory()) throw new Error(`Allowed root is not a directory: ${root}`);
  if (path.parse(root).root.toLowerCase() === root.toLowerCase()) throw new Error("Refusing to expose a drive root");
  return root;
}

let accessSettings = { allowedRoots: [await validateRoot(ROOT_INPUT)], terminalMode: "off" };
try {
  const stored = JSON.parse(await fsp.readFile(ACCESS_CONFIG_FILE, "utf8"));
  const roots = [];
  for (const candidate of Array.isArray(stored.allowedRoots) ? stored.allowedRoots : []) {
    try { roots.push(await validateRoot(candidate)); } catch {}
  }
  if (roots.length) accessSettings.allowedRoots = [...new Set(roots.map((root) => root.toLowerCase()))].map((lower) => roots.find((root) => root.toLowerCase() === lower));
  accessSettings.terminalMode = ["off", "safe", "full"].includes(stored.terminalMode)
    ? stored.terminalMode
    : stored.terminalEnabled === true ? "full" : "off";
} catch (error) {
  if (error?.code !== "ENOENT") console.warn("Ignoring invalid access-config.json:", error.message);
}

async function saveAccessSettings() {
  const temporary = `${ACCESS_CONFIG_FILE}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(accessSettings, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, ACCESS_CONFIG_FILE);
}

function terminalEnabled() {
  return accessSettings.terminalMode !== "off";
}

async function writeAudit(action, details = {}) {
  const entry = { at: new Date().toISOString(), action, ...details };
  try { await fsp.appendFile(AUDIT_LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 }); } catch {}
}

function matchingRoot(candidate) {
  return accessSettings.allowedRoots
    .filter((root) => {
      const relative = path.relative(root, candidate);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    })
    .sort((a, b) => b.length - a.length)[0] || null;
}

function insideRoot(candidate) {
  return Boolean(matchingRoot(candidate));
}

async function confinedPath(input, { allowMissing = false } = {}) {
  if (typeof input !== "string" || input.includes("\0")) throw new Error("Invalid path");
  const absolute = path.resolve(path.isAbsolute(input) ? input : path.join(accessSettings.allowedRoots[0], input));
  if (!insideRoot(absolute)) throw new Error("Path is outside the allowed root");
  try {
    const real = await fsp.realpath(absolute);
    if (!insideRoot(real)) throw new Error("Path resolves outside the allowed root");
    return real;
  } catch (error) {
    if (!allowMissing || error?.code !== "ENOENT") throw error;
    let existing = path.dirname(absolute);
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error("No valid parent directory");
      existing = parent;
    }
    const realParent = await fsp.realpath(existing);
    if (!insideRoot(realParent)) throw new Error("Parent resolves outside the allowed root");
    return absolute;
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function safeEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

class PersistentClientsStore {
  constructor(filename) {
    this.filename = filename;
    this.clients = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
      for (const client of saved) this.clients.set(client.client_id, client);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async getClient(clientId) {
    return this.clients.get(clientId);
  }

  async registerClient(client) {
    this.clients.set(client.client_id, client);
    const temp = `${this.filename}.tmp`;
    await fsp.writeFile(temp, JSON.stringify([...this.clients.values()], null, 2), { mode: 0o600 });
    await fsp.rename(temp, this.filename);
    return client;
  }
}

class LocalOAuthProvider {
  constructor() {
    this.clientsStore = new PersistentClientsStore(path.join(here, ".oauth-clients.json"));
    this.pending = new Map();
    this.codes = new Map();
    this.accessTokens = new Map();
    this.refreshTokens = new Map();
  }

  async authorize(client, params, res) {
    if (!params.resource || params.resource.href !== MCP_URL.href) {
      throw new InvalidRequestError(`The resource must be ${MCP_URL.href}`);
    }
    const pendingId = randomToken();
    this.pending.set(pendingId, { client, params, expiresAt: Date.now() + 10 * 60_000, attempts: 0 });
    const clientName = escapeHtml(client.client_name || client.client_id);
    const redirectHost = escapeHtml(new URL(params.redirectUri).host);
    res.status(200).type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Local Files</title><style>
body{font-family:system-ui,sans-serif;background:#f4f4f5;margin:0;display:grid;place-items:center;min-height:100vh;color:#18181b}.card{background:white;max-width:480px;padding:28px;border-radius:16px;box-shadow:0 8px 30px #0002}h1{margin-top:0}code{background:#f4f4f5;padding:2px 5px;border-radius:4px}input{box-sizing:border-box;width:100%;padding:12px;margin:8px 0 16px;border:1px solid #a1a1aa;border-radius:8px}.buttons{display:flex;gap:10px}button{padding:11px 18px;border:0;border-radius:8px;cursor:pointer}.allow{background:#18181b;color:white}.deny{background:#e4e4e7}</style></head>
<body><main class="card"><h1>Authorize Local Files</h1><p><strong>${clientName}</strong> is requesting read and write access to <code>C:\\Coding</code>.</p><p>After approval it can read, create, edit, move, and delete files anywhere under that folder.</p>
<form method="post" action="/approve"><input type="hidden" name="pending" value="${pendingId}"><label for="password">Local authorization password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><div class="buttons"><button class="allow" name="decision" value="allow">Allow</button><button class="deny" name="decision" value="deny">Deny</button></div></form><p><small>OAuth callback: ${redirectHost}</small></p></main></body></html>`);
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    const item = this.codes.get(authorizationCode);
    if (!item || item.expiresAt < Date.now() || item.client.client_id !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return item.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
    const item = this.codes.get(authorizationCode);
    if (!item || item.expiresAt < Date.now() || item.client.client_id !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (redirectUri && redirectUri !== item.params.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    const requestedResource = resource?.href || item.params.resource?.href;
    if (requestedResource !== MCP_URL.href) throw new InvalidGrantError("resource mismatch");
    this.codes.delete(authorizationCode);
    return this.issueTokens(client.client_id, item.params.scopes?.length ? item.params.scopes : SCOPES, MCP_URL);
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const item = this.refreshTokens.get(refreshToken);
    if (!item || item.expiresAt < Date.now() || item.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    if (resource && resource.href !== MCP_URL.href) throw new InvalidGrantError("resource mismatch");
    const grantedScopes = scopes || item.scopes;
    if (grantedScopes.some((scope) => !item.scopes.includes(scope))) throw new InvalidGrantError("Invalid scope");
    this.refreshTokens.delete(refreshToken);
    return this.issueTokens(client.client_id, grantedScopes, MCP_URL);
  }

  issueTokens(clientId, scopes, resource) {
    const allowedScopes = scopes.filter((scope) => SCOPES.includes(scope));
    if (!SCOPES.every((scope) => allowedScopes.includes(scope))) throw new InvalidGrantError("Required scopes were not granted");
    const accessToken = randomToken();
    const refreshToken = randomToken();
    this.accessTokens.set(accessToken, { clientId, scopes: allowedScopes, resource, expiresAt: Date.now() + 60 * 60_000 });
    this.refreshTokens.set(refreshToken, { clientId, scopes: allowedScopes, resource, expiresAt: Date.now() + 30 * 24 * 60 * 60_000 });
    return { access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken, scope: allowedScopes.join(" ") };
  }

  async verifyAccessToken(token) {
    const item = this.accessTokens.get(token);
    if (!item || item.expiresAt < Date.now() || item.resource.href !== MCP_URL.href) throw new Error("Invalid or expired access token");
    return { token, clientId: item.clientId, scopes: item.scopes, expiresAt: Math.floor(item.expiresAt / 1000), resource: item.resource };
  }

  async revokeToken(client, request) {
    const access = this.accessTokens.get(request.token);
    if (access?.clientId === client.client_id) this.accessTokens.delete(request.token);
    const refresh = this.refreshTokens.get(request.token);
    if (refresh?.clientId === client.client_id) this.refreshTokens.delete(request.token);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function oauthMeta() {
  return NO_AUTH
    ? { securitySchemes: [{ type: "noauth" }] }
    : { securitySchemes: [{ type: "oauth2", scopes: SCOPES }] };
}

function textResult(text) {
  return { content: [{ type: "text", text }], structuredContent: { content: text } };
}

const TOOL_CATALOG = [
  ["list_allowed_directories", "Inspect every permitted filesystem root", "Read"],
  ["inspect_workspace", "Identify project files, runtimes, and Git state", "Read"],
  ["list_directory", "Browse files and folders in one directory", "Read"],
  ["directory_tree", "Build a recursive directory map", "Read"],
  ["read_text_file", "Read a UTF-8 text file up to 5 MiB", "Read"],
  ["read_multiple_files", "Read up to 50 text files in one request", "Read"],
  ["search_files", "Find paths using glob patterns", "Read"],
  ["search_text", "Search source text with line numbers", "Read"],
  ["get_file_info", "Inspect timestamps, size, and type", "Read"],
  ["get_git_status", "Read Git branch and working-tree status", "Read"],
  ["get_git_diff", "Read a bounded Git diff before or after edits", "Read"],
  ["write_file", "Create or overwrite a text file", "Write"],
  ["create_directory", "Create a directory and missing parents", "Write"],
  ["move_file", "Move or rename a file or directory", "Write"],
  ["delete_file", "Delete one file; directories are protected", "Delete"],
  ["run_project_task", "Run a bounded project test, build, or Git inspection task", "Execute"],
  ["run_terminal_command", "Run a PowerShell command when terminal access is enabled", "Execute"],
].map(([name, description, access]) => ({ name, description, access }));

async function tunnelState() {
  try {
    const response = await fetch("http://127.0.0.1:24124/readyz", { signal: AbortSignal.timeout(1200) });
    return response.ok && (await response.text()).trim().replaceAll('"', '') === "ready" ? "ready" : "degraded";
  } catch {
    return "offline";
  }
}

function redactLogs(value) {
  return value
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-[REDACTED]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,"']+/gi, "$1[REDACTED]");
}

function terminalEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(key|token|secret|password|credential|authorization)/i.test(key)));
}

async function runProcess(program, args, cwd, timeoutSeconds = 30) {
  const workingDirectory = await confinedPath(cwd || accessSettings.allowedRoots[0]);
  if (!(await fsp.stat(workingDirectory)).isDirectory()) throw new Error("Working directory must be a folder");
  const timeout = Math.min(Math.max(Number(timeoutSeconds) || 30, 1), 120) * 1000;
  return await new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: workingDirectory, env: terminalEnvironment(), windowsHide: true, shell: false });
    let stdout = "", stderr = "", total = 0, settled = false, timer;
    const limit = 512 * 1024;
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value); };
    const collect = (target) => (chunk) => {
      const text = chunk.toString("utf8"); total += Buffer.byteLength(text);
      if (target === "stdout") stdout += text; else stderr += text;
      if (total > limit) { child.kill(); finish(reject, new Error("Command output exceeded 512 KiB and the command was stopped")); }
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => finish(resolve, { program, args, cwd: workingDirectory, exitCode: code, stdout, stderr }));
    timer = setTimeout(() => { child.kill(); finish(reject, new Error(`Command timed out after ${timeout / 1000} seconds`)); }, timeout);
  });
}

async function runTerminalCommand(command, cwd, timeoutSeconds = 30) {
  if (accessSettings.terminalMode !== "full") throw new Error("Full terminal access is disabled. Enable Full mode from the local dashboard first.");
  if (typeof command !== "string" || !command.trim()) throw new Error("A command is required");
  const result = await runProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], cwd, timeoutSeconds);
  await writeAudit("terminal.full", { cwd: result.cwd, commandSha256: crypto.createHash("sha256").update(command).digest("hex"), exitCode: result.exitCode });
  return { ...result, command };
}

async function runProjectTask(task, cwd, script, timeoutSeconds = 120) {
  if (!terminalEnabled()) throw new Error("Project commands are disabled. Enable Guarded or Full terminal mode from the local dashboard.");
  const safeScript = typeof script === "string" && /^[A-Za-z0-9:_-]+$/.test(script) ? script : null;
  const tasks = {
    "git-status": ["git.exe", ["status", "--short", "--branch"]],
    "git-diff": ["git.exe", ["--no-pager", "diff", "--stat"]],
    "npm-test": ["npm.cmd", ["test"]],
    "npm-run": safeScript ? ["npm.cmd", ["run", safeScript]] : null,
    "node-test": ["node.exe", ["--test"]],
    "python-pytest": ["python.exe", ["-m", "pytest"]],
    "python-unittest": ["python.exe", ["-m", "unittest", "discover"]],
    "dotnet-test": ["dotnet.exe", ["test", "--no-restore"]],
  };
  const selected = tasks[task];
  if (!selected) throw new Error("Unsupported project task. Use one of the documented task identifiers.");
  const result = await runProcess(selected[0], selected[1], cwd, timeoutSeconds);
  await writeAudit("terminal.guarded", { task, cwd: result.cwd, exitCode: result.exitCode });
  return result;
}

async function walk(directory, options = {}) {
  const { maxEntries = 5000, excludePatterns = [] } = options;
  const results = [];
  async function visit(current) {
    if (results.length >= maxEntries) return;
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxEntries) return;
      const full = path.join(current, entry.name);
      const relative = path.relative(directory, full).replaceAll("\\", "/");
      if (excludePatterns.some((pattern) => minimatch(relative, pattern, { dot: true }))) continue;
      results.push({ full, relative, isDirectory: entry.isDirectory() });
      if (entry.isDirectory()) await visit(await confinedPath(full));
    }
  }
  await visit(directory);
  return results;
}

async function inspectWorkspace(directory) {
  const target = await confinedPath(directory);
  if (!(await fsp.stat(target)).isDirectory()) throw new Error("Workspace path must be a folder");
  const markerNames = ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "README.md", ".git"];
  const present = [];
  for (const name of markerNames) {
    try { await fsp.access(path.join(target, name)); present.push(name); } catch {}
  }
  try {
    if ((await fsp.readdir(target)).some((name) => name.toLowerCase().endsWith(".sln"))) present.push("*.sln");
  } catch {}
  let packageInfo = null;
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(target, "package.json"), "utf8"));
    packageInfo = { name: pkg.name || null, version: pkg.version || null, scripts: Object.keys(pkg.scripts || {}).sort() };
  } catch {}
  let git = null;
  try {
    const result = await runProcess("git.exe", ["status", "--short", "--branch"], target, 20);
    git = { available: true, status: result.stdout.trim(), exitCode: result.exitCode };
  } catch { git = { available: false }; }
  return { workspace: target, markers: present, package: packageInfo, git };
}

async function searchText(directory, query, options = {}) {
  if (typeof query !== "string" || !query.trim()) throw new Error("Search text is required");
  if (query.length > 500) throw new Error("Search text must be 500 characters or fewer");
  const target = await confinedPath(directory);
  const maxResults = Math.min(Math.max(Number(options.maxResults) || 100, 1), 300);
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const items = await walk(target, { maxEntries: 3000, excludePatterns: options.excludePatterns || ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"] });
  const matches = [];
  for (const item of items) {
    if (matches.length >= maxResults || item.isDirectory) continue;
    try {
      const stat = await fsp.stat(item.full);
      if (stat.size > MAX_SEARCH_FILE_SIZE) continue;
      const raw = await fsp.readFile(item.full);
      if (raw.includes(0)) continue;
      const lines = raw.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
        const comparable = options.caseSensitive ? lines[index] : lines[index].toLowerCase();
        if (comparable.includes(needle)) matches.push({ path: item.relative, line: index + 1, text: lines[index].slice(0, 500) });
      }
    } catch {}
  }
  return { query, workspace: target, matches, truncated: matches.length >= maxResults };
}

function createFilesystemServer() {
  const server = new McpServer({ name: "local-coding-files", version: "2.2.0" });
  const common = { _meta: oauthMeta() };

  server.registerTool("list_allowed_directories", { description: "Show all filesystem roots available to this server.", inputSchema: {}, annotations: { readOnlyHint: true }, ...common }, async () => textResult(accessSettings.allowedRoots.join("\n")));

  server.registerTool("inspect_workspace", { description: "Inspect a selected project folder before editing. Returns recognized project markers, package scripts, and a read-only Git status summary.", inputSchema: { path: z.string() }, annotations: { readOnlyHint: true }, ...common }, async ({ path: input }) => {
    return textResult(JSON.stringify(await inspectWorkspace(input), null, 2));
  });

  server.registerTool("list_directory", { description: "List files and directories directly inside a directory under C:\\Coding.", inputSchema: { path: z.string() }, annotations: { readOnlyHint: true }, ...common }, async ({ path: input }) => {
    const target = await confinedPath(input);
    const entries = await fsp.readdir(target, { withFileTypes: true });
    return textResult(entries.map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`).join("\n"));
  });

  server.registerTool("directory_tree", { description: "Return a recursive JSON tree under C:\\Coding (limited to 5,000 entries).", inputSchema: { path: z.string(), excludePatterns: z.array(z.string()).optional().default([]) }, annotations: { readOnlyHint: true }, ...common }, async ({ path: input, excludePatterns }) => {
    const target = await confinedPath(input);
    const items = await walk(target, { excludePatterns });
    return textResult(JSON.stringify(items.map((item) => ({ path: item.relative, type: item.isDirectory ? "directory" : "file" })), null, 2));
  });

  server.registerTool("read_text_file", { description: "Read a UTF-8 text file under C:\\Coding (maximum 5 MiB).", inputSchema: { path: z.string(), head: z.number().int().positive().optional(), tail: z.number().int().positive().optional() }, annotations: { readOnlyHint: true }, ...common }, async ({ path: input, head, tail }) => {
    if (head && tail) throw new Error("Use either head or tail, not both");
    const target = await confinedPath(input);
    const stat = await fsp.stat(target);
    if (stat.size > 5 * 1024 * 1024) throw new Error("File exceeds the 5 MiB read limit");
    let content = await fsp.readFile(target, "utf8");
    const lines = content.split(/\r?\n/);
    if (head) content = lines.slice(0, head).join("\n");
    if (tail) content = lines.slice(-tail).join("\n");
    return textResult(content);
  });

  server.registerTool("read_multiple_files", { description: "Read several UTF-8 text files under C:\\Coding.", inputSchema: { paths: z.array(z.string()).min(1).max(50) }, annotations: { readOnlyHint: true }, ...common }, async ({ paths }) => {
    const parts = [];
    for (const input of paths) {
      try {
        const target = await confinedPath(input);
        const stat = await fsp.stat(target);
        if (stat.size > 5 * 1024 * 1024) throw new Error("File exceeds the 5 MiB read limit");
        parts.push(`${input}:\n${await fsp.readFile(target, "utf8")}`);
      } catch (error) {
        parts.push(`${input}: ERROR: ${error.message}`);
      }
    }
    return textResult(parts.join("\n\n---\n\n"));
  });

  server.registerTool("search_files", { description: "Search file and directory paths under C:\\Coding with a glob pattern.", inputSchema: { path: z.string(), pattern: z.string(), excludePatterns: z.array(z.string()).optional().default([]) }, annotations: { readOnlyHint: true }, ...common }, async ({ path: input, pattern, excludePatterns }) => {
    const target = await confinedPath(input);
    const items = await walk(target, { excludePatterns });
    return textResult(items.filter((item) => minimatch(item.relative, pattern, { dot: true, nocase: true })).map((item) => item.full).join("\n") || "No matches found");
  });

  server.registerTool("search_text", { description: "Search text content in a project folder and return bounded matching lines with file paths and line numbers. Skips binaries, large files, and common generated folders by default.", inputSchema: { path: z.string(), query: z.string().min(1).max(500), caseSensitive: z.boolean().optional().default(false), excludePatterns: z.array(z.string()).optional().default(["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"]), maxResults: z.number().int().min(1).max(300).optional().default(100) }, annotations: { readOnlyHint: true }, ...common }, async ({ path: input, query, caseSensitive, excludePatterns, maxResults }) => {
    return textResult(JSON.stringify(await searchText(input, query, { caseSensitive, excludePatterns, maxResults }), null, 2));
  });

  server.registerTool("get_file_info", { description: "Get metadata for a file or directory under C:\\Coding.", inputSchema: { path: z.string() }, annotations: { readOnlyHint: true }, ...common }, async ({ path: input }) => {
    const target = await confinedPath(input);
    const stat = await fsp.stat(target);
    return textResult(JSON.stringify({ path: target, type: stat.isDirectory() ? "directory" : "file", size: stat.size, created: stat.birthtime.toISOString(), modified: stat.mtime.toISOString() }, null, 2));
  });

  server.registerTool("get_git_status", { description: "Read the current Git branch and working-tree status in an allowed project folder. Does not modify Git state.", inputSchema: { path: z.string() }, annotations: { readOnlyHint: true }, ...common }, async ({ path: input }) => {
    const result = await runProcess("git.exe", ["status", "--short", "--branch"], input, 30);
    return textResult(JSON.stringify(result, null, 2));
  });

  server.registerTool("get_git_diff", { description: "Read a bounded Git diff for an allowed project folder. Use before/after edits to verify changes. Does not modify Git state.", inputSchema: { path: z.string(), staged: z.boolean().optional().default(false), file: z.string().optional() }, annotations: { readOnlyHint: true }, ...common }, async ({ path: input, staged, file }) => {
    const target = await confinedPath(input);
    if (!(await fsp.stat(target)).isDirectory()) throw new Error("Git path must be a folder");
    let args = ["--no-pager", "diff", "--no-ext-diff", "--stat"];
    if (staged) args.push("--cached");
    if (file) {
      const requestedFile = await confinedPath(path.isAbsolute(file) ? file : path.join(target, file));
      const relativeFile = path.relative(target, requestedFile);
      if (relativeFile.startsWith("..") || path.isAbsolute(relativeFile)) throw new Error("The requested diff file is outside the project folder");
      args = ["--no-pager", "diff", "--no-ext-diff"];
      if (staged) args.push("--cached");
      args.push("--", relativeFile);
    }
    const result = await runProcess("git.exe", args, target, 30);
    const bounded = `${result.stdout}${result.stderr}`.slice(0, 256 * 1024);
    return textResult(JSON.stringify({ ...result, stdout: bounded, stderr: "", truncated: bounded.length < result.stdout.length + result.stderr.length }, null, 2));
  });

  server.registerTool("write_file", { description: "Create or overwrite a UTF-8 text file under C:\\Coding.", inputSchema: { path: z.string(), content: z.string() }, annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true }, ...common }, async ({ path: input, content }) => {
    const target = await confinedPath(input, { allowMissing: true });
    await fsp.writeFile(target, content, "utf8");
    return textResult(`Wrote ${target}`);
  });

  server.registerTool("create_directory", { description: "Create a directory (including parents) under C:\\Coding.", inputSchema: { path: z.string() }, annotations: { readOnlyHint: false, idempotentHint: true }, ...common }, async ({ path: input }) => {
    const target = await confinedPath(input, { allowMissing: true });
    await fsp.mkdir(target, { recursive: true });
    return textResult(`Created ${target}`);
  });

  server.registerTool("move_file", { description: "Move or rename a file or directory within C:\\Coding.", inputSchema: { source: z.string(), destination: z.string() }, annotations: { readOnlyHint: false, idempotentHint: false }, ...common }, async ({ source, destination }) => {
    const from = await confinedPath(source);
    const to = await confinedPath(destination, { allowMissing: true });
    await fsp.rename(from, to);
    return textResult(`Moved ${from} to ${to}`);
  });

  server.registerTool("delete_file", { description: "Delete one file under C:\\Coding. Directories cannot be deleted.", inputSchema: { path: z.string() }, annotations: { readOnlyHint: false, destructiveHint: true }, ...common }, async ({ path: input }) => {
    const target = await confinedPath(input);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error("Only files can be deleted");
    await fsp.unlink(target);
    return textResult(`Deleted ${target}`);
  });

  server.registerTool("run_project_task", {
    description: "Run a bounded coding workflow inside an allowed project: Git inspection, tests, or an npm script. Available in Guarded or Full terminal mode. It never accepts shell syntax or arbitrary commands.",
    inputSchema: { task: z.enum(["git-status", "git-diff", "npm-test", "npm-run", "node-test", "python-pytest", "python-unittest", "dotnet-test"]), cwd: z.string(), script: z.string().regex(/^[A-Za-z0-9:_-]+$/).optional(), timeoutSeconds: z.number().int().min(1).max(120).optional().default(120) },
    annotations: { readOnlyHint: false, destructiveHint: false },
    ...common,
  }, async ({ task, cwd, script, timeoutSeconds }) => {
    if (task === "npm-run" && !script) throw new Error("npm-run requires a package script name");
    return textResult(JSON.stringify(await runProjectTask(task, cwd, script, timeoutSeconds), null, 2));
  });

  server.registerTool("run_terminal_command", {
    description: "Run an arbitrary PowerShell command on the user's Windows PC. This works only when the owner explicitly enables Full terminal mode in the local dashboard. The starting directory must be inside an allowed folder, but Full mode can access other resources with the user's Windows permissions.",
    inputSchema: { command: z.string().min(1), cwd: z.string().optional(), timeoutSeconds: z.number().int().min(1).max(120).optional().default(30) },
    annotations: { readOnlyHint: false, destructiveHint: true },
    ...common,
  }, async ({ command, cwd, timeoutSeconds }) => {
    const result = await runTerminalCommand(command, cwd, timeoutSeconds);
    return textResult(JSON.stringify(result, null, 2));
  });

  return server;
}

const provider = NO_AUTH ? null : new LocalOAuthProvider();
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.get("/", (_req, res) => res.json({ name: "Local Files MCP", endpoint: "/mcp", dashboard: `http://127.0.0.1:${DASHBOARD_PORT}/dashboard/` }));
if (NO_AUTH) {
  const anonymousResourceMetadata = (_req, res) => res.json({
    resource: MCP_URL.href,
    authorization_servers: [],
    scopes_supported: [],
    resource_name: "Local Coding Files (Secure Tunnel)",
  });
  app.get("/.well-known/oauth-protected-resource", anonymousResourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", anonymousResourceMetadata);
  app.get("/mcp/.well-known/oauth-protected-resource", anonymousResourceMetadata);
}

const dashboardApp = express();
dashboardApp.disable("x-powered-by");
dashboardApp.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
  next();
});
dashboardApp.use(express.json({ limit: "64kb" }));
dashboardApp.get("/", (_req, res) => res.redirect("/dashboard/"));
dashboardApp.use("/dashboard", express.static(DASHBOARD_DIR, { index: "index.html", dotfiles: "deny", fallthrough: true }));

dashboardApp.get("/dashboard/api/status", async (_req, res) => {
  const profilePath = path.join(here, "tunnel-client-data", "profiles", "local-files.yaml");
  let tunnelId = "Not configured";
  try {
    const profile = await fsp.readFile(profilePath, "utf8");
    tunnelId = profile.match(/tunnel_id:\s*["']?([^"'\r\n]+)/)?.[1]?.trim() || tunnelId;
  } catch {}
  res.json({
    server: "online",
    tunnel: await tunnelState(),
    root: accessSettings.allowedRoots[0],
    roots: accessSettings.allowedRoots,
    terminalEnabled: terminalEnabled(),
    terminalMode: accessSettings.terminalMode,
    port: PORT,
    dashboardPort: DASHBOARD_PORT,
    authentication: NO_AUTH ? "Secure MCP Tunnel" : "OAuth 2.1",
    tunnelId,
    uptimeSeconds: Math.floor(process.uptime()),
    toolCount: TOOL_CATALOG.length,
    version: "2.2.0",
  });
});

dashboardApp.get("/dashboard/api/directory", async (req, res) => {
  try {
    const requested = typeof req.query.path === "string" ? req.query.path : accessSettings.allowedRoots[0];
    const target = await confinedPath(requested);
    const root = matchingRoot(target);
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) return res.status(400).json({ error: "The requested path is not a directory" });
    const entries = await fsp.readdir(target, { withFileTypes: true });
    const items = await Promise.all(entries.slice(0, 500).map(async (entry) => {
      const full = await confinedPath(path.join(target, entry.name));
      const details = await fsp.stat(full);
      return {
        name: entry.name,
        path: full,
        type: entry.isDirectory() ? "directory" : "file",
        size: details.size,
        modified: details.mtime.toISOString(),
      };
    }));
    items.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1);
    res.json({ path: path.relative(root, target).replaceAll("\\", "/") || ".", absolutePath: target, root, roots: accessSettings.allowedRoots, items, truncated: entries.length > 500 });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

dashboardApp.get("/dashboard/api/file", async (req, res) => {
  try {
    if (typeof req.query.path !== "string") throw new Error("A file path is required");
    const target = await confinedPath(req.query.path);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error("The requested path is not a file");
    if (stat.size > 1024 * 1024) throw new Error("Preview is limited to 1 MiB");
    const buffer = await fsp.readFile(target);
    if (buffer.includes(0)) throw new Error("Binary files cannot be previewed");
    res.json({ path: target, size: stat.size, content: buffer.toString("utf8") });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

dashboardApp.get("/dashboard/api/tools", (_req, res) => res.json({ tools: TOOL_CATALOG, terminalEnabled: terminalEnabled(), terminalMode: accessSettings.terminalMode }));

dashboardApp.get("/dashboard/api/logs", async (req, res) => {
  const source = req.query.source === "server" ? "server" : "tunnel";
  const filename = path.join(here, "tunnel-client-data", source === "server" ? "server.log" : "tunnel.log");
  try {
    const raw = await fsp.readFile(filename, "utf8");
    res.json({ source, lines: redactLogs(raw).split(/\r?\n/).filter(Boolean).slice(-250) });
  } catch (error) {
    if (error?.code === "ENOENT") return res.json({ source, lines: [] });
    res.status(500).json({ error: "Could not read the local log" });
  }
});

dashboardApp.get("/dashboard/api/folder-picker", async (req, res) => {
  try {
    if (typeof req.query.path !== "string" || !req.query.path.trim()) {
      const driveChecks = await Promise.all("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map(async (letter) => {
        const drive = `${letter}:\\`;
        try { return (await fsp.stat(drive)).isDirectory() ? drive : null; } catch { return null; }
      }));
      return res.json({ path: null, parent: null, directories: driveChecks.filter(Boolean).map((drive) => ({ name: drive, path: drive, kind: "drive" })) });
    }
    const target = await fsp.realpath(path.resolve(req.query.path));
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) throw new Error("The selected path is not a folder");
    const entries = await fsp.readdir(target, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .slice(0, 500)
      .map((entry) => ({ name: entry.name, path: path.join(target, entry.name), kind: "folder" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const driveRoot = path.parse(target).root;
    res.json({ path: target, parent: target.toLowerCase() === driveRoot.toLowerCase() ? null : path.dirname(target), directories, truncated: entries.filter((entry) => entry.isDirectory()).length > 500 });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

dashboardApp.post("/dashboard/api/roots", async (req, res) => {
  try {
    const root = await validateRoot(req.body?.path);
    if (!accessSettings.allowedRoots.some((item) => item.toLowerCase() === root.toLowerCase())) {
      accessSettings.allowedRoots.push(root);
      await saveAccessSettings();
    }
    res.json({ roots: accessSettings.allowedRoots });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

dashboardApp.delete("/dashboard/api/roots", async (req, res) => {
  try {
    if (accessSettings.allowedRoots.length === 1) throw new Error("At least one allowed folder is required");
    const target = await validateRoot(req.body?.path);
    const next = accessSettings.allowedRoots.filter((root) => root.toLowerCase() !== target.toLowerCase());
    if (next.length === accessSettings.allowedRoots.length) throw new Error("That folder is not currently allowed");
    accessSettings.allowedRoots = next;
    await saveAccessSettings();
    res.json({ roots: accessSettings.allowedRoots });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

dashboardApp.post("/dashboard/api/terminal/settings", async (req, res) => {
  const mode = req.body?.mode;
  if (!["off", "safe", "full"].includes(mode)) return res.status(400).json({ error: "mode must be off, safe, or full" });
  accessSettings.terminalMode = mode;
  await saveAccessSettings();
  await writeAudit("terminal.mode", { mode });
  res.json({ enabled: terminalEnabled(), mode });
});

dashboardApp.post("/dashboard/api/terminal/run", async (req, res) => {
  try {
    const result = await runTerminalCommand(req.body?.command, req.body?.cwd, req.body?.timeoutSeconds);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

dashboardApp.post("/dashboard/api/project-task", async (req, res) => {
  try {
    const result = await runProjectTask(req.body?.task, req.body?.cwd, req.body?.script, req.body?.timeoutSeconds);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

if (!NO_AUTH) {
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({ resource: MCP_URL.href, authorization_servers: [ISSUER_URL.href], scopes_supported: SCOPES, resource_name: "Local Coding Files" });
  });

  app.use(express.urlencoded({ extended: false }));
  app.post("/approve", rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
  const item = provider.pending.get(req.body.pending);
  if (!item || item.expiresAt < Date.now()) return res.status(400).type("text").send("Authorization request expired. Start the connection again.");
  if (req.body.decision !== "allow") {
    provider.pending.delete(req.body.pending);
    const target = new URL(item.params.redirectUri);
    target.searchParams.set("error", "access_denied");
    if (item.params.state) target.searchParams.set("state", item.params.state);
    return res.redirect(target.href);
  }
  item.attempts += 1;
  if (!safeEqual(req.body.password || "", LOGIN_PASSWORD)) {
    if (item.attempts >= 5) provider.pending.delete(req.body.pending);
    return res.status(401).type("text").send("Incorrect password. Return to ChatGPT and try connecting again.");
  }
  provider.pending.delete(req.body.pending);
  const code = randomToken();
  provider.codes.set(code, { ...item, expiresAt: Date.now() + 5 * 60_000 });
  const target = new URL(item.params.redirectUri);
  target.searchParams.set("code", code);
  if (item.params.state) target.searchParams.set("state", item.params.state);
  return res.redirect(target.href);
  });

  app.use(mcpAuthRouter({ provider, issuerUrl: ISSUER_URL, resourceServerUrl: MCP_URL, scopesSupported: SCOPES, resourceName: "Local Coding Files", clientRegistrationOptions: { clientSecretExpirySeconds: 0 } }));
}

const protectMcp = NO_AUTH
  ? (_req, _res, next) => next()
  : requireBearerAuth({ verifier: provider, requiredScopes: SCOPES, resourceMetadataUrl: RESOURCE_METADATA_URL.href });
app.post("/mcp", protectMcp, express.json({ limit: "6mb" }), async (req, res) => {
  if (req.body?.method === "server/discover") {
    return res.status(200).json({
      jsonrpc: "2.0",
      id: req.body.id ?? null,
      result: {
        resultType: "complete",
        supportedVersions: ["2025-03-26", "2024-11-05"],
        capabilities: { tools: { listChanged: false } },
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "local-coding-files", version: "2.2.0" } },
        instructions: "Work like a careful coding agent: inspect the workspace and Git state before editing, use search_text to locate code, read diffs after edits, and run bounded project tasks to verify changes. Filesystem tools work only inside configured folders. Guarded terminal mode allows only bounded coding tasks; arbitrary PowerShell requires the owner to explicitly enable Full mode in the local dashboard. Never use destructive file or terminal actions without user confirmation.",
        ttlMs: 60000,
        cacheScope: "private",
      },
    });
  }
  const server = createFilesystemServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error?.message || error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: req.body?.id ?? null });
  }
});
app.get("/mcp", protectMcp, (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
app.delete("/mcp", protectMcp, (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));

const httpServer = app.listen(PORT, "127.0.0.1", () => {
  console.log(`Local Files MCP listening on http://127.0.0.1:${PORT}/mcp`);
  console.log(`Dashboard: http://127.0.0.1:${DASHBOARD_PORT}/dashboard/`);
  console.log(`Public MCP URL: ${MCP_URL.href}`);
  console.log(`Allowed roots: ${accessSettings.allowedRoots.join(", ")}`);
  console.log(`Authentication: ${NO_AUTH ? "Secure MCP Tunnel transport" : "OAuth 2.1"}`);
});

const dashboardServer = dashboardApp.listen(DASHBOARD_PORT, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => dashboardServer.close(() => httpServer.close(() => process.exit(0))));
}
