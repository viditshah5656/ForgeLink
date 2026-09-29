import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(path.resolve(desktopDir, "..", "server.mjs"), "utf8");

test("backend restart wrapper uses the imported fs module and writes valid JSON whitespace", () => {
  assert.doesNotMatch(serverSource, /fsSync\.existsSync/);
  assert.match(serverSource, /fs\.existsSync/);
  assert.match(serverSource, /JSON\.stringify\(payload, null, 2\)\}\\n/);
  assert.doesNotMatch(serverSource, /JSON\.stringify\(payload, null, 2\)\}\\\\n/);
});

test("backend status tolerates a legacy malformed restart status file", () => {
  assert.match(serverSource, /error instanceof SyntaxError/);
  assert.match(serverSource, /status: "invalid_status_file"/);
});
