import path from 'node:path';
import { api } from '@electron-forge/core';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizePlatform } = require('../desktop/build-targets.cjs');

const platform = normalizePlatform(process.argv[2] || process.platform);
if (platform !== process.platform) {
  throw new Error(
    `Native Forge make for ${platform} must run on a ${platform} host; current host is ${process.platform}.`,
  );
}

const arch = process.arch;
process.env.FORGELINK_TARGET_PLATFORM = platform;
process.env.FORGELINK_TARGET_ARCH = arch;

const buildId = `${platform}-${arch}-${Date.now()}-${process.pid}`;
const outDir = path.resolve('out', 'native-builds', buildId);

const results = await api.make({
  dir: process.cwd(),
  platform,
  arch,
  outDir,
  interactive: true,
});

console.log(JSON.stringify({
  ok: true,
  platform,
  arch,
  outDir,
  outputs: Array.isArray(results)
    ? results.map((item) => ({
        maker: item.makerName || item.maker || null,
        artifacts: item.artifacts || item.outputPaths || [],
      }))
    : results,
}, null, 2));
