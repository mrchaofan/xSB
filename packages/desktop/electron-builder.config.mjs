// Packs dist/ (see rolldown.config.js) into the apps: `npm run package`.
//
//   release/xsb-<version>-mac-arm64.zip
//   release/xsb-<version>-win-x64.zip
//
// The Electron inside is the private build, from the mirror that .electron.mirror.mjs names.
import electronMirror from "./.electron.mirror.mjs";

const { version, mirror } = electronMirror();
const cut = mirror.lastIndexOf("/") + 1;

export default {
  appId: "com.xsb.desktop",
  productName: "xsb",
  artifactName: "xsb-${version}-${os}-${arch}.${ext}",
  directories: { output: "release" },
  // dist/ is whole: Rolldown has bundled every dependency into it.
  files: ["dist/**", "package.json", "!node_modules"],
  // The hub and the MCP servers in dist/bin are started by path as programs of their own.
  asar: false,
  npmRebuild: false,
  electronVersion: version,
  electronDownload: {
    mirror: mirror.slice(0, cut),
    customDir: mirror.slice(cut),
    // The mirror publishes no SHASUMS256.txt (scripts/patch-electron.mjs downloads the same way).
    isVerifyChecksum: false,
  },
  mac: {
    target: [{ target: "zip", arch: ["arm64"] }],
    icon: "build/icon.icns",
    // No certificate. Ad-hoc ("-") is what Apple silicon needs to start a program at all.
    identity: "-",
    hardenedRuntime: false,
  },
  win: {
    target: [{ target: "zip", arch: ["x64"] }],
    icon: "build/icon.ico",
  },
};
