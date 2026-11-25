// Electron 制品源配置,被 node_modules/electron/mirror-config.js(bun patch)与 scripts/builder/electron-mirror.ts 共用。
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
