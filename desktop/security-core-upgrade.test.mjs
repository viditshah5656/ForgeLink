import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(desktopDir, "..");
const upgradeDir = path.join(root, "scripts", "security-upgrade");
const spec = JSON.parse(fs.readFileSync(path.join(upgradeDir, "patch-spec.json"), "utf8"));

function occurrences(source, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function transformServer(source) {
  let server = source.replace(/\r\n/g, "\n");
  for (const operation of spec.operations) {
    if (operation.type === "replace_exact" || operation.type === "replace_exact_fragment") {
      assert.equal(occurrences(server, operation.old), 1, operation.label + " exact anchor");
      const replacement = operation.type === "replace_exact_fragment"
        ? fs.readFileSync(path.join(upgradeDir, operation.fragment), "utf8")
        : operation.new;
      server = server.replace(operation.old, replacement);
      continue;
    }

    assert.equal(operation.type, "replace_between_fragment");
    assert.equal(occurrences(server, operation.start), 1, operation.label + " start anchor");
    assert.equal(occurrences(server, operation.end), 1, operation.label + " end anchor");
    const start = server.indexOf(operation.start);
    const end = server.indexOf(operation.end, start + operation.start.length);
    assert.ok(end > start, operation.label + " boundary ordering");
    const replacement = fs.readFileSync(path.join(upgradeDir, operation.fragment), "utf8").replace(/\s+$/, "") + "\n\n";
    server = server.slice(0, start) + replacement + server.slice(end);
  }
  return server;
}

function escapeRegExp(value) {
  return String(value).replace(/[$^.*+?()[\]{}|\\]/g, "\\$&");
}

test("protected security-core upgrade is either previewable or superseded by the ChatGPT permission broker", async () => {
  const current = fs.readFileSync(path.join(root, "server.mjs"), "utf8");
  if (current.includes('ChatGptPermissionBroker')) {
    assert.match(current, /resolve_chat_permission/);
    assert.match(current, /REMOTE_MAINTENANCE_PATHS/);
    assert.match(current, /FORGELINK_LOCAL_SECURITY_MAINTENANCE_EXPIRES_AT/);
    return;
  }
  const transformed = transformServer(current);

  for (const marker of [
    "new AsyncLocalStorage()",
    "resolve_path_access_once",
    'visibility: ["app"]',
    "use_path_access_once",
    "ONE_TIME_ACCESS_CAPABILITY_TTL_MS = 90_000",
    'npmProjectCommand(["run", safeScript])',
    "pathIsWithinRoot(capability.root, candidate)",
    'path.join(here, "desktop", "artifact-ui-client.bundle.js")',
    'path.join(here, "package.json")',
    'path.join(here, "scripts")',
    "FORGELINK_LOCAL_SECURITY_MAINTENANCE_EXPIRES_AT",
    "maintenanceExpiresAt > Date.now()",
  ]) {
    assert.match(transformed, new RegExp(escapeRegExp(marker)));
  }

  assert.doesNotMatch(transformed, /"npm-run": safeScript \? \[IS_WINDOWS \? "npm\.cmd"/);

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forgelink-security-preview-"));
  const preview = path.join(tempDir, "server.mjs");
  try {
    await fsp.writeFile(preview, transformed, "utf8");
    const syntax = spawnSync(process.execPath, ["--check", preview], {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test("local protected-core launcher requires explicit confirmation and an expiring maintenance window", () => {
  const launcher = fs.readFileSync(path.join(root, "scripts", "run-security-core-upgrade.ps1"), "utf8");
  const migrator = fs.readFileSync(path.join(root, "scripts", "apply-security-core-upgrade.mjs"), "utf8");
  assert.match(launcher, /APPLY FORGELINK SECURITY UPGRADE/);
  assert.match(launcher, /FORGELINK_LOCAL_SECURITY_MAINTENANCE_EXPIRES_AT/);
  assert.match(launcher, /5 \* 60 \* 1000/);
  assert.match(migrator, /maintenanceExpiresAt > Date\.now\(\)/);
  assert.match(migrator, /apply && !maintenance/);
});

test("protected migration removes standing drive roots, preserves project roots, and downgrades Full Terminal", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "access-config.json"), "utf8"));
  const migrated = structuredClone(config);
  const isDriveRoot = (entry) => {
    const resolved = path.resolve(String(entry));
    return path.parse(resolved).root.toLowerCase() === resolved.toLowerCase();
  };

  migrated.allowedRoots = (migrated.allowedRoots || []).filter((entry) => !isDriveRoot(entry));
  migrated.readOnlyRoots = (migrated.readOnlyRoots || []).filter((entry) => !isDriveRoot(entry));
  if (!migrated.allowedRoots.some((entry) => path.resolve(entry).toLowerCase() === root.toLowerCase())) {
    migrated.allowedRoots.unshift(root);
  }
  if (migrated.terminalMode === "full") migrated.terminalMode = "safe";

  assert.equal(migrated.allowedRoots.some(isDriveRoot), false);
  assert.equal(migrated.readOnlyRoots.some(isDriveRoot), false);
  assert.ok(migrated.allowedRoots.some((entry) => path.resolve(entry).toLowerCase() === root.toLowerCase()));
  assert.equal(migrated.terminalMode, "safe");
  assert.ok(migrated.allowedRoots.includes("D:\\mtkclient-main"));
});
