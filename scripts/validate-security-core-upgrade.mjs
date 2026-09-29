import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const upgradeDir = path.join(root, "scripts", "security-upgrade");
const spec = JSON.parse(await fsp.readFile(path.join(upgradeDir, "patch-spec.json"), "utf8"));
const serverPath = path.join(root, spec.files.server);
const configPath = path.join(root, spec.files.accessConfig);
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

let server = await fsp.readFile(serverPath, "utf8");
if (server.includes('ChatGptPermissionBroker')) {
  throw new Error('This legacy one-time security upgrade is superseded by the ChatGPT permission broker.');
}
const beforeServerSha256 = sha256(server);
const applied = [];

for (const operation of spec.operations) {
  const replacement = operation.fragment
    ? await fsp.readFile(path.join(upgradeDir, operation.fragment), "utf8")
    : operation.new;
  if (operation.type === "replace_exact" || operation.type === "replace_exact_fragment") {
    server = replaceExact(server, operation.old, replacement, operation.label);
  } else if (operation.type === "replace_between_fragment") {
    server = replaceBetween(server, operation.start, operation.end, replacement, operation.label);
  } else {
    throw new Error("Unsupported patch operation: " + operation.type);
  }
  applied.push(operation.label);
}

const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forgelink-security-upgrade-validate-"));
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
const isDriveRoot = (value) => {
  const resolved = path.resolve(String(value));
  return path.parse(resolved).root.toLowerCase() === resolved.toLowerCase();
};
const removedWriteDriveRoots = (config.allowedRoots || []).filter(isDriveRoot);
const removedReadDriveRoots = (config.readOnlyRoots || []).filter(isDriveRoot);
config.allowedRoots = (config.allowedRoots || []).filter((entry) => !isDriveRoot(entry));
config.readOnlyRoots = (config.readOnlyRoots || []).filter((entry) => !isDriveRoot(entry));
if (spec.configMigration?.addWorkspaceRoot) {
  const workspaceLower = root.toLowerCase();
  if (!config.allowedRoots.some((entry) => path.resolve(entry).toLowerCase() === workspaceLower)) config.allowedRoots.unshift(root);
}
if (spec.configMigration?.fullTerminalToGuarded && config.terminalMode === "full") config.terminalMode = "safe";

const fragmentFiles = [...new Set(spec.operations.map((op) => op.fragment).filter(Boolean))];
const fragmentHashes = {};
for (const name of fragmentFiles) fragmentHashes[name] = sha256(await fsp.readFile(path.join(upgradeDir, name)));

console.log(JSON.stringify({
  ok: true,
  mode: "read-only-validation",
  appliedAnchors: applied,
  server: { beforeSha256: beforeServerSha256, afterSha256: sha256(server), syntaxValid: true },
  accessConfig: { before: beforeConfig, after: config, removedWriteDriveRoots, removedReadDriveRoots },
  patchSpecSha256: sha256(await fsp.readFile(path.join(upgradeDir, "patch-spec.json"))),
  fragmentHashes,
}, null, 2));
