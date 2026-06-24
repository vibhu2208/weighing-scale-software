/**
 * electron-builder configuration
 * Docs: https://www.electron.build/configuration/configuration
 */
const fs = require('fs');
const path = require('path');

const rfidBridgeExePath = path.join(__dirname, 'rfid-bridge', 'bin', 'rfid-bridge.exe');
const includeRfidBridge = fs.existsSync(rfidBridgeExePath);
const ffmpegExePath = path.join(
  __dirname,
  'node_modules',
  '@ffmpeg-installer',
  'win32-x64',
  'ffmpeg.exe',
);
const includeFfmpeg = fs.existsSync(ffmpegExePath);

module.exports = {
  appId: 'com.yourcompany.weighbridge',
  productName: 'Weighbridge Manager',
  copyright: `Copyright © ${new Date().getFullYear()} Your Company`,

  // Native modules are rebuilt via postinstall; skip rebuild here so builds
  // succeed when node-gyp cannot detect newer Visual Studio installs.
  npmRebuild: false,

  directories: {
    output: 'release',
    buildResources: 'build',
  },

  files: [
    'electron/**/*',
    'backend/**/*',
    'dist/renderer/**/*',
    'package.json',
    '!**/*.{md,map}',
    '!**/node_modules/*/{CHANGELOG.md,README.md,README,readme.md,readme}',
    '!**/node_modules/*/{test,__tests__,tests,powered-test,example,examples}',
  ],

  extraResources: [
    { from: 'database', to: 'database', filter: ['**/*'] },
    { from: 'uploads', to: 'uploads', filter: ['**/*'] },
    ...(includeFfmpeg
      ? [{ from: ffmpegExePath, to: 'bin/ffmpeg.exe' }]
      : []),
    ...(includeRfidBridge
      ? [
          {
            from: 'rfid-bridge/bin',
            to: 'rfid-bridge',
            filter: ['rfid-bridge.exe', 'ReaderAPI.dll'],
          },
        ]
      : []),
  ],

  asarUnpack: [
    '**/better-sqlite3/**/*',
    '**/ffmpeg-static/**/*',
    '**/@ffmpeg-installer/**/*',
  ],

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: '${productName}-Setup-${version}.${ext}',
    // Local/offline builds: skip Windows code signing.
    // This avoids electron-builder downloading/extracting winCodeSign,
    // which fails on machines without privilege to create symlinks.
    sign: null,
    signAndEditExecutable: false,
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Weighbridge Manager',
    perMachine: false,
    deleteAppDataOnUninstall: false,
  },

  mac: {
    target: ['dmg'],
    category: 'public.app-category.business',
  },

  linux: {
    target: ['AppImage', 'deb'],
    category: 'Office',
  },

  publish: null,
};
