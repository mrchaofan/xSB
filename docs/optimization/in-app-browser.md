# In App Browser：受控标签、turn 下载清单与操作提示

## 最终行为

- 网站 `window.open` / `target=_blank` 一律进入应用管理的标签，无论有无 AI，不创建独立 Electron 窗口。AI 可以用普通页面工具新开、切换、关闭标签；独立窗口只由明确的 UI/工具请求创建。
- 当前 Agent turn 内，关联页面持续接管 Chromium 下载，不依赖模型用了哪个点击、按键、提交或导航工具。
- 文件保存到项目预设路径 `.xsb/downloads/`，保留安全的默认名字，重名为 `report (1).csv`、`report (2).csv`，不覆盖旧文件或进行中的下载。
- `browser_downloads_list` 立即列当前 turn 的下载；`browser_downloads_progress(id)` 立即查询单条进度。模型按需 sleep 后再查询，工具本身不等待，也不增加模型轮次。
- 新 turn 清空可见清单，磁盘文件保留。上一轮进行中的下载之后完成，也不会重新进入新清单；旧 id 无法通过新 turn 的进度接口读取。
- Agent 控制网页时，显示红色呼吸边框及“Agent 正在操作网页”，阻止用户鼠标、键盘操作；turn 结束或停止后解除。Agent 的 CDP 输入和截图继续正常工作。

## 页面与输入控制

`Pages` 统一拥有 WebContents、标签及页面窗口。所有网页都是主进程创建的 webview2 内容，由应用自己的宿主页面用 `<webview2>` 显示：右栏在 `index.html`，独立窗口在 `page.html`。两处都用 `renderer/webview.js`，`<webview2>` 与叠在它上面的蒙层、批注都是宿主页里的 DOM 元素，没有原生视图。

网站弹出的页面同样如此：Chromium 预先创建的弹出 guest 不能挂到 `<webview2>`，所以拦下弹出，在新建的 webview2 里发出同一个请求（地址、来源、POST 数据）。代价是弹出页没有 `window.opener`：靠它回传结果的登录弹窗、先开 about:blank 再写内容的弹窗不可用；空白弹窗不会打开。模型只看到自身连接关联的页面；用户和其他 Agent 的页面不进入工具清单。HTML 制品预览继续使用独立分区，不把制品访问权限传给外部网站。

控制提示由 `renderer/page-control.js` 的 DOM 蒙层显示，盖住整个网页，提供红色发光边框、呼吸动画和本地化标签；系统偏好减少动态效果时关闭动画。它接住用户的鼠标、滚轮、拖放，且不带走焦点。

Debugger 截图统一由 `Pages.drawn` 提供渲染承载。已经挂载的网页在原处截图；未挂载的 Tab 临时挂入独立的 800×600 小窗口，创建时 `show: false`，挂载完成后仅调用 `showInactive()`。小窗口不可聚焦、忽略鼠标输入、不进入任务栏，截图成功或失败都销毁承载窗口并保留网页。主窗口的宿主 DOM、当前标签和输入焦点不参与截图挂载。截图工具在挂载之前启用焦点模拟；窗口无需成为前台窗口，宿主主窗口隐藏时也可截图。

新 Tab 的焦点由打开来源决定：用户打开的 Tab 自动选中并聚焦网页，空白新 Tab 随后聚焦地址栏；Agent 通过 debugger 打开的 Tab 和操作期间产生的弹出 Tab 标记为 `background`，自动切换展示并展开右栏，但不聚焦网页、地址栏或宿主窗口，保留用户当前输入焦点。已有页面的加载、标题和控制状态更新不再次切换标签或聚焦网页；`browser_select` 只切换 Agent 后续操作的目标，截图也不改变当前展示。

还安装主进程输入保护：用户键盘事件被阻止，可信 CDP 输入按 Chromium 的 debugger 来源标志放行；CDP 鼠标命令在受控注入窗口内放行，物理用户输入由上层 DOM 蒙层截住。没有使用 `Input.setIgnoreInputEvents`，因为它也会阻止 Agent 的 CDP 输入。页面地址栏的导航、后退、前进、刷新等操作在控制中同样被拒绝，关闭标签、停止任务等应用控制仍可用。

停止或退出 turn 立即撤销输入保护并撤下蒙层。蒙层是应用自己的内容，不属于网站、Agent 的页面列表或模型的页面快照。

## turn 边界与职责

```mermaid
flowchart LR
  H[Hub / LiveSession：真实 turn 开始、结束、停止] --> C[只读 ToolContext 通道]
  C --> B[BrowserSession：当前 turn 与页面归属]
  B --> P[Pages：标签、网页、输入保护]
  P --> D[Chromium will-download / done]
  D --> L[BrowserDownloads：文件、清单与实时进度]
  L --> F[项目 .xsb/downloads]
  M[模型] --> Q[list / progress 普通工具调用]
  Q --> L
  L --> Q
  Q --> M
```

这里的 turn 是 `LiveSession.current.id` 的运行周期，不是每个工具调用，也不是每次 LLM 请求。一次 Agent turn 可以执行许多工具和 sleep，共用一份下载清单。

每个 stdio 工具服务获得独立的只读运行时凭据，绑定确定的 agent/session/server。`ToolContext.attach/current/changed` 提供实际 turn id、active 状态和近期 turn 起止区间；权限不能调用团队工具、写收件箱或发起模型请求。浏览器订阅的是运行时边界，代码接收通知，模型不用监听事件。所有权不是根据 cwd、前台标签或最近一次点击猜测。

