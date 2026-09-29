import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createDirectoryWalker, walkDirectory } from "./search-walker.mjs";

function dirent(name, { directory = false, symlink = false } = {}) {
  return {
    name,
    isDirectory: () => directory,
    isSymbolicLink: () => symlink,
  };
}

test("continues past access-denied directories and reports incomplete scan details", async () => {
  const root = path.resolve("search-walker-fixture");
  const protectedPath = path.join(root, "$Recycle.Bin");
  const appPath = path.join(root, "Users", "Vidit", "AppData");
  const tree = new Map([
    [root, [dirent("$Recycle.Bin", { directory: true }), dirent("Users", { directory: true })]],
    [protectedPath, Object.assign(new Error("access denied"), { code: "EACCES" })],
    [path.join(root, "Users"), [dirent("Vidit", { directory: true })]],
    [path.join(root, "Users", "Vidit"), [dirent("AppData", { directory: true })]],
    [appPath, [dirent("cowork-service.log")]],
  ]);
  const scan = await walkDirectory(root, {
    maxEntries: 100,
    readdir: async (target) => {
      const result = tree.get(target);
      if (result instanceof Error) throw result;
      if (!result) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      return result;
    },
  });

  assert.ok(scan.items.some((item) => item.full === path.join(appPath, "cowork-service.log")));
  assert.equal(scan.skippedLocationsCount, 1);
  assert.deepEqual(scan.skippedLocations[0], { path: protectedPath, reason: "EACCES" });
  assert.equal(scan.truncated, false);
});

test("does not recurse through reparse points and reports them", async () => {
  const root = path.resolve("search-walker-links");
  const link = path.join(root, "junction");
  const scan = await walkDirectory(root, {
    readdir: async (target) => target === root ? [dirent("junction", { symlink: true })] : [],
  });

  assert.equal(scan.scannedEntries, 1);
  assert.equal(scan.skippedLocationsCount, 1);
  assert.deepEqual(scan.skippedLocations[0], { path: link, reason: "REPARSE_POINT" });
});

test("pages resume at the exact next entry within a directory and then descend", async () => {
  const root = path.resolve("search-walker-pages");
  const child = path.join(root, "child");
  const calls = [];
  const walker = createDirectoryWalker(root, {
    prune: false,
    readdir: async (target) => {
      calls.push(target);
      if (target === root) return [dirent("a"), dirent("child", { directory: true }), dirent("b")];
      if (target === child) return [dirent("nested")];
      throw new Error(`unexpected ${target}`);
    },
  });

  const first = await walker.nextPage({ maxEntries: 1 });
  const second = await walker.nextPage({ maxEntries: 1 });
  const third = await walker.nextPage({ maxEntries: 1 });
  const fourth = await walker.nextPage({ maxEntries: 1 });
  assert.deepEqual([first, second, third, fourth].map((page) => page.items.map((item) => item.relative)),
    [["a"], ["child"], ["b"], ["child/nested"]]);
  assert.deepEqual(calls, [root, child]);
  assert.deepEqual([first.reason, second.reason, third.reason, fourth.reason],
    ["SCAN_LIMIT", "SCAN_LIMIT", "SCAN_LIMIT", "SEARCH_COMPLETE"]);
  assert.deepEqual([first.scannedEntriesTotal, second.scannedEntriesTotal, third.scannedEntriesTotal, fourth.scannedEntriesTotal], [1, 2, 3, 4]);
  assert.equal(fourth.complete, true);
  assert.equal(fourth.resumable, false);
});

test("time limit retains the unread entries for a later page", async () => {
  const root = path.resolve("search-walker-time");
  const walker = createDirectoryWalker(root, {
    prune: false,
    readdir: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [dirent("later")];
    },
  });
  const first = await walker.nextPage({ maxEntries: 10, maxTimeMs: 1 });
  assert.equal(first.reason, "TIME_LIMIT");
  assert.equal(first.scannedEntries, 0);
  assert.equal(first.resumable, true);
  const second = await walker.nextPage({ maxEntries: 10 });
  assert.deepEqual(second.items.map((item) => item.relative), ["later"]);
  assert.equal(second.complete, true);
});

test("a slow directory read yields at the time budget and remains resumable", async () => {
  const root = path.resolve("search-walker-slow-read");
  let release;
  const walker = createDirectoryWalker(root, { prune: false, readdir: async () => await new Promise((resolve) => { release = () => resolve([dirent("found")]); }) });
  const first = await walker.nextPage({ maxEntries: 10, maxTimeMs: 5 });
  assert.equal(first.reason, "TIME_LIMIT");
  release();
  assert.deepEqual((await walker.nextPage()).items.map((item) => item.relative), ["found"]);
});

