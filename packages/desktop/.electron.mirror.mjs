// Electron 制品源配置（构建期），两处共用：npm install 后由 scripts/patch-electron.mjs 打进 node_modules/electron 的
// mirror-config.js（开发时下载 Electron），以及 electron-builder.config.mjs（打包时下载 Electron）。
// platforms 是开发时可下载的平台与架构；发布包只打 mac arm64 与 win x64（electron-builder.config.mjs）。
// JS 形态必须 default 导出一个返回配置对象的函数;`version` 直接取 package.json 的精确 pin,不单独维护第二份版本声明,
// 升级 Electron 只改 devDependencies 与镜像目录后缀。
import { createRequire } from "node:module";

export default function electronMirrorConfig() {
  const { devDependencies } = createRequire(import.meta.url)("./package.json");
  const version = devDependencies.electron;
  return {
    version,
    mirror: `https://mimocode-cdn.xiaomimimo.com/mimocode/mimo_electron/v${version}_11241`,
    platforms: {
      darwin: ["arm64", "x64"],
      win32: ["ia32", "x64"],
    },
  };
}
