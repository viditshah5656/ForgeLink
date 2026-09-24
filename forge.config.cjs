const path = require('node:path');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

const platform = process.platform;
const arch = process.arch;
const tunnelName = platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client';
const tunnelSource = path.resolve('vendor', 'tunnel-client', `${platform}-${arch}`, tunnelName);
const iconPath = path.resolve('assets', 'generated', platform === 'win32' ? 'icon.ico' : 'icon.icns');

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'LocalFilesForChatGPT',
    icon: iconPath,
    extraResource: [tunnelSource, path.resolve('web'), path.resolve('dist-backend', 'backend-entry.mjs'), path.resolve('desktop', 'renderer', 'dist')],
    appBundleId: 'com.viditshah.localfileschatgpt',
    appCategoryType: 'public.app-category.developer-tools',
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'LocalFilesForChatGPT',
        setupExe: 'Local-Files-for-ChatGPT-Setup.exe',
        setupIcon: iconPath,
        noMsi: true,
      },
    },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: { name: 'Local Files for ChatGPT', format: 'ULFO', icon: iconPath },
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