Hub 的当前 turn 开始、结束和停止会更新浏览器：

- 开始：当前 turn 的可见清单从空开始，关联网页进入操作锁定状态。
- 结束：停止提供当前 turn 清单，解除网页输入锁定。
- 新 turn：旧下载记录不会进入新清单，旧下载完成回调仍能保存文件，但不能重新填充清单。
- 延迟到达的边界通知：下载开始时间与运行时起止区间核对，修正边界尚未同步时的归属。记录一旦对应旧 turn，其完成时不会改用新 turn。

MCP 连接内串行执行页面工具，每页独立保存 accessibility 编号和快照。下载监听独立于这些调用，因此点击返回后、sleep 期间或其他工具运行期间发生的下载仍被记录。

## 两个小接口

### browser_downloads_list

参数只有可选的 `from`，用于 20 条一页的清单分页。立即返回当前 `turnId`、预设 `directory`、`total` 及下载摘要：

```json
{
  "turnId": "turn_123",
  "directory": "/project/.xsb/downloads",
  "downloads": [
    { "id": "download-id", "filename": "report.csv", "state": "progressing" }
  ],
  "total": 1,
  "from": 0
}
```

完成的摘要才有 `path`；失败的摘要带 `error`。没有 `waitMs`、点击参数或睡眠参数。

### browser_downloads_progress

参数只有当前 turn 中的下载 `id`，立即返回该记录的状态、字节数、百分比、观测区间内速率、暂停状态、Chromium transferState 和 done：

```json
{
  "id": "download-id",
  "filename": "report.csv",
  "state": "progressing",
  "receivedBytes": 4096,
  "totalBytes": 8192,
  "percent": 50,
  "bytesPerSecond": 2048,
  "paused": false,
  "transferState": "progressing",
  "done": false
}
```

未知总大小/百分比/速率使用 `null`。首次查询没有区间测速；速率以两次查询之间实际收到的字节变化计算。完成或失败后不再依赖 DownloadItem 对象，仍可在本 turn 查询终态。`done` 表示原生下载结束或准备阶段失败；路径只在验证成功的 completed 状态提供。

模型的可组合流程为：

1. 预期导出前查询 list 取得基线。
2. 使用普通 click/type/press_key/navigate 等工具；不必事先准确知道哪个动作会产生下载。
3. 按任务需要 sleep 后再 list，用新增 id 发现文件。
4. 对指定 id 调用 progress，根据实际进度决定继续 sleep、分析完成文件或排查失败。

空清单只能表示“目前没有观察到下载”，不代表以后不会有下载。等待时长由模型根据页面反馈和任务期限决定；接口不添加固定探测时间，也不凭空预测完成时间。

## 文件生命周期

在 `will-download` 内同步准备保存目录和文件名，调用 `setSavePath`，回调返回前完成接管。磁盘路径不可写时阻止默认下载流程并记录失败，不退回系统保存弹窗。保留 Chromium 的 cookie、重定向、POST 导出和 blob 下载，不重新发 HTTP 请求。

文件名过滤目录分隔符、控制字符、Windows 保留名和超长字节序列，其余默认名字保留。文件名使用 `open(..., 'wx')` 原子预留，多个页面、会话和进程不会抢到同一名字。预留文件不等于完成文件；`path` 在 done completed 后验证目标为真实文件、有有效内容时才交付。失败释放自身预留路径。

清单元数据放在 `.xsb/downloads/.records/<连接 UUID>/manifest.json`，start/finish/归属修正时原子替换，进度查询直接读 Chromium，不逐块写 manifest。来源只保留 origin，不记录签名 URL query、fragment 或凭据。下载不自动执行或打开。

直接导航下载地址可能先报 ERR_ABORTED/ERR_FAILED，再触发原生下载事件。这里只针对已失败的文档加载短暂关联同一页面的实际 transfer，避免误报下载导航；普通点击不会为探测下载额外等待。

turn 结束不删除下载文件；已经开始的下载可继续完成。应用重启不恢复旧 pageId 或旧 turn 的可见清单，manifest 中的 progressing 不能被宣称为已完成。

## 已撤销的机制

没有 click_download / click_and_wait 专用接口，没有下载等待工具，没有完成事件的模型插话、收件箱投递或自动唤醒。先前实验性的事件发布凭据、通知重试 outbox 和自动投递代码已移除。保留下来的跨进程通道只有只读 turn 身份与生命周期。

## 验证

- `npm run typecheck`
- `npm test -w @xsb/desktop`
- `npm test -w @xsb/hub`
- `npm run test:browser-native -w @xsb/desktop`：项目私有 Electron，独立临时目录/profile，仅访问 localhost。

覆盖：默认名与并发 `(1)` 后缀、预留不交付半成品、查询实时字节及未知进度、新 turn 空清单、旧 id 拒绝、旧 transfer 晚完成不串入、只读凭据不发模型消息、真实 Hub turn id 改变。

真实 Electron 覆盖：用户鼠标/键盘被阻止而 CDP 点击/输入/Enter/截图正常，红色呼吸动画及中文标签，turn 解除后恢复用户键盘，弹出页是 webview2 标签、不增加 BrowserWindow，来源与 POST 保留，POST/blob/直接下载保存，慢速文件的 50% 进度及跨 turn 晚完成，显式独立窗口移动和还原。
