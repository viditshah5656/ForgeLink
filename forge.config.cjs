const branding = require('./branding.json');
const { verifyPackagePrivacyHook } = require('./desktop/package-privacy.cjs');
const { resolveRequestedTarget, createBuildTarget } = require('./desktop/build-targets.cjs');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

const requestedTarget = resolveRequestedTarget();
const buildTarget = createBuildTarget({
  ...requestedTarget,
  root: process.cwd(),
  logoSource: branding.logoSource,
});
const { platform, arch, tunnelSource, iconPath, extraResource } = buildTarget;

module.exports = {
  packagerConfig: {
    asar: true,
    // Let Electron Forge's Vite plugin install its required /.vite-only
    // packaging filter. ForgeLink's privacy verifier stays fail-closed
    // immediately before ASAR creation and rejects any staged private state.
    beforeAsar: [verifyPackagePrivacyHook],
    executableName: branding.executableName,
    icon: iconPath,
    extraResource,
    appBundleId: branding.bundleId,
    appCategoryType: 'public.app-category.developer-tools',
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: branding.executableName,
        setupExe: 'ForgeLink-Setup.exe',
        setupIcon: iconPath,
        noMsi: true,
      },
    },
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'linux'] },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: { name: branding.productName, format: 'ULFO', icon: iconPath },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        concurrent: false,
        build: [
          { entry: 'desktop/main.mjs', config: 'vite.main.config.mjs' },
          { entry: 'desktop/preload.mjs', config: 'vite.preload.config.mjs' },
        ],
        renderer: [{ name: 'main_window', config: 'vite.renderer.config.mjs' }],
      },
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
