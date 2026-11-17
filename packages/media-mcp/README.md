# @xsb/media-mcp

一个 stdio MCP server，两个工具：`generate_image` 和 `generate_video`，各自用一个可更换的模型生成并存成文件。

```
agent ──直接调用──────────▶ xsb-media-mcp ──ImageProvider──▶ Seedream / 其他图片模型
agent ──start_job──▶ Hub ──▶ xsb-media-mcp ──VideoProvider──▶ Seedance / 其他视频模型
```

两个默认提供方都经火山方舟的官方 CLI 调用（`arkcli +gen`，见 [src/arkcli.ts](src/arkcli.ts)），不直接调 HTTP 接口。arkcli 是用户自己的：安装、登录（`arkcli auth login`）、用哪个档案（`arkcli profile use`）、图片和视频各用哪个模型（`arkcli profile set-default <模型名或接入点 ID> --modality image|video`）都由用户用 arkcli 自己的命令决定，这里不知道、不设置、不传递任何账号信息（key、档案、地址、模型）；账号下没有可用的模型时，把 arkcli 的原话作为错误带出来。只运行 `+gen`、`gen get`、`gen delete` 三条生成命令：arkcli 改写其他 agent 配置的那些命令不在白名单里，会被拒绝。

## 工具

- `generate_image { prompt, output, reference_images?, size? }`：几秒钟，直接调用。
- 参考图和首尾帧由 arkcli 以 base64 内嵌在请求里发出（`--inline-local`），不需要对象存储。火山方舟的限制写在工具说明里：单张小于 30 MB，整个请求不超过 64 MB（内嵌后体积涨三分之一，所以一次调用的图片合计约 45 MB 以内），参考图 2.0 系列最多 9 张、2.5 系列最多 30 张（flash 10 张）。参数只接受文件路径或网址，不接受 base64 字符串。
- `generate_video { prompt, output, first_frame?, last_frame?, reference_images?, duration?, resolution?, ratio?, seed?, audio?, last_frame_output? }`：几分钟，文件存好才返回；xsb 的 Agent 用 `start_job` 在后台调用。

图片参数可以是文件路径或 URL。当前模型和它的限制写在工具说明里，由提供方给出。没配置好时 server 仍能启动，原因写在工具说明和调用结果里；一个模型配错不影响另一个。

## 取消

视频生成按量计费，没人要的结果要尽早叫停。下面三种情况 server 都会通知提供方取消：调用被取消（MCP 的 `notifications/cancelled`，Hub 取消后台任务时就是这样做的）、server 被要求停止、等待超过 `VIDEO_TIMEOUT_S`。

**方舟只能取消还在排队的任务**，已经开始生成的取消不了，仍会计费（方舟的删除接口对 `queued` 是取消，对 `running` 不支持，对已结束的任务是删除记录）。所以取消前先查一次状态，只删排队中的任务，不会把一条已经付费生成的视频记录删掉。调用被取消和超时这两种情况，调用结果里会写明这次取消有没有省下钱；Hub 的 `cancel_task` 走的就是取消通知，并等这句话回来作为任务结果，之后才停掉 server。server 直接被停止时没有调用结果可写。

## 设置（环境变量，写在角色的 MCP 配置里）

| 变量 | 含义 |
| - | - |
| `IMAGE_PROVIDER` | 出图的提供方，默认 `seedream` |
| `VIDEO_PROVIDER` | 出视频的提供方，默认 `seedance` |
| `ARKCLI` | 可选：arkcli 的路径 |
| `FFMPEG` | 可选：ffmpeg 的路径。只在提供方没给尾帧时用来从视频里取最后一帧 |
| `VIDEO_POLL_MS` / `VIDEO_TIMEOUT_S` | 轮询间隔（默认 5000）与最长等待（默认 1800） |

## 花费与预算（在 xSB 项目里）

Hub 启动角色的 MCP server 时给它两个环境变量：`XSB_SPEND`（项目的账本 `.xsb/spend.jsonl`）和 `XSB_AGENT`（为哪个智能体工作）。有账本时：

- **每次生成前**读一遍账本，有以下三种情况之一就拒绝，并用智能体能转告用户的话说明原因：
  - 没有预算；
  - 已花的加上同一工具以往最贵的一次，会超过预算；
  - 自上次设预算以来，有生成没能计价。
