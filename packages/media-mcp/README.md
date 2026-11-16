# @xsb/media-mcp

一个 stdio MCP server，两个工具：`generate_image` 和 `generate_video`，各自用一个可更换的模型生成并存成文件。

```
agent ──直接调用──────────▶ xsb-media-mcp ──ImageProvider──▶ Seedream / 其他图片模型
agent ──start_job──▶ Hub ──▶ xsb-media-mcp ──VideoProvider──▶ Seedance / 其他视频模型
```

两个默认提供方都经火山方舟的官方 CLI 调用（`arkcli +gen`，见 [src/arkcli.ts](src/arkcli.ts)），不直接调 HTTP 接口。arkcli 是用户自己的：安装、登录（`arkcli auth login`）、用哪个档案（`arkcli profile use`）、图片和视频各用哪个模型（`arkcli profile set-default <模型名或接入点 ID> --modality image|video`）都由用户用 arkcli 自己的命令决定，这里不知道、不设置、不传递任何账号信息（key、档案、地址、模型）；账号下没有可用的模型时，把 arkcli 的原话作为错误带出来。只运行 `+gen`、`gen get`、`gen delete` 三条生成命令：arkcli 改写其他 agent 配置的那些命令不在白名单里，会被拒绝。

## 工具

- `generate_image { prompt, output, reference_images?, size? }`：几秒钟，直接调用。
- 参考图和首尾帧由 arkcli 以 base64 内嵌在请求里发出（`--inline-local`），不需要对象存储。火山方舟的限制写在工具说明里：单张小于 30 MB，整个请求不超过 64 MB（内嵌后体积涨三分之一，所以一次调用的图片合计约 45 MB 以内），参考图 2.0 系列最多 9 张、2.5 系列最多 30 张；尾帧返回的是 jpeg。参数只接受文件路径或网址，不接受 base64 字符串。
- `generate_video { prompt, output, first_frame?, last_frame?, reference_images?, duration?, resolution?, ratio?, seed?, audio?, last_frame_output? }`：几分钟，文件存好才返回；xsb 的 Agent 用 `start_job` 在后台调用。

图片参数可以是文件路径或 URL。当前模型和它的限制写在工具说明里，由提供方给出。没配置好时 server 仍能启动，原因写在工具说明和调用结果里；一个模型配错不影响另一个。

## 取消

视频生成按量计费，没人要的结果要尽早叫停。下面三种情况 server 都会通知提供方取消：调用被取消（MCP 的 `notifications/cancelled`）、server 被要求停止（Hub 取消后台任务时就是这样做的）、等待超过 `VIDEO_TIMEOUT_S`。

**方舟只能取消还在排队的任务**，已经开始生成的取消不了，仍会计费。调用结果里会写明这次取消有没有省下钱。

## 设置（环境变量，写在角色的 MCP 配置里）

| 变量 | 含义 |
| - | - |
| `IMAGE_PROVIDER` | 出图的提供方，默认 `seedream` |
| `VIDEO_PROVIDER` | 出视频的提供方，默认 `seedance` |
| `ARKCLI` | 可选：arkcli 的路径 |
| `VIDEO_POLL_MS` / `VIDEO_TIMEOUT_S` | 轮询间隔（默认 5000）与最长等待（默认 1800） |

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
- **尾帧没有存下来**：请求了 `--return-last-frame`，任务结果里没有尾帧链接。`last_frame_output` 目前不可用，原因未查清。
- **账号侧的失败都原样带出**：套餐不含该模型、按量档案下用了模型名而不是接入点 ID、模型处于"安全体验模式"用量已满，都是 arkcli 或方舟的原话。

一个档案只服务它自己的模型：那次验证里图走的是套餐档案、视频走的是按量档案。两样都要用时，由用户把 arkcli 的当前档案设成两者都能调用的那个（如按量档案，再用 `arkcli profile set-default` 设好图片和视频两个接入点），这里不替用户选。那次验证时模型是由本项目用 `--model` 传的，现已去掉；"不传模型、用档案默认资源"这条路径还没有用真实的 arkcli 验证过。

取消、超时取消只对着假 CLI 验证过。
