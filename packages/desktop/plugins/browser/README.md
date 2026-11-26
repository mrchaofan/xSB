# browser

应用右栏的内置浏览器。`server.mjs`（构建时由 `src/browser-mcp.ts` 打包到这里）只是管道：它连上应用的浏览器（`XSB_BROWSER_SOCKET`），工具和给模型的说明都在应用里（`src/browser.ts`）。
