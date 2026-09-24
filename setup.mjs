import crypto from "node:crypto";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import express from "express";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 24023;
const webDir = path.join(here, "setup-web");
const dataDir = path.join(here, "tunnel-client-data");
const profileDir = path.join(dataDir, "profiles");
const profileFile = path.join(profileDir, "local-files.yaml");
const keyFile = path.join(dataDir, "api-key.dpapi");
const clientFile = path.join(here, "bin", "tunnel-client.exe");
const accessFile = path.join(here, "access-config.json");

function safeMessage(error) {
  return String(error?.message || error || "Unknown error")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[REDACTED]")
    .replace(/gh[opsu]_[A-Za-z0-9_]+/g, "gh_[REDACTED]");
}

async function isDirectory(candidate) {
  try { return (await fsp.stat(candidate)).isDirectory(); } catch { return false; }
}

async function validateFolder(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Choose an existing folder");
  const folder = await fsp.realpath(path.resolve(input.trim()));
  if (!(await isDirectory(folder))) throw new Error(`${folder} is not a folder`);
  if (path.parse(folder).root.toLowerCase() === folder.toLowerCase()) throw new Error("Entire drive roots cannot be shared");
  return folder;
}

async function run(file, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: here, windowsHide: true, shell: false, ...options });
    let stdout = "", stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.trim() || stdout.trim() || `${path.basename(file)} exited with code ${code}`)));
    if (options.input) { child.stdin.write(options.input); child.stdin.end(); }
  });
}

