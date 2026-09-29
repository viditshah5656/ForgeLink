import test from "node:test";
import assert from "node:assert/strict";
import { getDeviceSummary, normalizeListenerList, normalizeProcessList } from "./system-diagnostics.mjs";

test("device summary avoids host and account identifiers", () => {
  const summary = getDeviceSummary({ platform: "win32", release: "test", arch: "x64", cpus: [{ model: "CPU" }, { model: "CPU" }], totalMemory: 100, freeMemory: 40, uptime: 12.9, nodeVersion: "v22" });
  assert.deepEqual(summary, {
    platform: "win32", release: "test", architecture: "x64",
    cpu: { model: "CPU", logicalCores: 2 },
    memory: { totalBytes: 100, freeBytes: 40, usedBytes: 60 },
    uptimeSeconds: 12, runtimes: { node: "v22" },
  });
  assert.equal("hostname" in summary, false);
  assert.equal("username" in summary, false);
});

test("process summaries discard command lines and reject malformed entries", () => {
  assert.deepEqual(normalizeProcessList([
    { Id: 3, ParentProcessId: 1, ProcessName: "C:\\Users\\secret\\editor.exe", WorkingSet64: 2048, CommandLine: "--token secret" },
    { Id: "bad", ProcessName: "" },
  ]), [{ pid: 3, parentPid: 1, name: "editor.exe", memoryBytes: 2048 }]);
});

test("listener summaries enforce valid ports and omit arbitrary fields", () => {
  assert.deepEqual(normalizeListenerList([
    { LocalAddress: "127.0.0.1", LocalPort: 3000, OwningProcess: 12, Secret: "ignored" },
    { LocalAddress: "*", LocalPort: 70000, OwningProcess: 2 },
  ]), [{ address: "127.0.0.1", port: 3000, pid: 12 }]);
});
