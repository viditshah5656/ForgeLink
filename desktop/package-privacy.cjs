const fs = require('node:fs');
const path = require('node:path');

const PRIVATE_FILE_PATTERNS = Object.freeze([
  /(^|[\\/])\.env(?:\.[^\\/]*)?$/i,
  /(^|[\\/])\.oauth-(?:clients|tokens)\.json$/i,
  /(^|[\\/])\.chatgpt-permission-requests\.json(?:\.[^\\/]*)?$/i,
  /(^|[\\/])\.current-tunnel-url$/i,
  /(^|[\\/])openai-tunnel\.env$/i,
  /(^|[\\/])access-config\.json$/i,
  /(^|[\\/])project-registry\.json(?:\.tmp-[^\\/]*)?$/i,
  /(^|[\\/])project-index\.json(?:\.[^\\/]*)?$/i,
  /(^|[\\/])engineering-sessions\.json(?:\.[^\\/]*)?$/i,
  /(^|[\\/])\.backend-restart-status\.json$/i,
  /(^|[\\/])job-processes\.json(?:\.[^\\/]*)?$/i,
  /(^|[\\/])terminal-processes\.json(?:\.[^\\/]*)?$/i,
  /(^|[\\/])desktop-config\.json$/i,
  /(^|[\\/])desktop-secrets\.json$/i,
  /(^|[\\/])cloudflare-named\.json$/i,
  /(^|[\\/])(?:agent-audit|safety-events)\.jsonl$/i,
  /(^|[\\/])[^\\/]+\.dpapi$/i,
  /(^|[\\/])[^\\/]+\.(?:err\.)?log$/i,
]);

const PRIVATE_DIRECTORY_PATTERN =
  /(^|[\\/])(?:tunnel-client-data|recovery|regressions|web-subagents|native-agent-runtime|engineering|project-memory|provider-swarms|presentation-artifacts|\.ui-audit|bin)(?:[\\/]|$)/i;

const PACKAGE_IGNORE_PATTERNS = Object.freeze([
  ...PRIVATE_FILE_PATTERNS,
  PRIVATE_DIRECTORY_PATTERN,
]);

function isPackagePrivatePath(candidatePath) {
  const value = String(candidatePath || '');
  return PACKAGE_IGNORE_PATTERNS.some((pattern) => pattern.test(value));
}

function findPackagePrivacyViolations(buildPath) {
  const root = path.resolve(buildPath);
  const violations = [];

  const visit = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relative = path.relative(root, fullPath);
      const normalized = relative.split(path.sep).join('/');

      // Third-party package contents are handled by Electron Packager's
      // dependency pruning and are not ForgeLink's machine-local state.
      if (normalized === 'node_modules' || normalized.startsWith('node_modules/')) continue;

      if (isPackagePrivatePath(normalized)) {
        violations.push(normalized);
        continue;
      }

      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(fullPath);
    }
  };

  visit(root);
  return violations.sort();
}

function verifyPackagePrivacyHook(buildPath, _electronVersion, _platform, _arch, callback) {
  try {
    const violations = findPackagePrivacyViolations(buildPath);
    if (violations.length) {
      const preview = violations.slice(0, 20).join(', ');
      throw new Error(
        'ForgeLink privacy guard blocked packaging because local private state was staged: ' +
        preview +
        (violations.length > 20 ? ' (+' + (violations.length - 20) + ' more)' : ''),
      );
    }
    callback();
  } catch (error) {
    callback(error);
  }
}

module.exports = {
  PACKAGE_IGNORE_PATTERNS,
  PRIVATE_FILE_PATTERNS,
  PRIVATE_DIRECTORY_PATTERN,
  isPackagePrivatePath,
  findPackagePrivacyViolations,
  verifyPackagePrivacyHook,
};