async function downloadFile(url) {
  const response = await fetch(url, { headers: { "User-Agent": "local-files-mcp-setup", Accept: "application/octet-stream" }, redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

async function ensureTunnelClient(onProgress = () => {}) {
  if (fs.existsSync(clientFile)) return { installed: true, downloaded: false };
  onProgress("Finding the latest official tunnel client…");
  const response = await fetch("https://api.github.com/repos/openai/tunnel-client/releases/latest", { headers: { "User-Agent": "local-files-mcp-setup", Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`Could not read the official release (${response.status})`);
  const release = await response.json();
  const architecture = process.arch === "arm64" ? "arm64" : "amd64";
  const assetName = `tunnel-client-${release.tag_name}-windows-${architecture}.zip`;
  const asset = release.assets.find((item) => item.name === assetName);
  const sumsAsset = release.assets.find((item) => item.name === "SHA256SUMS.txt");
  if (!asset || !sumsAsset) throw new Error(`The official release does not contain ${assetName}`);
  onProgress(`Downloading ${assetName}…`);
  const [archive, sums] = await Promise.all([downloadFile(asset.browser_download_url), downloadFile(sumsAsset.browser_download_url)]);
  const expected = sums.toString("utf8").split(/\r?\n/).find((line) => line.trim().endsWith(assetName))?.trim().split(/\s+/)[0]?.toLowerCase();
  const actual = crypto.createHash("sha256").update(archive).digest("hex");
  if (!expected || actual !== expected) throw new Error("The tunnel-client checksum did not match the official release");
  onProgress("Checksum verified. Installing locally…");
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "local-files-mcp-"));
  const zipFile = path.join(tempDir, assetName);
  const extractDir = path.join(tempDir, "extract");
  try {
    await fsp.writeFile(zipFile, archive);
    await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force", zipFile, extractDir]);
    async function findExecutable(folder) {
      for (const entry of await fsp.readdir(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === "tunnel-client.exe") return full;
        if (entry.isDirectory()) { const found = await findExecutable(full); if (found) return found; }
      }
      return null;
    }
    const executable = await findExecutable(extractDir);
    if (!executable) throw new Error("The downloaded archive did not contain tunnel-client.exe");
    await fsp.mkdir(path.dirname(clientFile), { recursive: true });
    await fsp.copyFile(executable, clientFile);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
  return { installed: true, downloaded: true, version: release.tag_name };
}

async function configuredState() {
  let roots = [];
  let terminalEnabled = false;
  try { const stored = JSON.parse(await fsp.readFile(accessFile, "utf8")); roots = stored.allowedRoots || []; terminalEnabled = stored.terminalEnabled === true; } catch {}
  let tunnelId = null;
  try { tunnelId = (await fsp.readFile(profileFile, "utf8")).match(/tunnel_id:\s*["']?([^"'\r\n]+)/)?.[1]?.trim() || null; } catch {}
  return { configured: Boolean(tunnelId && fs.existsSync(keyFile) && roots.length), roots, tunnelIdMasked: tunnelId ? `${tunnelId.slice(0, 12)}…${tunnelId.slice(-4)}` : null, terminalEnabled };
}

const progress = { stage: "idle", message: "Ready", error: null };
const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY"); res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self' https://api.github.com https://github.com");
  next();
});
app.use(express.json({ limit: "64kb" }));
app.use(express.static(webDir, { index: "index.html", dotfiles: "deny" }));

app.get("/api/state", async (_req, res) => res.json({ platform: process.platform, architecture: process.arch, node: process.version, clientInstalled: fs.existsSync(clientFile), ...(await configuredState()) }));
app.get("/api/progress", (_req, res) => res.json(progress));
app.get("/api/folders", async (req, res) => {
  try {
    if (typeof req.query.path !== "string" || !req.query.path.trim()) {
      const checks = await Promise.all("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map(async (letter) => { const drive = `${letter}:\\`; return await isDirectory(drive) ? { name: drive, path: drive, kind: "drive" } : null; }));
      return res.json({ path: null, parent: null, directories: checks.filter(Boolean) });
    }
    const target = await fsp.realpath(path.resolve(req.query.path));
    if (!(await isDirectory(target))) throw new Error("That location is not a folder");
    const entries = await fsp.readdir(target, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).slice(0, 500).map((entry) => ({ name: entry.name, path: path.join(target, entry.name), kind: "folder" })).sort((a, b) => a.name.localeCompare(b.name));
    const root = path.parse(target).root;
    res.json({ path: target, parent: target.toLowerCase() === root.toLowerCase() ? null : path.dirname(target), directories });
  } catch (error) { res.status(400).json({ error: safeMessage(error) }); }
});

app.post("/api/configure", async (req, res) => {
  try {
    progress.stage = "configuring"; progress.error = null; progress.message = "Validating your settings…";
    if (process.platform !== "win32") throw new Error("This setup currently supports Windows 10 and 11");
    const tunnelId = String(req.body?.tunnelId || "").trim();
    const apiKey = String(req.body?.apiKey || "").trim();
    if (!/^tunnel_[A-Za-z0-9]{16,}$/.test(tunnelId)) throw new Error("Enter a valid tunnel ID beginning with tunnel_");
    if (!apiKey.startsWith("sk-") || apiKey.length < 20) throw new Error("Enter a valid OpenAI runtime API key beginning with sk-");
    const roots = [];
    for (const value of Array.isArray(req.body?.roots) ? req.body.roots : []) roots.push(await validateFolder(value));
    const uniqueRoots = [...new Map(roots.map((item) => [item.toLowerCase(), item])).values()];
    if (!uniqueRoots.length) throw new Error("Add at least one coding folder");
    const terminalEnabled = req.body?.terminalEnabled === true;
    const client = await ensureTunnelClient((message) => { progress.message = message; });
    progress.message = "Encrypting the runtime key for this Windows account…";
    await fsp.mkdir(profileDir, { recursive: true });
    await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "scripts", "protect-key.ps1"), "-OutputPath", keyFile], { input: apiKey });
    progress.message = "Writing the private tunnel profile…";
    const profile = `config_version: 1\ncontrol_plane:\n  base_url: "https://api.openai.com"\n  tunnel_id: "${tunnelId}"\n  api_key: "env:CONTROL_PLANE_API_KEY"\nhealth:\n  listen_addr: "127.0.0.1:24124"\nadmin_ui:\n  open_browser: false\nlog:\n  level: info\n  format: json\nmcp:\n  server_urls:\n    - channel: main\n      url: "http://127.0.0.1:24024/mcp"\n`;
    const env = `# Local-only settings. Never commit this file.\nALLOWED_ROOT=${uniqueRoots[0]}\nPORT=24024\nDASHBOARD_PORT=24025\nOAUTH_LOGIN_PASSWORD=${crypto.randomBytes(32).toString("base64url")}\n`;
    await Promise.all([
      fsp.writeFile(profileFile, profile, { mode: 0o600 }),
      fsp.writeFile(accessFile, `${JSON.stringify({ allowedRoots: uniqueRoots, terminalEnabled }, null, 2)}\n`, { mode: 0o600 }),
      fsp.writeFile(path.join(here, ".env"), env, { mode: 0o600 }),
    ]);
    progress.stage = "complete"; progress.message = "Configuration saved securely.";
    res.json({ ok: true, roots: uniqueRoots, tunnelIdMasked: `${tunnelId.slice(0, 12)}…${tunnelId.slice(-4)}`, terminalEnabled, client });
  } catch (error) {
    progress.stage = "error"; progress.error = safeMessage(error); progress.message = "Setup needs attention.";
    res.status(400).json({ error: safeMessage(error) });
  }
});

app.post("/api/start", async (_req, res) => {
  try {
    const state = await configuredState();
    if (!state.configured) throw new Error("Complete configuration before starting the service");
    progress.stage = "starting"; progress.message = "Starting the MCP server and secure tunnel…"; progress.error = null;
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "start-mcp.ps1")], { cwd: here, detached: true, windowsHide: true, stdio: "ignore" });
    child.unref();
    const deadline = Date.now() + 45000;
    let ready = false;
    while (Date.now() < deadline) {
      try { const response = await fetch("http://127.0.0.1:24124/readyz", { signal: AbortSignal.timeout(1200) }); if (response.ok && (await response.text()).includes("ready")) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error("The tunnel did not become ready within 45 seconds. Open start-mcp.ps1 manually to see diagnostics.");
    progress.stage = "running"; progress.message = "Local Files MCP is online.";
    setTimeout(() => process.exit(0), 1500).unref();
    res.json({ ok: true, dashboard: "http://127.0.0.1:24025/dashboard/" });
  } catch (error) { progress.stage = "error"; progress.error = safeMessage(error); res.status(400).json({ error: safeMessage(error) }); }
});

app.listen(PORT, "127.0.0.1", () => console.log(`Local setup wizard: http://127.0.0.1:${PORT}/`));
