const path = require('node:path');

const SUPPORTED_PLATFORMS = Object.freeze(['win32', 'darwin', 'linux']);
const SUPPORTED_ARCHES = Object.freeze(['x64', 'arm64']);

const RELEASE_TARGETS = Object.freeze([
  Object.freeze({ platform: 'win32', arch: 'x64', runner: 'windows-latest', artifact: 'windows-installer', makeScript: 'make:win' }),
  Object.freeze({ platform: 'darwin', arch: 'arm64', runner: 'macos-14', artifact: 'macos-installer', makeScript: 'make:mac' }),
  Object.freeze({ platform: 'linux', arch: 'x64', runner: 'ubuntu-latest', artifact: 'linux-package', makeScript: 'make:linux' }),
]);

const COMPATIBILITY_TARGETS = Object.freeze([
  ...RELEASE_TARGETS,
  Object.freeze({ platform: 'darwin', arch: 'x64', runner: null, artifact: null, makeScript: 'make:mac' }),
  Object.freeze({ platform: 'linux', arch: 'arm64', runner: null, artifact: null, makeScript: 'make:linux' }),
]);

function cliOption(name, argv = process.argv) {
  const inline = argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function normalizePlatform(value) {
  const platform = String(value || '').trim();
  if (!SUPPORTED_PLATFORMS.includes(platform)) throw new Error(`Unsupported ForgeLink target platform: ${platform || '(empty)'}`);
  return platform;
}

function normalizeArch(value) {
  const arch = String(value || '').trim();
  if (!SUPPORTED_ARCHES.includes(arch)) throw new Error(`Unsupported ForgeLink target architecture: ${arch || '(empty)'}`);
  return arch;
}

function resolveRequestedTarget({ argv = process.argv, env = process.env, hostPlatform = process.platform, hostArch = process.arch } = {}) {
  return {
    platform: normalizePlatform(cliOption('--platform', argv) || env.FORGELINK_TARGET_PLATFORM || env.npm_config_platform || hostPlatform),
    arch: normalizeArch(cliOption('--arch', argv) || env.FORGELINK_TARGET_ARCH || env.npm_config_arch || hostArch),
  };
}

function createBuildTarget({ platform, arch, root = process.cwd(), logoSource = 'logo.png' } = {}) {
  const targetPlatform = normalizePlatform(platform);
  const targetArch = normalizeArch(arch);
  const tunnelName = targetPlatform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client';
  const iconExtension = targetPlatform === 'win32' ? 'ico' : targetPlatform === 'darwin' ? 'icns' : 'png';
  const tunnelSource = path.resolve(root, 'vendor', 'tunnel-client', `${targetPlatform}-${targetArch}`, tunnelName);
  const iconPath = path.resolve(root, 'assets', 'generated', `icon.${iconExtension}`);
  const extraResource = [
    tunnelSource,
    path.resolve(root, logoSource),
    path.resolve(root, 'chatgpt-logo.png'),
    path.resolve(root, 'web'),
    path.resolve(root, 'dist-backend', 'backend-entry.mjs'),
    path.resolve(root, 'dist-backend', 'node-pty'),
    path.resolve(root, 'dist-backend', 'node_modules'),
    path.resolve(root, 'desktop', 'artifact-ui-client.bundle.js'),
    path.resolve(root, 'desktop', 'code-review-ui-client.bundle.js'),
    path.resolve(root, 'desktop', 'renderer', 'dist'),
  ];
  if (targetPlatform === 'win32') {
    extraResource.push(path.resolve(root, 'start-mcp.ps1'), path.resolve(root, 'stop-previous-mcp.ps1'));
  }
  return {
    platform: targetPlatform,
    arch: targetArch,
    key: `${targetPlatform}-${targetArch}`,
    tunnelName,
    tunnelSource,
    iconExtension,
    iconPath,
    extraResource,
    nativePty: {
      key: `${targetPlatform}-${targetArch}`,
      prebuildPreferred: targetPlatform !== 'linux',
      nativeBuildFallback: targetPlatform !== 'win32',
    },
    renderer: Object.freeze({
      root: path.resolve(root, 'desktop', 'renderer'),
      html: path.resolve(root, 'desktop', 'renderer', 'index.html'),
      entry: path.resolve(root, 'desktop', 'renderer', 'src', 'main.js'),
      style: path.resolve(root, 'desktop', 'renderer', 'src', 'style.css'),
      viteConfig: path.resolve(root, 'vite.renderer.config.mjs'),
    }),
  };
}

module.exports = {
  SUPPORTED_PLATFORMS,
  SUPPORTED_ARCHES,
  RELEASE_TARGETS,
  COMPATIBILITY_TARGETS,
  cliOption,
  normalizePlatform,
  normalizeArch,
  resolveRequestedTarget,
  createBuildTarget,
};