test("default pruning and depth bounds classify unsearched directories", async () => {
  const root = path.resolve("search-walker-prune");
  const calls = [];
  const walker = createDirectoryWalker(root, {
    maxDepth: 0,
    readdir: async (target) => {
      calls.push(target);
      return [dirent("src", { directory: true }), dirent("node_modules", { directory: true }), dirent("README.md")];
    },
  });
  const page = await walker.nextPage();
  assert.deepEqual(calls, [root]);
  assert.equal(page.traversalExhausted, true);
  assert.equal(page.complete, false);
  assert.equal(page.reason, "SKIPPED_LOCATIONS");
  assert.equal(page.skippedReasonCounts.DEPTH_LIMIT, 2);
  assert.equal(page.skippedLocationsCount, 2);

  const pruned = createDirectoryWalker(root, {
    readdir: async (target) => target === root
      ? [dirent("node_modules", { directory: true }), dirent("src", { directory: true })]
      : [dirent("index.js")],
  });
  const scan = await pruned.nextPage();
  assert.deepEqual(scan.items.map((item) => item.relative), ["node_modules", "src", "src/index.js"]);
  assert.equal(scan.skippedReasonCounts.PRUNED_DIRECTORY, 1);
  assert.equal(scan.complete, false);
});

test("abort cancels a running traversal without reading or returning stale entries", async () => {
  const root = path.resolve("search-walker-cancel");
  const controller = new AbortController();
  let calls = 0;
  const walker = createDirectoryWalker(root, {
    readdir: async () => {
      calls += 1;
      controller.abort();
      return [dirent("late")];
    },
  });
  const page = await walker.nextPage({ signal: controller.signal });
  assert.equal(page.reason, "CANCELLED");
  assert.equal(page.resumable, false);
  assert.deepEqual(page.items, []);
  assert.equal((await walker.nextPage()).reason, "CANCELLED");
  assert.equal(calls, 1);
});

test("skipped errors are classified while explicit exclusions stay within the search scope", async () => {
  const root = path.resolve("search-walker-errors");
  const denied = path.join(root, "denied");
  const missing = path.join(root, "missing");
  const walker = createDirectoryWalker(root, {
    prune: false,
    excludePatterns: ["excluded"],
    readdir: async (target) => {
      if (target === root) return [dirent("denied", { directory: true }), dirent("missing", { directory: true }), dirent("excluded", { directory: true })];
      if (target === denied) throw Object.assign(new Error("denied"), { code: "EACCES" });
      if (target === missing) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      throw new Error(`unexpected ${target}`);
    },
  });
  const page = await walker.nextPage();
  assert.equal(page.skippedReasonCounts.ACCESS_DENIED, 1);
  assert.equal(page.skippedReasonCounts.BROKEN_LINK, 1);
  assert.equal(page.skippedLocationsCount, 2);
  assert.equal(page.complete, false);
});

test("bounded sibling reads overlap while results stay in breadth-first order", async () => {
  const root = path.resolve("search-walker-parallel");
  let inFlight = 0;
  let highWater = 0;
  const walker = createDirectoryWalker(root, {
    prune: false,
    parallelism: 2,
    readdir: async (target) => {
      if (target === root) return [dirent("a", { directory: true }), dirent("b", { directory: true })];
      inFlight += 1;
      highWater = Math.max(highWater, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return [dirent("file")];
    },
  });
  const result = await walker.nextPage();
  assert.deepEqual(result.items.map((item) => item.relative), ["a", "b", "a/file", "b/file"]);
  assert.equal(highWater, 2);
  assert.equal(result.complete, true);
});

test("one walker rejects overlapping page calls", async () => {
  const root = path.resolve("search-walker-overlap");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const walker = createDirectoryWalker(root, { readdir: async () => { await gate; return [dirent("a")]; } });
  const first = walker.nextPage();
  await assert.rejects(walker.nextPage(), /already in progress/);
  release();
  assert.equal((await first).complete, true);
});

test("a subtree exclusion avoids opening that directory", async () => {
  const root = path.resolve("search-walker-exclude-subtree");
  const calls = [];
  const walker = createDirectoryWalker(root, {
    prune: false,
    excludePatterns: ["**/node_modules/**"],
    readdir: async (target) => {
      calls.push(target);
      if (target !== root) throw new Error("excluded directory was opened");
      return [dirent("node_modules", { directory: true }), dirent("README.md")];
    },
  });
  const page = await walker.nextPage();
  assert.deepEqual(calls, [root]);
  assert.deepEqual(page.items.map((item) => item.relative), ["node_modules", "README.md"]);
  assert.equal(page.complete, true);
});
