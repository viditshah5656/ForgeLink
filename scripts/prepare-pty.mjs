import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveRequestedTarget } = require('../desktop/build-targets.cjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules', 'node-pty');
const destination = path.join(root, 'dist-backend', 'node-pty');
const { platform: targetPlatform, arch: targetArch } = resolveRequestedTarget();
const targetKey = `${targetPlatform}-${targetArch}`;
const validateOnly = process.argv.includes('--validate-only');
const isNativeTarget = targetPlatform === process.platform && targetArch === process.arch;
const prebuildSource = path.join(source, 'prebuilds', targetKey);
const releaseSource = path.join(source, 'build', 'Release');

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

await fs.access(path.join(source, 'package.json'));
await fs.access(path.join(source, 'lib'));

const prebuildAvailable = await exists(prebuildSource);
const nativeReleaseAvailable = await exists(releaseSource);
const sourceBuildAvailable = await exists(path.join(source, 'binding.gyp'));

if (!prebuildAvailable && !sourceBuildAvailable) {
  throw new Error(`node-pty has neither a ${targetKey} prebuild nor native build sources.`);
}

if (validateOnly) {
  if (isNativeTarget && !prebuildAvailable && !nativeReleaseAvailable) {
    throw new Error(
      `node-pty target ${targetKey} requires a native build, but node_modules/node-pty/build/Release is missing. Run npm ci on this native host and inspect the node-pty install step.`,
    );
  }
  console.log(JSON.stringify({
    ok: true,
    target: targetKey,
    host: `${process.platform}-${process.arch}`,
    mode: 'validate-only',
    prebuildAvailable,
    nativeReleaseAvailable: isNativeTarget ? nativeReleaseAvailable : false,
    requiresNativeHostBuild: !prebuildAvailable,
    executableHere: isNativeTarget,
  }, null, 2));
  process.exit(0);
}

if (!prebuildAvailable && !isNativeTarget) {
  throw new Error(
    `Cannot stage node-pty for foreign target ${targetKey} on ${process.platform}-${process.arch}: this target requires native compilation. Run npm run verify:platforms locally, then build the real artifact on its native CI runner.`,
  );
}

if (!prebuildAvailable && !nativeReleaseAvailable) {
  throw new Error(`node-pty target ${targetKey} requires node_modules/node-pty/build/Release, but it is missing.`);
}

await fs.rm(destination, { recursive: true, force: true });
await fs.mkdir(destination, { recursive: true });
await fs.copyFile(path.join(source, 'package.json'), path.join(destination, 'package.json'));
await fs.copyFile(path.join(source, 'LICENSE'), path.join(destination, 'LICENSE'));
await fs.cp(path.join(source, 'lib'), path.join(destination, 'lib'), { recursive: true });

if (prebuildAvailable) {
  const targetDestination = path.join(destination, 'prebuilds', targetKey);
  await fs.mkdir(path.dirname(targetDestination), { recursive: true });
  await fs.cp(prebuildSource, targetDestination, {
    recursive: true,
    filter: (candidate) => !candidate.toLowerCase().endsWith('.pdb'),
  });
  console.log(`Prepared node-pty prebuilt native files for ${targetKey}`);
} else {
  const releaseDestination = path.join(destination, 'build', 'Release');
  await fs.mkdir(path.dirname(releaseDestination), { recursive: true });
  await fs.cp(releaseSource, releaseDestination, {
    recursive: true,
    filter: (candidate) => !candidate.toLowerCase().endsWith('.pdb'),
  });
  console.log(`Prepared node-pty host-built native files for ${targetKey}`);
}
