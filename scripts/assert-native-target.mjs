import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizePlatform } = require('../desktop/build-targets.cjs');

const requested = normalizePlatform(process.argv[2] || process.env.FORGELINK_TARGET_PLATFORM || '');
if (requested !== process.platform) {
  throw new Error(
    `ForgeLink native packaging target ${requested} must run on a ${requested} host; current host is ${process.platform}. ` +
    'Run npm run verify:platforms here for cross-platform validation, then let the native GitHub Actions runner build the real package.',
  );
}
console.log(`Native packaging host confirmed: ${process.platform}-${process.arch}`);
