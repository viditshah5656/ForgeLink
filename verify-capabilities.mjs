import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const endpoint = process.argv[2] || "http://127.0.0.1:24024/mcp";
const testRoot = path.join(here, `.mcp-capability-test-${Date.now()}`);
const copyRoot = `${testRoot}-copy`;
let nextId = 1;

async function callTool(name, args) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await response.json();
  if (!response.ok || body.error || body.result?.isError) throw new Error(`${name} failed: ${JSON.stringify(body)}`);
  return body.result;
}

try {
  await callTool("create_directory", { path: testRoot });
  const sample = path.join(testRoot, "sample.txt");
  await callTool("write_file", { path: sample, content: "alpha\nbeta\n" });
  await callTool("edit_text_file", { path: sample, edits: [{ oldText: "beta", newText: "gamma", expectedOccurrences: 1 }] });
  await callTool("append_text_file", { path: sample, content: "delta\n" });
  const read = await callTool("read_file_lines", { path: sample, startLine: 1, endLine: 5 });
  const hash = await callTool("hash_file", { path: sample, algorithm: "sha256" });
  const image = path.join(testRoot, "pixel.png");
  await callTool("write_binary_file", { path: image, base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" });
  const imageResult = await callTool("read_image_file", { path: image });
  await callTool("copy_path", { source: testRoot, destination: copyRoot });
  const log = await callTool("get_git_log", { path: here, limit: 2 });
  const branches = await callTool("get_git_branches", { path: here });

  const gitRoot = path.join(testRoot, "git-workspace");
  await callTool("create_directory", { path: gitRoot });
  const tracked = path.join(gitRoot, "tracked.txt");
  await callTool("write_file", { path: tracked, content: "version one\n" });
  await callTool("run_terminal_command", { cwd: gitRoot, command: "git init; git config user.name 'MCP Verification'; git config user.email 'mcp-test@example.invalid'" });
  await callTool("git_stage", { path: gitRoot, paths: ["tracked.txt"] });
  const commit = await callTool("git_commit", { path: gitRoot, message: "Verify local Git tools" });
  await callTool("edit_text_file", { path: tracked, edits: [{ oldText: "version one", newText: "version two", expectedOccurrences: 1 }] });
  await callTool("git_stage", { path: gitRoot, paths: ["tracked.txt"] });
  await callTool("git_unstage", { path: gitRoot, paths: ["tracked.txt"] });
  const gitStatus = await callTool("get_git_status", { path: gitRoot });
  await callTool("delete_path", { path: copyRoot, recursive: true });
  await callTool("delete_path", { path: testRoot, recursive: true });

  const checks = {
    editAndRead: read.structuredContent?.content?.includes("gamma") && read.structuredContent?.content?.includes("delta"),
    hash: hash.structuredContent?.content?.includes("sha256"),
    imageRead: imageResult.content?.[0]?.type === "image" && imageResult.content[0].mimeType === "image/png",
    gitLog: Boolean(log.structuredContent?.content),
    gitBranches: Boolean(branches.structuredContent?.content),
    gitCommit: commit.structuredContent?.content?.includes("exitCode"),
    gitUnstage: gitStatus.structuredContent?.content?.includes(" M tracked.txt"),
    cleanup: !fs.existsSync(testRoot) && !fs.existsSync(copyRoot),
  };
  if (Object.values(checks).some((value) => !value)) throw new Error(`Capability checks failed: ${JSON.stringify(checks)}`);
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  for (const candidate of [testRoot, copyRoot]) {
    if (path.dirname(candidate) === here && path.basename(candidate).startsWith(".mcp-capability-test-")) {
      await fsp.rm(candidate, { recursive: true, force: true });
    }
  }
}