- 预算由用户在 xSB 设置里写进账本，改了立即生效。
- **每次生成后**往账本追加一条记录：用量、估算金额、依据。生成在提供方那边已经开始、又被放弃的，记为"计费、金额未知"。
- **估价**来自 `arkcli pricing models --modality ComputerVision --page-all`，这是账号折后的单价，按只读命令加进白名单，每 12 小时最多读一次，缓存在 `.xsb/run/prices.json`。
  - 视频取该模型、该清晰度档位下最高的适用单价（V2V 与 NV2V 无法从结果分辨，宁可估高），按千 tokens 计。
  - 图片按张计。
  - 结果里的模型名对不上价目时（例如接入点标识），取同类模型的最高单价。
  - 没有价格就记为"未知"，不当成 0。
- 同一个进程里，同时出图最多 3 张，其余排队。视频的并发由 Hub 控制（`start_job` 排队，见 hub 的 `limits.jobsAtOnce`，默认 2）。

账本的格式和合计规则在 `@xsb/protocol` 的 `spend.ts` 里，Hub 和这里共用。

## 换一个模型

每种产出一个接口（[src/provider.ts](src/provider.ts)），小到各家的接口都装得下：

```ts
interface VideoProvider { about; submit(request): Promise<id>; poll(id): Promise<VideoStatus>; save(id, to): Promise<…>; cancel(id): Promise<boolean> }
interface ImageProvider { about; generate(request, signal): Promise<void> }
```

提供方自己把文件写到请求指定的位置：有的模型给下载链接，有的（CLI）自己存文件。新增一个模型：写一个文件实现接口，在 [src/server.ts](src/server.ts) 的登记表里加一行，角色里改 `*_PROVIDER`。

## 已验证与未验证

`npm test -w @xsb/media-mcp`：真实的 server 和两个提供方，配一个假的 arkcli。覆盖：每个参数变成哪个命令行参数、轮询、存视频与尾帧、出图、任务失败、缺 CLI、未知提供方、server 被停止时取消任务、超时取消、"已开始、取消不了"的说明。

用真实的 arkcli 1.0.50 验证过（2026-11-16）：

- **出图**：套餐档案下用 `doubao-seedream-5.0-flash` 出了 1K 的图，约 11 秒。不传 `--watermark=false` 有"AI 生成"水印；不传 `--output-format` 得到的是 JPEG，不管文件叫什么。
- **出视频**：按量档案下用一个 Seedance 2.5 flash 的接入点（`ep-…`）出了 4 秒 480p 的视频，约 78 秒。
- **尾帧**：请求里带了 `return_last_frame: true`（`arkcli +gen --dry-run` 可见），方舟文档写明结果里会有 `content.last_frame_url`，arkcli 把它放在结果顶层的 `last_frame_url`（没有时省略）。那一次真实调用里没有拿到，原因未查清，之后也没有再用真实账号跑过。所以现在不依赖它：提供方没给时，用 ffmpeg 从存下来的视频里取最后一帧，结果里写明是哪种来源；两样都没有才报告"没有存下来"。从视频里取尾帧只用假的 ffmpeg 验证过接线，命令本身没在真实 ffmpeg 上跑过。
- **账号侧的失败都原样带出**：套餐不含该模型、按量档案下用了模型名而不是接入点 ID、模型处于"安全体验模式"用量已满，都是 arkcli 或方舟的原话。

一个档案只服务它自己的模型：那次验证里图走的是套餐档案、视频走的是按量档案。两样都要用时，由用户把 arkcli 的当前档案设成两者都能调用的那个（如按量档案，再用 `arkcli profile set-default` 设好图片和视频两个接入点），这里不替用户选。那次验证时模型是由本项目用 `--model` 传的，现已去掉；"不传模型、用档案默认资源"这条路径还没有用真实的 arkcli 验证过。

取消、超时取消只对着假 CLI 验证过。

尾帧验证（2026-11-17，arkcli 1.0.50）：`--return-last-frame` 会发送 `return_last_frame: true`，但 `gen get` 的规范化结果省略尾帧和 seed。请求尾帧时，保存视频后用同一个 CLI 的只读 `api arkruntime.get_content_generation_task --params '{"id":"…"}'` 补取 `content.last_frame_url` 与 `seed`；仍无尾帧时保留 ffmpeg 回退。只允许这一项 raw API，不开放任意账户操作。

Seedream 的参考图称呼“图一、图二”已按[官方提示词指南](https://ark.volcengine.com/region:cn-beijing/docs/seedream-4-0-5-0-prompt-guide)核实。指南建议简洁精确的自然语言，未给出“300 汉字 / 600 英文单词”的限制，因此工具说明和预设技能删去了这些数字。
