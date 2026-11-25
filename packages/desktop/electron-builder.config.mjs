// Packs dist/ (see rolldown.config.js) into the app of the platform it runs on: `npm run package`.
//
//   release/xsb-<version>-mac-arm64.zip   packed on macOS (arm64)
//   release/xsb-<version>-win-x64.zip     packed on Windows (x64)
//
// The Electron inside is the private build, from the mirror that .electron.mirror.mjs names.
//
// Each app is packed on its own platform (.github/workflows/desktop.yml): what ships unbundled is what npm installed
// there, and arkcli is installed only for the platform npm runs on (`afterPack` checks the app has the one it needs).
import fs from "node:fs";
import path from "node:path";
import electronMirror from "./.electron.mirror.mjs";

const { version, mirror } = electronMirror();
const cut = mirror.lastIndexOf("/") + 1;

/** electron-builder's `Arch` enum, by value. */
const ARCH = ["ia32", "x64", "armv7l", "arm64", "universal"];

/** The app's arkcli is the one of its own platform (src/ark.ts `shippedArkcli`): an app packed elsewhere has none. */
function checkArkcli({ appOutDir, electronPlatformName: platform, arch, packager }) {
  const name = ARCH[arch];
  const os = { darwin: "darwin", win32: "windows", linux: "linux" }[platform];
  const app = platform === "darwin" ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources", "app")
    : path.join(appOutDir, "resources", "app");
  const program = path.join(app, "node_modules", "@volcengine", `ark-cli-${platform}-${name}`, "bin",
    `arkcli-${os}-${name === "x64" ? "amd64" : name}${platform === "win32" ? ".exe" : ""}`);
  if (!fs.existsSync(program)) {
    throw new Error(`${program} is missing: pack the ${platform}-${name} app on that platform, after npm install there`);
  }
}

export default {
  appId: "com.xsb.desktop",
  productName: "xsb",
  artifactName: "xsb-${version}-${os}-${arch}.${ext}",
  directories: { output: "release" },
  // dist/ holds the code, every build dependency bundled into it (rolldown.config.js). The production dependencies of
  // package.json, the `optionalDependencies` (arkcli of each platform, of which npm installs the one it runs on), are
  // what ships unbundled, as published: electron-builder copies them into node_modules beside dist/.
  files: ["dist/**", "package.json"],
  afterPack: checkArkcli,
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
