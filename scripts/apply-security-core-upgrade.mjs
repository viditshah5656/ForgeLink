import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const upgradeDir = path.join(root, "scripts", "security-upgrade");
const specPath = path.join(upgradeDir, "patch-spec.json");
const serverPath = path.join(root, "server.mjs");
const configPath = path.join(root, "access-config.json");
const apply = process.argv.includes("--apply");
const maintenanceExpiresAt = Number(process.env.FORGELINK_LOCAL_SECURITY_MAINTENANCE_EXPIRES_AT);
const maintenance = process.env.FORGELINK_LOCAL_SECURITY_MAINTENANCE === "1" && Number.isFinite(maintenanceExpiresAt) && maintenanceExpiresAt > Date.now();

if (apply && !maintenance) {
  throw new Error("Refusing protected-core mutation: set FORGELINK_LOCAL_SECURITY_MAINTENANCE=1 locally and pass --apply.");
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function exactOnce(source, needle, label) {
  const candidates = [...new Set([needle, needle.replace(/\n/g, "\r\n")])];
  for (const candidate of candidates) {
    const first = source.indexOf(candidate);
    const last = source.lastIndexOf(candidate);
    if (first >= 0 && first === last) return { index: first, matched: candidate };
  }
  throw new Error(label + ": exact anchor must occur once.");
}

function replaceExact(source, oldText, newText, label) {
  const match = exactOnce(source, oldText, label);
  const eol = match.matched.includes("\r\n") ? "\r\n" : "\n";
  const replacement = newText.replace(/\n/g, eol);
  return source.slice(0, match.index) + replacement + source.slice(match.index + match.matched.length);
}

function replaceBetween(source, startMarker, endMarker, replacement, label) {
  const startMatch = exactOnce(source, startMarker, label + " start");
  const endCandidates = [...new Set([endMarker, endMarker.replace(/\n/g, "\r\n")])];
  let end = -1;
  let matchedEnd = "";
  for (const candidate of endCandidates) {
    const found = source.indexOf(candidate, startMatch.index + startMatch.matched.length);
    if (found >= 0) { end = found; matchedEnd = candidate; break; }
  }
  if (end < 0) throw new Error(label + ": end marker not found.");
  const eol = startMatch.matched.includes("\r\n") || matchedEnd.includes("\r\n") ? "\r\n" : "\n";
  const body = replacement.trimEnd().replace(/\n/g, eol);
  return source.slice(0, startMatch.index) + body + eol + eol + source.slice(end);
}

async function readFragment(name) {
  return await fsp.readFile(path.join(upgradeDir, name), "utf8");
}

function isDriveRoot(value) {
  const resolved = path.resolve(String(value));
  return path.parse(resolved).root.toLowerCase() === resolved.toLowerCase();
}

async function buildPreview() {
  const spec = JSON.parse(await fsp.readFile(specPath, "utf8"));
  let server = await fsp.readFile(serverPath, "utf8");
  if (server.includes('ChatGptPermissionBroker')) {
    throw new Error('This legacy one-time security upgrade is superseded by the ChatGPT permission broker. Its config migration must not be applied to this source tree.');
  }
  const beforeServerSha256 = sha256(server);
  const operations = [];

  for (const operation of spec.operations) {
    const replacement = operation.fragment ? await readFragment(operation.fragment) : operation.new;
    if (operation.type === "replace_exact" || operation.type === "replace_exact_fragment") {
      server = replaceExact(server, operation.old, replacement, operation.label);
    } else if (operation.type === "replace_between_fragment") {
      server = replaceBetween(server, operation.start, operation.end, replacement, operation.label);
    } else {
      throw new Error("Unsupported patch operation: " + operation.type);
    }
    operations.push(operation.label);
  }

  const afterServerSha256 = sha256(server);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forgelink-security-upgrade-"));
  const previewServer = path.join(tempDir, "server.mjs");
  await fsp.writeFile(previewServer, server, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", previewServer], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  await fsp.rm(tempDir, { recursive: true, force: true });
  if (syntax.error || syntax.status !== 0) {
    throw new Error("Patched server syntax validation failed: " + (syntax.error?.message || syntax.stderr || syntax.stdout));
  }

  const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
  const beforeConfig = JSON.parse(JSON.stringify(config));
  const removedWriteDriveRoots = (config.allowedRoots || []).filter(isDriveRoot);
  const removedReadDriveRoots = (config.readOnlyRoots || []).filter(isDriveRoot);
  config.allowedRoots = (config.allowedRoots || []).filter((entry) => !isDriveRoot(entry));
  config.readOnlyRoots = (config.readOnlyRoots || []).filter((entry) => !isDriveRoot(entry));
  if (spec.configMigration?.addWorkspaceRoot) {
    const workspaceLower = root.toLowerCase();
    if (!config.allowedRoots.some((entry) => path.resolve(entry).toLowerCase() === workspaceLower)) config.allowedRoots.unshift(root);
  }
  if (spec.configMigration?.fullTerminalToGuarded && config.terminalMode === "full") config.terminalMode = "safe";
  const configText = JSON.stringify(config, null, 2) + "\n";

  return {
    spec, server, configText, beforeConfig, config, operations, beforeServerSha256, afterServerSha256,
    removedWriteDriveRoots, removedReadDriveRoots, syntaxValid: true,
  };
}

const preview = await buildPreview();
const report = {
  mode: apply ? "apply" : "dry-run",
  operations: preview.operations,
  server: {
    beforeSha256: preview.beforeServerSha256,
    afterSha256: preview.afterServerSha256,
    syntaxValid: preview.syntaxValid,
    npmRunner: "node.exe + npm-cli.js, shell=false",
    oneTimeCapabilityTtlSeconds: 90,
    appOnlyResolver: true,
    modelVisibleWrapper: "use_path_access_once",
  },
  accessConfig: {
    before: preview.beforeConfig,
    after: preview.config,
    removedWriteDriveRoots: preview.removedWriteDriveRoots,
    removedReadDriveRoots: preview.removedReadDriveRoots,
  },
};

if (!apply) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(root, ".security-maintenance-backups", stamp);
await fsp.mkdir(backupDir, { recursive: true });
await fsp.copyFile(serverPath, path.join(backupDir, "server.mjs"));
await fsp.copyFile(configPath, path.join(backupDir, "access-config.json"));

const serverTemp = serverPath + ".security-upgrade.tmp";
const configTemp = configPath + ".security-upgrade.tmp";
await fsp.writeFile(serverTemp, preview.server, { mode: 0o600 });
await fsp.writeFile(configTemp, preview.configText, { mode: 0o600 });

try {
  await fsp.rename(serverTemp, serverPath);
  await fsp.rename(configTemp, configPath);
} catch (error) {
  await fsp.rm(serverTemp, { force: true }).catch(() => {});
  await fsp.rm(configTemp, { force: true }).catch(() => {});
  await fsp.copyFile(path.join(backupDir, "server.mjs"), serverPath);
  await fsp.copyFile(path.join(backupDir, "access-config.json"), configPath);
  throw error;
}

console.log(JSON.stringify({ ...report, backupDir, restartRequired: true }, null, 2));
