import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const raw = process.argv[i];
  if (!raw.startsWith("--")) continue;
  const [key, ...rest] = raw.slice(2).split("=");
  args.set(key, rest.length ? rest.join("=") : "1");
}

const root = path.resolve(args.get("root") || process.cwd());
const serverScript = path.resolve(args.get("server") || path.join(root, "server.mjs"));
const port = Number(args.get("port") || "24024");
const dashboardPort = Number(args.get("dashboard-port") || "24025");
const parentPid = Number(args.get("parent-pid") || "0");
const statusFile = path.resolve(args.get("status-file") || path.join(root, ".backend-restart-status.json"));
const timeoutMs = Math.max(5_000, Math.min(120_000, Number(args.get("timeout-ms") || "60_000")));
const publicUrl = args.get("public-url") || `http://localhost:${port}`;
const noAuth = ["1", "true"].includes(String(args.get("no-auth") || "").toLowerCase());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveNodeExecutable() {
  if (process.env.FORGELINK_NODE_EXE && fsSync.existsSync(process.env.FORGELINK_NODE_EXE)) {
    return process.env.FORGELINK_NODE_EXE;
  }
  const current = process.execPath;
  if (!path.basename(current).toLowerCase().includes("electron") && fsSync.existsSync(current)) {
    return current;
  }
  const candidates = [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs", "node", "node.exe"),
    path.join(process.env.APPDATA || "", "npm", "node.exe"),
  ];
  for (const candidate of candidates) {
    if (candidate && fsSync.existsSync(candidate)) return candidate;
  }
  return "node";
}

async function writeStatus(status, extra = {}) {
  const payload = {
    operation: "restart_backend",
    status,
    at: new Date().toISOString(),
    ...extra,
  };
  const tmp = `${statusFile}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(tmp, statusFile);
  } catch {
    try { await fs.writeFile(statusFile, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 }); } catch {}
  }
}

async function portFree(targetPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${targetPort}/`, { signal: AbortSignal.timeout(600) });
    await response.body?.cancel();
    return false;
  } catch {
    return true;
  }
}

async function processExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceKillPid(pid) {
  if (!pid || pid <= 0) return;
  try { process.kill(pid, "SIGKILL"); } catch {}
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill.exe", ["/PID", String(pid), "/F", "/T"], { stdio: "ignore", timeout: 3000 });
    } catch {}
  }
}

function freePortIfOccupied(targetPort) {
  if (process.platform === "win32") {
    try {
      const cmd = `Get-NetTCPConnection -LocalPort ${targetPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`;
      const res = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", cmd], { encoding: "utf8", timeout: 3000 });
      const pid = parseInt(res.stdout?.trim() || "", 10);
      if (pid && pid > 0 && pid !== process.pid) {
        forceKillPid(pid);
      }
    } catch {}
  }
}

async function waitForPortFree(targetPort, deadline) {
  while (Date.now() < deadline) {
    if (await portFree(targetPort)) return true;
    await sleep(150);
  }
  return false;
}

async function waitForReady(targetPort, deadline) {
  const url = `http://127.0.0.1:${targetPort}/`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
      const text = await response.text();
      if (response.ok) {
        const body = JSON.parse(text);
        if ((body?.name === "ForgeLink" || body?.name === "Local Files MCP") && body?.endpoint === "/mcp") {
          return body;
        }
      }
    } catch {}
    await sleep(250);
  }
  return null;
}

async function verifyMcpTools(targetPort, deadline) {
  const url = `http://127.0.0.1:${targetPort}/mcp`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "restart-verify", method: "tools/list", params: {} }),
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const text = await response.text();
        const data = JSON.parse(text);
        const tools = data?.result?.tools;
        if (Array.isArray(tools) && tools.length > 0) {
          return { ok: true, toolCount: tools.length };
        }
      }
    } catch {}
    await sleep(300);
  }
  return { ok: false, toolCount: 0 };
}

async function probeTunnels() {
  const check = async (p) => {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/readyz`, { signal: AbortSignal.timeout(1000) });
      const txt = (await res.text()).replaceAll('"', "").trim();
      return res.ok && txt === "ready";
    } catch {
      return false;
    }
  };
  const [t24124, t24125] = await Promise.all([check(24124), check(24125)]);
  return { tunnel24124: t24124, tunnel24125: t24125, anyReady: t24124 || t24125 };
}

async function main() {
  const startedAt = Date.now();
  const nodeExecutable = resolveNodeExecutable();
  await writeStatus("waiting_for_old_process", { oldPid: parentPid, port, nodeExecutable });

  if (parentPid && await processExists(parentPid)) {
    await writeStatus("waiting_for_old_process_exit", { oldPid: parentPid, port });
    const softDeadline = Date.now() + 3500;
    while (Date.now() < softDeadline && await processExists(parentPid)) {
      await sleep(100);
    }
    // If the old process has not exited after 3.5 seconds, force terminate it so the port is freed
    if (await processExists(parentPid)) {
      forceKillPid(parentPid);
      await sleep(500);
    }
  }

  // Ensure ports are completely cleared
  const portDeadline = Date.now() + 8000;
  let portsClear = (await portFree(port)) && (await portFree(dashboardPort));
  if (!portsClear) {
    freePortIfOccupied(port);
    freePortIfOccupied(dashboardPort);
    portsClear = await waitForPortFree(port, portDeadline);
  }

  await writeStatus("starting_new_process", { oldPid: parentPid, port, dashboardPort });

  const childArgs = [serverScript, `--public-url=${publicUrl}`];
  if (noAuth) childArgs.push("--no-auth");

  const logDir = path.join(process.env.MCP_DATA_DIR || root, "tunnel-client-data");
  let stdioConfig = "ignore";
  let outFd = null;
  let errFd = null;
  try {
    fsSync.mkdirSync(logDir, { recursive: true });
    outFd = fsSync.openSync(path.join(logDir, "server.log"), "a");
    errFd = fsSync.openSync(path.join(logDir, "server.err.log"), "a");
    stdioConfig = ["ignore", outFd, errFd];
  } catch {}

  const child = spawn(nodeExecutable, childArgs, {
    cwd: root,
    env: { ...process.env, FORGELINK_NODE_EXE: nodeExecutable },
    detached: true,
    stdio: stdioConfig,
    windowsHide: true,
  });

  if (outFd != null) { try { fsSync.closeSync(outFd); } catch {} }
  if (errFd != null) { try { fsSync.closeSync(errFd); } catch {} }
  child.unref();

  await writeStatus("waiting_for_ready", { oldPid: parentPid, newPid: child.pid, port, dashboardPort });

  const readyDeadline = Date.now() + timeoutMs;
  const ready = await waitForReady(port, readyDeadline);
  if (!ready) {
    try { forceKillPid(child.pid); } catch {}
    throw new Error(`New MCP process PID ${child.pid} did not become ready on port ${port} before timeout`);
  }

  // Deep verification: make sure tools are answering over the MCP endpoint
  const mcpCheck = await verifyMcpTools(port, Date.now() + 15000);
  const tunnelStatus = await probeTunnels();

  await writeStatus("ready", {
    oldPid: parentPid,
    newPid: child.pid,
    port,
    dashboardPort,
    durationMs: Date.now() - startedAt,
    endpoint: ready.endpoint,
    toolsVerified: mcpCheck.ok,
    toolCount: mcpCheck.toolCount,
    tunnels: tunnelStatus,
    reconnected: true,
  });
}

try {
  await main();
} catch (error) {
  await writeStatus("failed", { error: error?.message || String(error) }).catch(() => {});
  process.exitCode = 1;
}
