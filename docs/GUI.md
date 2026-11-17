# xsb 桌面端界面设计

桌面端是 [@xsb/desktop](../packages/desktop)，一个 Electron 应用。界面是纯 HTML / CSS / JS，无框架。主进程和渲染进程的代码都由 [Rolldown](https://rolldown.rs)（Rust 实现的打包工具）打进 `dist/`，Electron 运行的是打包产物；`npm start` 会先打包。

```bash
npm start -w @xsb/desktop
```

| 文件 | 内容 |
| - | - |
| [renderer/index.html](../packages/desktop/renderer/index.html) / [styles.css](../packages/desktop/renderer/styles.css) | 窗口骨架与全部样式 |
| [renderer/main.js](../packages/desktop/renderer/main.js) | 界面的入口 |
| [renderer/app.js](../packages/desktop/renderer/app.js) | 窗口本身：打开工作区、左栏、对话栏、制品栏 |
| [renderer/dom.js](../packages/desktop/renderer/dom.js) | 造 DOM 的小工具和图标 |
| [renderer/text.js](../packages/desktop/renderer/text.js) / [renderer/i18n.js](../packages/desktop/renderer/i18n.js) | 界面的全部文字，每种语言一张表；取词函数 `t`，以及把静态页面里的 `data-t` 换成文字 |
| [renderer/content.js](../packages/desktop/renderer/content.js) | 内容在界面上的投影：剪贴板 → 内容、内容 ⇄ 输入框、内容 → 对话（含 markdown 渲染） |
| [renderer/form.js](../packages/desktop/renderer/form.js) | 表单与对话框的小工具 |
| [renderer/settings.js](../packages/desktop/renderer/settings.js) / [preferences.js](../packages/desktop/renderer/preferences.js) | 分层设置与界面偏好保存：全局设置跨窗口同步，工作区偏好按文件夹隔离 |
| [renderer/agent.js](../packages/desktop/renderer/agent.js) | Agent 的创建、编辑、删除；重启确认；系统说明预览 |
| [renderer/team.js](../packages/desktop/renderer/team.js) | 角色的编辑；产出总览 |
| [renderer/mock.js](../packages/desktop/renderer/mock.js) | 假的 `window.xsb`：在浏览器里直接打开 `dist/renderer/index.html` 时用，界面可以脱离 Electron 和 Hub 运行 |
| [src/preload.cjs](../packages/desktop/src/preload.cjs) | 真的 `window.xsb`：每个方法是一次到 main 的 IPC 调用 |
| [src/main.ts](../packages/desktop/src/main.ts) | 窗口，以及只有操作系统能做的事（选文件夹、制品协议、在访达中显示） |
| [src/bridge.ts](../packages/desktop/src/bridge.ts) | main 与界面之间的契约：`window.xsb` 返回的形状和事件。只有类型 |
| [src/workspace.ts](../packages/desktop/src/workspace.ts) | 一个项目到 Hub 的 ACP 连接，以及线上数据到界面数据的转换 |
| [src/content.ts](../packages/desktop/src/content.ts) | 内容：对话里"说了什么"的唯一形状，见第 3 节 |
| [src/clis.ts](../packages/desktop/src/clis.ts) | 各家 agent 自己的程序：在 PATH 上检测、记住用户指定的路径、做成 Hub 能启动的后端，见第 8 节 |
| [src/pages.ts](../packages/desktop/src/pages.ts) | 右栏的网页和它们的独立窗口，见第 3.1 节 |
| [src/browser.ts](../packages/desktop/src/browser.ts) / [src/browser-mcp.ts](../packages/desktop/src/browser-mcp.ts) | browser use：桌面端作为 MCP server，以及 Agent 一侧的管道，见第 3.2 节 |
| [renderer/pages.js](../packages/desktop/renderer/pages.js) / [renderer/webview.js](../packages/desktop/renderer/webview.js) / [renderer/page-window.js](../packages/desktop/renderer/page-window.js) | 右栏的标签与网页、`<webview2>` 的挂载、独立窗口的页面 |
| [renderer/presets.js](../packages/desktop/renderer/presets.js) | 预设团队面板，见第 4.1 节。团队本身在 [packages/hub/presets/](../packages/hub/presets)，由 Hub 读取 |
| [src/roles.ts](../packages/desktop/src/roles.ts) | 角色在 Hub 的形状与编辑界面的形状之间的两个纯函数 |
| [rolldown.config.js](../packages/desktop/rolldown.config.js) | 打包配置 |

打包产物一个程序一个文件，目录布局与源码相同（代码在一个目录，页面在 `../renderer`，Hub 的两个程序在 `../bin`），所以代码里按相对位置找文件的地方打包前后都成立：

```
dist/app/main.js          主进程（含 Hub 的客户端一侧）
dist/app/preload.cjs      preload
dist/bin/xsb-hub          Hub 守护进程，由主进程作为独立进程启动
dist/bin/xsb-mcp-bridge   MCP 桥，由 Hub 为每个后端会话启动
dist/bin/claude-agent-acp claude 的 ACP 封装（开源包，打进应用）
dist/bin/codex-acp        codex 的 ACP 封装（同上）
dist/bin/xsb-media-mcp    图片与视频生成 MCP server
dist/presets/             预设团队（@xsb/hub 的 presets/，Hub 在自己代码的旁边找到它）
dist/renderer/            页面：index.html、styles.css、打成一个文件的 main.js，以及 mock.js
```

## 1. 窗口的三种样子

一个工作区（一个含 `.xsb/` 的文件夹）一个窗口。窗口在任一时刻是下面三种之一，由 `<body>` 上的一个 class 决定：

| 状态 | 显示 | 何时 |
| - | - | - |
| 没有工作区 | 欢迎页：打开文件夹、最近打开的工作区 | 新窗口 |
| 对话 | 左栏 + 对话栏 + 制品栏 | 打开工作区之后的默认状态 |
| 页面 | 左栏 + 一个页面（角色编辑或产出总览），占用对话栏和制品栏的位置 | 从设置进入角色编辑，或点左栏底部的"团队产出" |

主窗口只展示高频工作：智能体对话、创建智能体、任务和产出。左栏底部保留“团队产出”和“设置”入口；角色列表、预设团队入口以及对话栏里的智能体编辑按钮移入设置。

设置可从左栏底部、工作区名称或 `⌘,` / `Ctrl+,` 进入，`Esc` 返回原对话，输入草稿保留。尚未打开工作区时，标题栏设置按钮可打开全局设置。

| 范围 | 分类 | 内容 |
| - | - | - |
| 全局 | 外观与对话 | 浅色（默认）、深色、跟随系统；舒适/紧凑密度；工具调用显示开关 |
| 全局 | 模型后端 | 可用后端与缺失程序的路径选择，在欢迎页也可使用 |
| 工作区 | 工作区偏好 | 名称、文件夹、另开工作区；是否显示已完成/取消任务（默认隐藏，失败始终显示） |
| 工作区 | 智能体管理 | 配置、删除智能体与系统说明预览；新建表单把头像、补充说明、工作目录折叠为高级选项 |
| 工作区 | 角色与技能 / 预设团队 | 编辑共享说明、技能、MCP，选择团队；编辑时保留设置导航 |

界面采用浅灰紫底色、白色内容面板和紫色强调色。运行中使用紫点，待授权使用琥珀色菱形，状态仍保留文字和形状。宽度不超过 1000px 时，产出默认收起，按标题栏按钮或点击产出可展开为侧面板，保证对话可读。

界面偏好保存在应用源 `app://xsb` 的 localStorage，全局键为 `xsb.ui.global`，工作区键含工作区路径。全局偏好通过 storage 事件同步各窗口；工作区偏好只影响该文件夹在本机的界面，不写入团队的 `.xsb/` 配置。角色和智能体仍使用现有 Hub 保存接口，并需显式保存。

### 对话区：最多两栏

对话区默认只有一栏，最多两栏并排、平分宽度。点左栏的智能体（或 ⌘1…⌘9、点任务）时：

| 当前 | 结果 |
| - | - |
| 它已经显示着 | 不变，只把输入框聚焦 |
| 只有一栏，没固定 | 换掉这一栏 |
| 只有一栏，固定了 | 分屏：它成为第二栏 |
| 已有两栏 | 换掉第二栏。第一栏固定与否都不动 |

- 只有第一栏的栏头有"固定"按钮，再点一次取消。第二栏没有。
- 两栏时取消固定，两栏都留着；之后切换变的仍然只是第二栏。
- 关掉第一栏，第二栏成为第一栏，并且是不固定的；关掉第二栏，回到一栏。
- 被换掉的那一栏只是不显示了：智能体照常工作，对话记录还在，再点回来就是原样。输入框里没发出去的草稿不保留。

### 应用、窗口与 Hub 的生命期

- **应用只运行一个。** 再启动一次不会开出第二个：已在运行的那个被带到前台；带着文件夹启动（`xsb <文件夹>`）则在它里面为这个文件夹开一个窗口。要打开的文件夹作为数据交给先启动的那个，不靠命令行：Chromium 会重排交过去的命令行。
- **关窗口不等于退出。** 还有别的窗口时，关掉的那个真的关闭；只剩一个时，关它只是隐藏，工作区、对话、正在进行的任务都保持原样。再点程序坞图标或再启动一次，它回到前台。
- **退出应用才结束。** 退出时，这次运行期间打开过的每个工作区的 Hub 都被通知停止（包括窗口已经关掉的那些）。
- **有智能体在工作时，退出先问一句。** 对话框写明谁还在工作、退出的后果，默认按钮是"继续工作"。选"仍然退出"，没做完的工作就此放弃：再次打开时什么都不会自动重跑，没结束的任务记为已取消，派发它的智能体不会收到通知（那会是新的一轮），要用户重新交代（DESIGN.md 第 7 节）。窗口已关掉、Hub 还在运行的工作区也在询问范围内：关窗口时到 Hub 的连接留着（只是不再回答权限请求），退出时据此知道那里还有谁在工作。
- 因此换新版本时退出应用就够了，不会再有旧版 Hub 留在后台被新应用连上。由命令行（`xsb`）启动、应用从没打开过的工作区的 Hub 不归应用管。

### 系统通知

用户不在看 xsb 时，四件事用系统通知告诉他（[notices.ts](../packages/desktop/src/notices.ts)；什么时候算哪一件，由 [workspace.ts](../packages/desktop/src/workspace.ts) 判断）：

| 通知 | 什么时候 |
| - | - |
| 完成 | 工作区从"有人在工作"变成"没有智能体在工作、也没有未结束的任务"。一件事经过几个智能体，只在最后一个停下时通知一次，标题是最后停下的那个 |
| 失败 | 一个任务（或后台作业）失败；用户发出的消息没能成为一轮或这一轮出错 |
| 需要确认 | 智能体调用了中枢的 `ask_user`：工作要等用户拍板才能继续。问题本身照常写在它的回复里，这个工具只负责让用户知道 |
| 需要授权 | 智能体的工具调用要用户批准（`session/request_permission`） |

- **不重复**：智能体请用户确认过，或用户点了停止，之后工作区变空闲不再报"完成"；中枢断开也不报。
- **只在用户没在看时**：工作区所在的窗口在前台并且有焦点，就不发，因为界面上已经能看到。窗口被关掉（隐藏）时照常发。
- **点一下**：把那个窗口带到前台，打开对应智能体的对话。
- **macOS 和 Windows 的差别**只在系统怎么认出通知是谁的。macOS 认应用的 bundle id，第一次发通知时系统会问用户是否允许，用户不允许就什么也不显示。Windows 认 AppUserModelID，而且开始菜单里必须有一个带同一个 ID 的快捷方式，否则通知不显示。应用以 zip 发布，没有安装程序替它建快捷方式，所以每次启动时自己在开始菜单写一个 `xsb.lnk`，指向这次运行的位置（zip 可能被解压到别处），ID 用 electron-builder 的 `appId`（`com.xsb.desktop`）。从源码直接运行（`npm start`）时不建快捷方式，在 Windows 上也就没有通知。通知对象在被点击或关闭之前都保留着引用，避免被回收后点击失效。

### 打开工作区

- 欢迎页有两条路：点"打开文件夹…"（系统的选择文件夹对话框），或点最近打开的一项。
- 选中的文件夹还没有 `.xsb/` 时不会悄悄创建，而是在原处问一句"还不是工作区"，确认后才创建。
- 新建的工作区没有 Agent，中间只有一句话和"新建 Agent"按钮。
- 已有工作区的窗口里，点标题栏的工作区名会开一个新窗口（回到欢迎页），不替换当前窗口。

## 2. 黑白下怎么区分东西

只有两个颜色变量 `--paper` 和 `--ink`，其余灰度都由它们混出来，深色模式只是交换这两个值。信息靠形状和位置表达，唯一的例外是标题栏里工作区名字旁的连接圆点：

| 要表达的 | 做法 |
| - | - |
| 与 Hub 的连接 | 工作区名字旁的圆点：绿色连着，红色断了。断了的时候点它重新连接（Hub 没在运行就启动它），窗口按最新的状态重画 |
| Agent 是谁 | 应用自带的头像；名称仍显示在旁边。智能体头像 → 角色头像 → 默认猫头鹰，详见 [头像资源](avatars.md) |
| Agent 状态 | ○ 空闲　● 正在工作（呼吸）　◆ 在等你批准 |
| 这句话是谁说的 | 你说的：靠右的灰底块。同事派来的任务、Hub 送回的任务结果：靠左、带一道竖线和来源。Agent 自己的输出：不加装饰 |
| 排队 / 插话 | 消息下方的小字；排队中的消息半透明 |
| 制品 | 工具调用下面的文件按钮；正在右栏查看的那个反色显示 |
| 需要你决定的事 | 黑色边框的块：对话里的权限请求、保存后的生效提示、总览里的缺口（◆） |

## 2.1 语言

界面语言跟随系统语言（`app.getPreferredSystemLanguages()`），目前有简体中文和英文，其他语言显示英文。

- **文字只在一处**：[text.js](../packages/desktop/renderer/text.js) 里每种语言一张表，键相同。代码里不写给人看的文字，只写 `t("键", { 变量 })`；静态页面用 `data-t`、`data-t-title` 等属性，启动时换上。键不存在时显示键本身，漏掉的一眼能看到。
- **语言由主进程给**：preload 在页面画出任何东西之前同步取得，作为 `window.xsb.language`。
- **报错在主进程措辞**：Hub 的报错带原因和事实（DESIGN.md 2.5），主进程按界面语言说成一句话再交给页面，页面原样显示。后端自己的话（工具标题、启动失败时的输出）不翻译。
- **标识符不当名字用**：角色显示团队给的名字（"导演"而不是 `director`），资产类型显示团队给的名字（"镜头表"而不是 `shot_list`）；工作区自己建的角色和类型没有另外的名字，显示它本身。需要用户输入的地方（技能产出的资产类型）仍是标识符。
- **中文译名**：Agent 叫智能体，skill 叫技能，MCP server 叫工具服务，id 叫标识，Hub 叫中枢；资产库里的东西叫资产，右栏预览的文件叫制品。`PATH`、各后端和程序的名字保留原文。本文档其余部分仍沿用旧叫法。
- 项目的工作语言（智能体说什么语言、读哪一份预设）是另一回事，见 DESIGN.md 3.4：窗口第一次打开一个项目时把界面语言报给 Hub，项目据此定下来。

## 3. 对话与制品

### 内容：对话的标准数据

对话里任何一方说的话（你、其他 Agent、模型）都是同一种数据：**一组有序的 ACP 内容块**（[content.ts](../packages/desktop/src/content.ts)）。没有定义新格式：它就是 `session/prompt` 的输入和 `agent_message_chunk` / `user_message_chunk` 携带的东西。

| 块 | 含义 |
| - | - |
| `{ type: "text", text }` | 文本，按 markdown 理解 |
| `{ type: "image", mimeType, data }` | 图片，带字节（base64） |
| `{ type: "resource_link", uri, name, mimeType?, size? }` | 文件，只带引用 |
| 其他类型 | 原样保留，显示类型名，不丢弃 |

其余的一切都是内容的投影，一共五个：

```
剪贴板 ──fromClipboard──▶ ┌──────┐ ──（恒等：内容就是 prompt）──▶ 模型
输入框 ◀──insert / read──▶ │ 内容 │ ◀──append（逐块合并流式输出）── 模型
                          └──────┘ ──contentView──▶ 对话
```

| 投影 | 规则 |
| - | - |
| 内容 → 模型 | 不转换，内容直接作为 `prompt`。后端不能读图时由 Hub 在链路末端降级（DESIGN.md 2.2），对话记录里仍是原图 |
| 模型 → 内容 | 流式到达的块依次追加；文本接在文本后面就是续写同一块 |
| 剪贴板 → 内容 | 有文件时：图片成为 `image`，其他文件成为 `resource_link`（路径由 preload 取得）；没有文件时取纯文本成为 `text`。拖放走同一个函数 |
| 内容 ⇄ 输入框 | 输入框是一个只接受纯文本的可编辑区域。文本就是文本（markdown 源码）；其余的块是一个不可编辑的小方块，可以像一个字符那样被光标越过、删除，位置保留。读出时按节点顺序还原成内容，首尾空白不算 |
| 内容 → 对话 | 文本按 markdown 渲染（marked），再经 DOMPurify 过滤：脚本和外链图片都去掉。图片显示本身，文件显示名字 |

对话里的链接不会让窗口跳走：本地文件链接和文件附件在右侧制品栏打开，http(s) 链接在右侧网页标签打开（不支持内嵌网页的平台交给系统浏览器）。本地链接支持绝对路径、相对路径、`file://`、制品 URL 和行号后缀；对话里的相对路径按智能体工作目录解析，文档预览里的相对路径按文档所在目录解析。尚未登记的文件在点击时登记为制品，打不开时在原文旁显示原因。

消息下方的复制按钮复制 Markdown 原文；代码块右上角的按钮只复制代码。选中的正文也能通过快捷键或右键菜单复制。流式消息完成后显示整条消息的复制按钮。

### 发消息

发消息的规则直接来自 Hub 的回合语义（DESIGN.md 3.1）：**默认不是插话**。每条对话栏有自己的输入框，所以"发给谁"由位置决定。输入框旁只有一个按钮，它此刻是什么由两件事决定：智能体是否在工作，输入框里有没有内容。

| 智能体状态 | 输入框有内容：↩ 或按钮 | 输入框为空：按钮 |
| - | - | - |
| 空闲 | 发送，开始一轮 | 发送（没有内容，不做事） |
| 正在工作 / 在等你批准 | 发送，排到这一轮之后 | 停止这一轮 |

- **排队的消息**在对话里半透明显示，带"排队中"和一个"立即发送"。点"立即发送"，这条消息不再等，插进正在进行的这一轮；Hub 按消息的标识认出它是同一条，所以它不会之后再作为单独一轮执行一次（DESIGN.md 3.1）。智能体在等你批准时不能插话，这时不显示"立即发送"。
- **排队标识何时去掉**：Hub 把消息交给模型的那一刻会把它回送给窗口（`dev.xsb/origin`），窗口用回送的那条替换等待中的那条。轮到它自己开始一轮时不带标记；是插进去的，带"插话"。
- ⌘↩ 仍是"直接插话"：智能体在工作时不排队，立刻插进当前这一轮。
- **停止点一次就够**：排队中的消息随这一轮一起放弃，插话里模型还没看到的也放弃（DESIGN.md 3.1）。被放弃的消息留在对话里，划线、半透明，带"已丢弃"，悬停说明模型没有看到它。

### 输入框下面的状态

智能体有一轮在进行时，输入框下面写着它此刻在做什么，以及已经持续了多久（每秒更新）：

| 显示 | 何时 |
| - | - |
| 等待模型响应 | 消息已交给模型、或工具结果已交回模型，还没有任何输出 |
| 推理中 | 后端在送思考内容（`agent_thought_chunk`）。不送思考内容的后端不会出现这一项 |
| 正在回复 | 在输出文字 |
| 工具调用中：<工具标题> | 有工具调用还没结束；并行多个时写最后开始的那个 |
| 在等你批准 | 有权限请求没有回答（不计时） |

这是主进程从 `session/update` 推出来的（[workspace.ts](../packages/desktop/src/workspace.ts) 的 `does`），Hub 没有为它加任何东西。"等待模型响应"后面的时间就是模型接口这一次已经让人等了多久：接口卡住时，这里是唯一看得出来的地方。

制品 = Agent 通过工具调用写出的文件。新制品不会抢占右栏，点了才切换。

制品面板默认显示可搜索的目录，按最近更新排序。可按图片、视频、文档与代码、成员和来源（已登记资产 / 工作文件）筛选，也可按名称排序；搜索匹配名称、路径、资产描述和成员名称。图片显示缩略图。同一资产的版本合并为一项，默认打开最高版本；不同路径的工作文件仍各自保留。预览顶部提供明确的「全部制品」返回入口、上一项 / 下一项和资产版本选择，返回后保留搜索、筛选和列表滚动位置。新制品到达时更新目录，不会抢走搜索框焦点。

| 类型 | 预览 | 源码 |
| - | - | - |
| markdown | 渲染后的文档 | 带行号 |
| html | 一个网页（见 3.1），脚本照常运行 | 带行号 |
| image | `<img>` | 无 |
| video（mp4、m4v、mov、webm） | `<video>`，可拖动进度 | 无 |
| text（代码、csv 等） | 无 | 带行号 |

每个制品只有一个 `url`，图片和视频直接交给 `<img>` / `<video>`，文本用 `fetch(url)` 读，预览器不需要"读文件"的接口。视频是按范围读取的，`xsb-artifact://` 对范围请求回 206（[main.ts](../packages/desktop/src/main.ts) 的 `serveFile`），否则 `<video>` 不播放。

### 3.1 右栏的网页

右栏顶上是一排标签：第一个是制品，其余每个是一个网页。

- **网页归主进程所有**（[pages.ts](../packages/desktop/src/pages.ts)）：用私有 Electron 的 `webContents.create({ type: "webview2" })` 创建，界面只用 `<webview2 web-contents-id>` 把它显示出来（[webview.js](../packages/desktop/renderer/webview.js)）。元素移走不影响网页，所以切换标签、收起右栏都不会让网页重新加载。
- **地址**：地址栏和 Agent 的 `browser_navigate` 用同一条规则（`Pages.navigate`，补全由 `address.ts` 实现）：没写协议的按网站处理，补 `https://`（`localhost`、`127.0.0.1` 补 `http://`，本机服务通常没有证书）；支持 `http`、`https`、绝对路径和 `file://` 本地文件；其他协议不打开，原因显示在地址栏上。
- **从哪来**：标签栏的"＋"；对话和文档里的 http(s) 链接（不再跳到系统浏览器，地址栏旁有"在浏览器中打开"）；网页自己打开的新窗口；Agent（见 3.2）。
- **独立窗口**：地址栏旁的按钮把当前网页移到它自己的窗口里，是同一个网页，不刷新。此时标签的内容区显示"在主窗口中展示"和"显示窗口"；独立窗口的标题栏是网页标题、置顶、"在主窗口中显示"。关掉独立窗口就关掉了这个网页和它的标签。
- **隔离**：网页用单独的持久分区（`persist:xsb-web`），与应用自己的页面不共用 cookie；沙箱、无 preload；网站申请权限（摄像头、定位、通知）一律拒绝。HTML 制品的预览是一个不进标签栏的网页，用另一个分区，只有它能读 `xsb-artifact://`，网站读不到制品。
- **没有 `<webview2>` 的 Electron**（官方版，如 Linux）：没有标签栏，链接仍然交给系统浏览器，HTML 制品退回到不执行脚本的 iframe。

### 3.2 browser use：Agent 使用右栏的浏览器

```
agent ──stdio MCP──▶ xsb-browser-mcp（管道）──unix socket──▶ 桌面端主进程（MCP server）──CDP──▶ 网页的 WebContents
```

- **桌面端自己是 MCP server**（[browser.ts](../packages/desktop/src/browser.ts)），在 `<userData>/backends/browser.sock` 上监听（权限 0600）。只有主进程能在右栏开标签、拿到背后的 WebContents，所以工具必须由它提供。
- **`xsb-browser-mcp` 只是管道**（[browser-mcp.ts](../packages/desktop/src/browser-mcp.ts)），和 `xsb-mcp-bridge` 一个思路：告诉桌面端自己的工作目录，之后原样转发。它随应用自带，由应用放到 PATH 上。
- **每个 Agent 都有，不看角色**：浏览器是应用的基础能力，不是某个角色的专用工具。桌面端启动 Hub 时用环境变量 `XSB_MCP_SERVERS`（`.mcp.json` 的格式）告诉它每个 Agent 都有的 MCP server，这里就是 `browser → xsb-browser-mcp`；Hub 给每个会话都挂上，没有角色的 Agent 也一样。角色里有同名的 server 时以角色的为准。角色专用的工具（如 `xsb-media-mcp`）仍然只在角色的 MCP 配置里，没有该角色就没有。
- **操控走 Chromium DevTools Protocol**，经 `webContents.debugger.attach`：`Accessibility.getFullAXTree` 是 Agent 读到的页面（可操作的元素带编号），`Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText` 是它的鼠标和键盘，`Page.captureScreenshot` 是截图。协议不出主进程，不开调试端口。
- **去哪个窗口**：按管道报来的工作目录找，哪个窗口的工作区有 Agent 在这个目录工作（或目录在项目里），网页就开在哪个窗口的右栏。
- **边界**：一个 MCP 连接是一个 Agent 会话，它只能看到和操作自己打开的标签，碰不到用户开的标签，更碰不到应用自己的窗口。它的标签上有一个状态点。用户在右栏看着，可以随时接手或关掉。
- **不在前台时**：读页面、点击、输入、跳转照常；截图需要网页在屏幕上，所以截图前会把它的标签切到前台。
- **工具**：`browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_press_key`、`browser_back`、`browser_screenshot`。

没有采用的方案：给应用开调试端口再接 Playwright MCP 或 chrome-devtools-mcp。它们要的是浏览器级的 CDP 端点，那会把应用的每个窗口（包括应用自己的页面）都交出去，也没法在右栏里开标签。

## 4. 角色和 Agent 是两个对象

角色是模板（说明、MCP 工具、skills、默认值），Agent 是实例（id、名字、所属角色、实际后端、工作目录、补充说明）。界面上它们各有入口，互不混用：

| | 入口 | 形式 | 原因 |
| - | - | - | - |
| Agent | 左栏"Agent"旁的 +；对话栏头的编辑按钮 | 对话框 | 字段少，改完就回到对话 |
| 角色 | 左栏"角色"区 | 整页 | 内容多（说明、工具、skills），而且改动影响多个 Agent |

### 新建 Agent

字段顺序就是决策顺序，第一项是角色：

| 字段 | 交互 |
| - | - |
| 角色 | 从已有角色里选，或"不使用角色"。选定后把角色的描述和默认后端填进**还没动过**的字段 |
| id | 即时校验字符（字母、数字、`-`、`_`）和重名；提示创建后不能改 |
| 名字 | |
| 描述 | 提示"写给其他 Agent 看的：它们据此决定把任务派给谁" |
| 后端 | 列出这台机器的全部后端，按名字显示（claude、codex…）；只有用户自己登记的后端才在名字后写出启动命令。程序不在 PATH 上的不可选，并提供"指定路径…"（见第 8 节） |
| 补充说明 | 只属于这个 Agent，排在角色说明之后 |
| 工作目录 | 收在"高级"里，默认不用填，即项目目录 |

### 编辑和删除 Agent

- id 不可改，显示在标题里。
- 每个字段下面写明它何时生效（见第 5 节）。
- 改了角色、后端或工作目录，而它不是空闲的：保存前弹出确认，说明当前这一轮会失败。
- 删除前的确认里列出：它是否正在工作、它手上未完成的任务（会失败并通知派发者）、它的目录和会话记录不会清理。
- "预览系统说明"见第 6 节。

### 编辑角色

页头始终显示"N 个 Agent 在用：……，这里的修改会影响它们全部"。页面是一列四段：

| 段 | 内容 |
| - | - |
| 新建 Agent 时的默认值 | 描述、默认后端。写明"修改不影响已有的 Agent"，并提供一个勾选项把它们同步到现有实例 |
| 说明 | 文本 |
| MCP 工具 | 每个 server 一张卡：名称、命令、参数、环境变量、"测试"。环境变量的值默认掩码，可切换显示；段首写明密钥以明文存在 `role.json` |
| Skills | 分成两组显示：**自动附上**（声明了产出的资产类型，任务要产出这类资产时 Hub 直接附上正文）和**按需读取**（模型自己决定）。属于哪一组是 skill 的一个字段（`SKILL.md` front matter 的 `produces`），名称没有语义。自动附上的 skill 还可以填"依据的资产类型"（front matter 的 `inputs`） |

- "测试"启动一次 server 并列出它的工具，或给出启动失败的原因，不必等到 Agent 运行时才发现配置错了。它测试的是已保存的配置，所以新加的 server 要先保存。
- skill 正文引用的文件用"打开文件夹"在访达里管理。界面不做文件上传：这样 renderer 不必接触文件路径。
- 角色还有 Agent 在用时，"删除角色"不可点，并说明原因。

### 4.1 预设团队

左栏"角色"区的"预设团队"打开一个面板，列出应用自带的几支团队。每个角色可以展开查看它的说明、MCP 工具（命令与需要的环境变量，值不显示）和每个 skill 的正文，显示的是预设的原样。

| 团队 | 角色 | 交付的资产 |
| - | - | - |
| 软件开发 | 技术负责人、产品经理、架构师、开发工程师、代码评审、测试工程师 | `prd` → `architecture` → `change` → `review`、`test_plan`、`test_report` |
| 电影创作（`film`） | 导演、编剧、美术指导、分镜师、摄影师、剪辑师 | `brief` → `script` → `style_guide` → `casting` → `character` → `shot_list` → `storyboard` → `animatic` → `shot` → `cut` |
| 火山方舟视频创作（`film-ark`，基于 `film`） | 同上 | 同上；生成类角色带 `media` 工具服务（Seedream / Seedance），摄影师多一个 `seedance` 技能 |

电影团队的流程照剧组的实际做法排：导演在简报、剧本、风格方向、主演、正式版、导演版几处请用户确认，花钱的事也要先问，其余自己定。`film` 不绑定任何一家的生成模型，用户在简报的"生成方案"里定用什么；`film-ark` 是基于它、用火山方舟出图出视频的那一支，只放方舟特有的部分（工具服务、Seedance 的写法与限制、方舟的事实）。2026-11 之前的项目用的 `film` 就是方舟那支，Hub 启动时会把它们的配置改成 `film-ark`。主演要选角：美术指导为每个主要人物出三到五个候选形象，用户选定后才做定妆图；分镜师在镜头表之后为每个镜头出一张静帧，剪辑师把它们排成动态分镜看节奏，摄影师再以静帧为首帧生成视频；正式开拍前先试拍最难的两三个镜头估成本；成片分粗剪、导演版、锁定画面三轮。这支剧组没有配乐和配音工具，声音只有随镜头生成的对白与现场声，以及用户自己提供的音频。

工作区**使用**一支团队，而不是复制它（Hub 的 `dev.xsb/teams`，见 [DESIGN.md](DESIGN.md) 5.6）。使用之后它的角色就在左栏的角色列表里，标着"预设"，按应用自带的版本生效：应用更新了，角色跟着更新，不需要重新添加。

- **使用角色 / 停止使用**：登记或取消登记这支团队，不创建 Agent。还有 Agent 在用只有这支团队才有的角色时，不能停止。
- **建立团队**：使用这支团队，并给还没有 Agent 的角色各建一个（id 用角色名，后端用第一个可用的）。可以反复点：只补缺的。
- **在工作区里修改**：打开角色页。保存之后，这个角色成为工作区自己的版本（`.xsb/roles/<角色>/`，从预设完整复制后再改），左栏标为"预设，已修改"，不再随应用更新。
- **恢复预设**：删除工作区自己的版本，改回预设。有 Agent 在用也可以恢复。角色页和预设面板里都有这个按钮。
- 工作区里原本就有的同名角色（包括旧版本复制进来的预设角色）在使用团队之后仍以工作区的为准，同样可以"恢复预设"。
- 预设就是文件，随 Hub 一起发布，每种语言一份：[packages/hub/presets/](../packages/hub/presets)`<语言>/<团队>/team.json` 加上 `roles/<角色>/`，后者与项目里 `.xsb/roles/` 的格式完全相同。加一支团队要在每种语言下各加一个目录，结构必须相同。

带专用工具的角色（右栏的浏览器每个 Agent 都有，不算在内，见 3.2）：美术指导、分镜师和摄影师用 [@xsb/media-mcp](../packages/media-mcp)（随应用自带，命令 `xsb-media-mcp` 由应用放到 PATH 上；出图默认豆包 Seedream，出视频默认豆包 Seedance，都可更换，经 `arkcli` 调用，见 4.2）。

角色还可以声明它要用到的本机程序（`team.json` 里的 `requires`，每项带一段安装说明）。剪辑师要 `ffmpeg` 和 `ffprobe`，摄影师要 `ffmpeg`（把过大的参考图转成 jpeg），美术指导、分镜师和摄影师要 `arkcli`：与各家 agent 的程序一样，在 PATH 上找，找不到时角色卡片上提示并提供"指定路径…"，应用不安装（第 8 节）。

`film-ark` 的提示词写法（图一 / 图片1 的参考图指代、首帧与参考图互斥、首帧时画幅跟随图片、对白放引号、出图使用简洁连贯的自然语言）取自火山方舟的 Seedance 与 Seedream 教程；`film` 只保留其中与模型无关的部分。角色划分参考了 BMAD-METHOD 和 MetaGPT（软件）以及常规的剧组分工（电影）；是凭我对它们的了解写的，没有逐条对照它们的仓库。角色内容没有经过真实模型、真实项目的检验。

### 4.2 火山方舟：只用来出图和出视频

语言上的工作由各后端自己的模型完成，xsb 不读、不写、不覆盖任何 agent（claude、codex…）的模型或 API 配置：那是用户的权利。方舟只在语言模型做不到的地方用：出图（Seedream）和出视频（Seedance）。

- **只经官方 CLI**（`@volcengine/ark-cli`，命令 `arkcli`），不直接调 HTTP 接口，不保存密钥；登录是用户自己的事（`arkcli auth login`）。
- **只运行三条生成命令**：`+gen`、`gen get`、`gen delete`。arkcli 还能改写本机各个 agent 的配置（`helper configure`、`+connect`、`helper mcp`），这些永不调用；[arkcli.ts](../packages/media-mcp/src/arkcli.ts) 里是白名单，别的命令直接拒绝。
- **与 ffmpeg 同样对待**：在 PATH 上找，找不到时角色卡片上提示、给出安装说明、提供"指定路径…"。应用不安装。安装说明里带 `ARKCLI_SKIP_SKILLS=1 ARKCLI_SKIP_POSTINSTALL=1`：arkcli 的 npm 安装脚本默认会把它的 skills 装进本机检测到的所有 agent。
- **未登录等问题在工具报错时提示**，原样带出 arkcli 的话和它给的提示；不为此额外调用。
- **账号是用户的事，项目不感知**：登录、用哪个档案（套餐还是按量）、哪把 key、图片和视频各用哪个模型，都由用户用 arkcli 自己的命令设置，与 claude、codex 的登录和模型配置同样对待。项目不传 key、档案、地址或模型；账号下没有可用的模型时，把 arkcli 的原话作为错误带出来。
- **模型**：用 arkcli 当前档案的默认图片、视频资源，由用户设置（`arkcli profile set-default <模型名或接入点 ID> --modality image|video`）；角色配置里没有模型这一项。

出图和出视频都用真实的 arkcli 验证过，细节与未通的部分（尾帧）见 [packages/media-mcp/README.md](../packages/media-mcp/README.md)。

### 产出总览

团队层面的契约，一张表：每一行是一类资产，列出能产出它的角色（有声明产出它的 skill）、这些角色的 Agent，以及它依据哪些资产类型。三种缺口用 ◆ 标出：

- 依据的某类资产没有任何角色能产出。

- 任务的 `produces` 或资产库里已经用到某类资产，但没有任何角色能产出。
- 有角色能产出，但没有 Agent 使用这个角色。

## 5. 生效时机

改了什么、何时生效、影响谁，都写在改的地方，不放在文档里让人去查：

| 修改 | 何时生效 | 界面怎么表达 |
| - | - | - |
| Agent 的描述 | 对其他 Agent 立即；对自己要等下次会话 | 字段下的提示 |
| Agent 的补充说明 | 下次会话 | 字段下的提示 |
| Agent 的角色、后端、工作目录 | 立即重启它的后端进程 | 字段下的提示；非空闲时保存前确认 |
| 角色的说明、MCP 工具、skill 目录 | 下次会话 | 保存后出现一条提示，点名受影响的 Agent，并提供"立即应用"（重启它们的进程；有非空闲的先确认） |
| skill 正文 | 下一次使用 | 字段下的提示 |
| 角色的描述、默认后端 | 不影响已有 Agent | 段首说明 + "同步到现有 Agent"勾选项 |

所有"会重启进程"的操作走同一个确认：列出此刻不是空闲的 Agent 和它们的状态，全都空闲时不打扰。

## 6. 预览模型实际看到什么

Agent 的编辑对话框和角色页都有"预览系统说明"。它显示 Hub 拼好的全文（角色说明、Agent 说明、skills 目录、协作说明、记忆摘要）。显示的是已保存的内容，也就是下次会话开始时模型看到的。角色有多个 Agent 时可以切换看哪一个。

## 7. Electron 怎么接

```
renderer ──window.xsb──▶ preload.cjs ──ipc──▶ main.ts ──▶ Workspace ──ACP──▶ Hub
```

- **main**：每个窗口一个 `BrowserWindow`，记着它打开的项目；每个项目一个 `Workspace`，同一项目的窗口共享它。连接只在断了时重建，没有窗口显示它时仍保留，供退出检查。`electron . <文件夹>` 直接打开那个工作区。
- **Workspace**：和 `@xsb/cli` 一样是 Hub 的一个 ACP 客户端（观察者）。找到或启动 Hub 用的是 `@xsb/hub` 的 `hubSocket`，与 CLI 同一份；Hub 由 Electron 自己的二进制以 Node 模式运行，不要求机器上另有 Node。
- **preload**：暴露 `window.xsb`，与 `mock.js` 同形。
- **renderer**：不读文件、不碰 Node，`contextIsolation` 和沙箱都是默认的开启状态。
- **Electron 是私有构建**（43.8.1，带 `<webview2>`）。npm 装的仍是官方的 `electron` 包，`postinstall`（[patch-electron.mjs](../packages/desktop/scripts/patch-electron.mjs)）给它打上 [patches/](../packages/desktop/patches) 里的补丁，之后它按 [.electron.mirror.mjs](../packages/desktop/.electron.mirror.mjs) 从私有镜像下载二进制（macOS 和 Windows；其他平台仍是官方构建）。版本在 `package.json` 里写死，升级时版本、补丁文件名、镜像目录后缀一起改。
- **打包**：`@xsb/hub`、`@xsb/protocol`、`@xsb/store` 的代码都打进了产物，运行时不再从 `node_modules` 读源码；只有 `electron` 是外部依赖。

`window.xsb` 的全部方法，以及它们在 main / Workspace 里对应的 Hub 接口：

| 方法 | 含义 | main 里对应 |
| - | - | - |
| `load()` | 快照。没有工作区时是 `{ workspace: null, recent }`，否则是 workspace、backends、roles、agents、tasks、artifacts、transcripts | `backends/list`；`roles/list`（一次带回每个角色的详情）；`agents/list`；`tasks/list`；`assets/list`；各主会话 `session/load` |
| `pickFolder()` | 选一个文件夹，返回 `{ path, initialized }` | `dialog.showOpenDialog` + 检查 `.xsb/` |
| `open(path)` | 让本窗口打开这个工作区，必要时先初始化 | `xsb init` 的逻辑 + 连接 Hub |
| `newWindow()` | 开一个没有工作区的新窗口 | `new BrowserWindow` |
| `on(listener)` | 之后的一切变化 | 见下 |
| `openPage(url, embedded?)` | 开一个网页，返回它；`embedded` 的不进标签栏（HTML 制品的预览）。没有 `<webview2>` 时返回 `null` | `Pages.open` |
| `page(id, op, arg?)` | 对一个网页做一件事：`navigate` `back` `forward` `reload` `external` `close` `detach` `restore` `show` `pin` | `Pages.call` |
| `pageWindow()` | 独立窗口问自己显示的是哪个网页 | `Pages.shownIn` |
| `send(agentId, content, interject)` / `cancel(agentId)` / `permit(entryId, allow)` | 发消息（内容，可插话）、停止当前一轮、回答权限请求 |
| `pathOf(file)` | 粘贴或拖入的文件在磁盘上的路径。不经过 main，由 preload 直接回答 | `webUtils.getPathForFile` | `session/prompt` 或 `_session/steering`、`session/cancel`、回复 `session/request_permission` |
| `putAgent(spec)` / `removeAgent(id)` | 新建或修改、删除 Agent | `agents/put { agent, instructions }`、`agents/remove` |
| `applyRole(role, completed?)` / `syncRole(role)` | 对角色的每个 Agent：重启后端进程（"立即应用"）/ 把角色现在的描述和后端给它。逐个做，返回做成了哪些、停下的原因；再做一次只补剩下的 | `agents/restart`、`agents/put` |
| `buildTeam(id, backend)` | 使用一支预设团队，并给还没有 Agent 的角色各建一个。返回建了哪些、停下的原因；角色和新建的 Agent 随事件到达 | `teams/use`、`agents/put` |
| `inspectAgent(id)` | 它自己的补充说明，和系统说明全文。打开编辑或预览时才取，不随 Agent 的状态同步 | `agents/get` |
| `putRole(role)` / `removeRole(name)` | 新建或修改、删除角色。预设团队的角色修改后成为工作区自己的；删除工作区自己的版本就是恢复预设。角色因此的变化随事件到达，先于调用的返回 | `roles/put`、`roles/remove` |
| `presets()` / `useTeam(id)` / `dropTeam(id)` | 应用自带的预设团队及是否在用；使用、停止使用一支；角色的来去随事件到达，先于调用的返回 | `teams/list`、`teams/use`、`teams/drop` |
| `testMcp(role, server)` | 启动角色里已保存的一个 MCP server 并列出工具 | `roles/check { name, server }` |
| `revealSkill(role, skill)` | 在访达中打开 skill 的文件夹。目录由 Hub 给出（`roles/get`），预设团队的角色同样能打开 | `shell.openPath` |

事件按键覆盖（同一个键再次到达即更新）：

| 事件 | 来源 |
| - | - |
| `{ agent }`、`{ removedAgent }` | `_dev.xsb/agents/update`、`_dev.xsb/agents/removed` |
| `{ role }`、`{ removedRole }` | `_dev.xsb/roles/update`、`_dev.xsb/roles/removed` |
| `{ task }` | `_dev.xsb/tasks/update` |
| `{ agentId, entry }`、`{ agentId, removedEntry }` | `session/update` 和 `session/request_permission`；移除见下 |
| `{ artifact }` | 工具调用的 `locations` 里出现的文件；资产库里的资产（`_dev.xsb/assets/update`），后者带 `assetType` |

界面的数据形状（[bridge.ts](../packages/desktop/src/bridge.ts)）比线上的更贴近界面，两处需要转换：

| 界面 | 线上 | 转换 |
| - | - | - |
| 角色的 `mcpServers` 是数组，`env` 是 `{ name, value }` 的数组 | `{ 名称: { command, args, env: {…} } }` | 数组与对象互转 |
| skill 是 `{ name, description, produces, inputs, body }`，`inputs` 是逗号分隔的文字 | 读：`{ name, description, produces, inputs, content }`；写：`{ name, content }` | 写时把 `description`、`produces`、`inputs` 写成 `content` 开头的 front matter；读时从 `content` 里去掉它得到 `body` |

**排队的消息。** 桌面端声明了 `dev.xsb/origin`（DESIGN.md 3.3），所以 Hub 在一条消息真正成为一轮的开始（或插进了进行中的那一轮）时，会把它带着发送时给的 `messageId` 送回来。发送时那条消息先显示出来，Agent 在忙就标"排队中"；回显到达时撤掉它（`removedEntry`），在这一轮开始的位置重新出现。桌面端因此不需要猜回合边界，排在其他 Agent 的邮件后面也是准的。

需要 Electron 专门做的只有五件事，其余都是普通网页（对话框用的是原生 `<dialog>`）：

| 需要 | 做法 |
| - | - |
| 无边框标题栏 | `titleBarStyle: "hiddenInset"`。标题栏是 `-webkit-app-region: drag`，左侧留了 82px 给红绿灯；Windows 上要把留白改到右侧 |
| 选择文件夹 | `dialog.showOpenDialog` |
| 加载界面 | 自定义协议 `app://xsb/…`，只提供 `renderer/` 目录下的文件；窗口里没有 `file://` 页面 |
| 制品的 `url` | 另一个自定义协议 `xsb-artifact://`，只提供已经作为制品告诉过界面的那些文件。它与界面不同源，Agent 写出的 HTML 不会在应用自己的源里运行 |
| 窗口最小尺寸 | `minWidth: 960, minHeight: 600` |

## 8. 后端从哪来

应用不安装任何东西（[clis.ts](../packages/desktop/src/clis.ts)）。下面说的是各家 agent 的程序；角色要用的工具（`ffmpeg`）走的是同一套：在 PATH 上找，找不到请用户指定路径，指定后为它生成同名的启动脚本。

1. **封装在应用里**。claude 和 codex 自己不说 ACP，它们的开源封装 `claude-agent-acp`、`codex-acp` 连同 JS 依赖打进了应用，由 Electron 自己的二进制运行。用户只需要有 `claude` / `codex` 程序本身，不需要另装 ACP 入口，也不需要 Node。gemini 和 grok 的程序自己说 ACP，没有封装。
2. **检测 = 在 PATH 上找**。`claude` / `codex` / `gemini` / `grok` 在用户的 PATH 上，对应的后端就可用。
3. **找不到就请用户指出路径**。新建 Agent 的后端列表里，缺失的一项显示"PATH 中没有 claude"和"指定路径…"按钮，点开是系统的选择文件对话框。选中的路径记在 `userData/backends/paths.json`，之后一直有效；PATH 上有的优先于指定的。

Hub 仍然"只启动、不安装"，一行没改：应用在 `userData/backends/bin/` 下为每个可用的后端生成一个启动脚本，并把这个目录放在启动 Hub 时的 PATH 最前面，Hub 的内置后端表（`claude-agent-acp`、`codex-acp`、`gemini`、`grok`）照常按命令名找到它们。脚本只在对应的程序存在时存在，所以"后端是否已安装"仍然只有一个含义：命令在 PATH 上。

已知的边界：

- **不处理版本兼容**。封装的版本固定在应用里，程序是用户机器上的，两者之间的版本差异没有检查。
- 程序在不在与登录无关；未登录时对话里会显示 Hub 的 `auth_required` 错误。
- 指定路径后，已经在运行的 Hub 立刻能用（它每次启动后端时才找命令）；但由 `xsb` 命令行先启动的 Hub 没有这个 PATH，要先 `xsb hub stop`。
- 指定的路径不能在界面里查看或改掉，只能在缺失时重新指定，或直接改 `paths.json`。
- **同步用户 shell 的全部环境变量**。从访达或程序坞启动的应用拿不到用户 shell 的环境：PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，shell 启动文件里设的变量（比如智能体自己的配置里指名的 API 密钥、代理设置）一个也没有。应用启动时向用户的登录 shell 问一次全部环境（`$SHELL -ilc 'env -0'`），找程序和启动 Hub 都用它，Hub 再把它传给各后端和 MCP server：PATH 用 shell 的，其余变量进程自己已有的不动、没有的补上；shell 没有回答时用进程自己的环境。这只是读取用户已经设好的环境，不改写任何 agent 的配置。Windows 上进程的环境就是用户的，不问。
- 后端的包装程序（`claude-agent-acp`、`codex-acp`）是应用自带的；缺的是它包着的那个程序时，报错说的是"没有找到 claude 程序"并指向"指定路径…"，而不是 Hub 原话里的"安装 claude-agent-acp"。
- 启动脚本是 POSIX shell，Windows 没有做。

## 8.1 Hub 一侧的限制

界面用到的接口 Hub 都有了。有两点界面需要知道：

- 角色的变更通知只在经 `roles/put`、`roles/remove` 修改时发出。用户直接改 `.xsb/roles/` 下的文件，界面不会自动刷新，重新打开角色页时才读到。
- `roles/get` 原样返回 MCP server 的环境变量（含密钥），掩码只是界面上的显示。

## 9. 已验证与没有覆盖的

在真实的 Electron 窗口里（通过调试端口驱动），接真实的 Hub、后端用 `packages/hub/test/mock-agent.ts`，手工跑过一遍：从命令行参数和"最近打开"打开工作区、未初始化的文件夹自动初始化、新建角色（含自动附上的 skill，核对了落盘的 `SKILL.md`）、新建 Agent、对话、排队、插话、停止、权限请求、重启应用后的历史回放、Agent 间派发任务与结果送回、资产作为制品出现并预览、系统说明预览、产出总览。这些没有自动化。

真实后端（claude-agent-acp 0.107.0，走本机 claude 的登录状态）在桌面端里手工跑过一遍：对话；导演用 `dispatch_task` + `await_tasks` 把一场戏派给编剧，编剧收到自动附上的 skill、登记 `script` 资产，结果送回导演，资产作为制品预览；原生插话；停止；重启应用后的历史回放。这些各跑了一次，没有自动化。那次后端没有发来权限请求（取决于后端自己的设置），所以真实后端的权限请求没有在桌面端里出现过。

右栏的网页和 browser use 在私有 Electron 43.8.1（macOS arm64）的真实窗口里跑过（2026-11-16）：打开 apple.com、google.com；切换标签、移到独立窗口再移回，页面里的加载时间戳不变；置顶；关独立窗口后标签消失；对话里的链接开成标签；HTML 制品里脚本运行且读不到 `window.xsb`；视频制品播放、范围请求回 206。browser use 经真实的 `xsb-browser-mcp` 管道调过每个工具：导航、快照、输入中文、点击、回车提交、跳转、后退，标签不在前台时同样可用，截图会把标签带回前台。

界面语言（2026-11-16）：在真实窗口里接真实的 Hub，以简体中文和英文（`-AppleLanguages '(en)'`）各开过一个新工作区，看过欢迎后的主界面、预设团队面板、资产总览，使用电影团队、新建导演、读它的系统说明，以及两条 Hub 报错的措辞。其余页面（角色编辑、新建智能体对话框、对话、权限请求、右栏网页）只在浏览器里用 mock 数据看过，没有在真实窗口里逐个点过。

输入区（2026-11-17）：在真实窗口里接真实的 Hub，后端用 `mock-agent.ts`（原生插话和靠打断插话的各一个），走过：发送、工作中再发送成为排队、"立即发送"后变成带"插话"的一条且只执行一次、空输入框时按钮变成停止并能停下、状态从"等待模型响应"到消失。"推理中""工具调用中"和计时只在浏览器里用 mock 数据看过；真实后端（claude）下的状态变化没有看过。

应用生命期（2026-11-17，开发版，macOS，经主进程调试口操作窗口）：再次启动时第二个进程退出，带文件夹时在原应用里开出窗口，不带时把隐藏的窗口带回前台；两个窗口关一个是真关，关最后一个是隐藏，两个同时关也留下一个隐藏的；退出后应用进程和它打开过的两个工作区的 Hub 都结束。没有点过红色关闭按钮和程序坞图标本身，Windows 上没有试过（那里隐藏之后没有程序坞，只能靠再次启动把窗口带回来）。

退出时的询问（2026-11-17，开发版，后端用 `mock-agent.ts`，对话框的选择经主进程调试口代答）：有任务在跑时退出，对话框写出了在工作的智能体；选"继续工作"应用不退出；选"仍然退出"后应用和 Hub 都结束，再启动 Hub 时那个任务是"已取消"、没有智能体被重新叫起来。没有亲手点过对话框的按钮。

没有验证或没有做：

- browser use 只用脚本当 MCP 客户端测过，没有让真实的 Agent（claude、codex）用过。每个 Agent 都挂上它（`XSB_MCP_SERVERS`）由 Hub 的端到端测试覆盖，真实 Agent 里没有跑过。
- 网页没有下载、文件选择、`alert` 之类对话框的处理；browser use 没有多标签、拖拽、悬停、上传这些工具。
- 独立窗口的置顶、红绿灯位置只在 macOS 上看过。

- codex、gemini、grok 本机没有安装，没有在桌面端里跑过。
- "打开文件夹…"弹出的系统对话框无法脚本驱动，没有点过；MCP 测试、删除 Agent、删除角色、同步到实例只在 mock 数据的原型里点过。
- 打包成应用（`npm run package`：`release/` 下的 mac arm64 与 win x64 压缩包）之后，只验证过"模拟从访达启动时能找到 claude"（用只有系统默认 PATH 的环境启动开发版）；打包出的 `.app` 本身没有由我启动验证过。没有签名和公证，Windows 版没有运行过。
- Windows 和 Linux 没有试过。
- Hub 断开后窗口不会自动重连：圆点变红，由用户点击重连（Hub 没在运行就启动它）。断开的那一刻所有 Agent 显示为空闲、没答复的权限请求作废：Hub 不在了，就没有东西在运行。
- Agent 的思考过程（`agent_thought_chunk`）不显示。
- 另开会话（`--new`）：每个 Agent 只显示主会话。
- 角色的默认后端设过之后不能在界面里清空。
- 这台机器的后端配置（`~/.xsb/config.json`）的编辑界面；制品的版本与差异对比。
- 未保存的修改离开页面时不会提醒；面板宽度、打开了哪些对话栏不会保存。
- 剪贴板里的富文本（HTML）没有转成 markdown，只取纯文本；音频和内嵌资源块没有做。
- 图片以 base64 随消息保存在会话记录里，没有大小限制，也没有压缩。
- 输入框没有撤销栈之外的编辑辅助（markdown 快捷键、预览）。
