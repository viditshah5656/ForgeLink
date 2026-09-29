import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const configPath = new URL("../vite.renderer.config.mjs", import.meta.url);

test("renderer CSP permits the fixed local ForgeLink dashboard origin", async () => {
  const source = await fs.readFile(configPath, "utf8");
  assert.match(source, /connect-src[^\n]*http:\/\/127\.0\.0\.1:24025/);
  assert.match(source, /connect-src[^\n]*http:\/\/localhost:24025/);
});
