# 火山方舟接入（仅 xSB）

在“设置 → 模型后端”的“火山方舟”卡片里完成：登录 → 选套餐 → 让 xSB 中的 Claude Code / Codex 使用方舟模型，或解除接入。arkcli 随应用内置，不需要安装。每一步都由主进程先弹出系统确认框（`main.ts`），用户确认后才执行。不做工作区级接入。

打开设置只显示已有检测结果；首次显示“未检测”，点击“检测”才运行检测。检测只调用 `arkcli --version` 和 `arkcli auth status --format json`：确认程序能运行、读取 `logged_in`，并从 `profiles_summary` 读取套餐类型、名称和到期时间。它不取 API Key、不查询 token 余额或剩余套餐额度、不发送模型请求。接入后检测 Claude/Codex 则先检查其程序版本，再检查所绑定的方舟登录和套餐状态。

## 分层

| 层 | 职责 |
| --- | --- |
| `renderer/ark.js` | 卡片：状态、下一步操作（重新检测或登录）、套餐列表、每个智能体的接入状态；选择套餐和模型的对话框 |
| `renderer/backend.js` | 后端卡片注明“通过火山方舟接入 · 模型”；方舟不可用时说明原因（退出登录、套餐不可用、无法确认） |
| `preload.cjs` / `main.ts` | 白名单 IPC：`arkStatus`、`arkModels`、`arkLogin`、`arkCancelLogin`、`arkBind`；登录、接入、解除的确认框；把内置 arkcli 交给 `Clis` 链接到 `builtin/bin` |
| `src/ark.ts` | 调用 arkcli 的唯一位置；定位内置程序（`shippedArkcli`）；记录接入（`ark.json`）；生成启动器片段 `arkLaunch`；接入后的智能体检测（`agentCheck`） |
| `src/clis.ts` | 后端 ACP 包装的启动器：构造时就带上 `arkLaunch` 的片段，所以第一次生成的启动器已包含方舟设置 |

## 内置的 arkcli

- `packages/desktop/package.json` 的 `optionalDependencies` 精确锁定各平台的 `@volcengine/ark-cli-<platform>-<arch>`（目前是 1.0.65）。npm 只安装与当前平台匹配的那一个。它们是生产依赖，不经 rolldown 打包，由 electron-builder 按发布时的原样复制到应用的 `node_modules`，运行时按路径执行（`shippedArkcli`：`bin/arkcli-<os>-<cpu>[.exe]`）。
- 不依赖包装包 `@volcengine/ark-cli`：它的 postinstall 会从 CDN 下载二进制，并调用 `+connect --refresh` 把 arkcli 的技能装进本机所有智能体。平台包只含程序本身和技能文档，没有安装脚本。
- 各平台的应用在各自的平台上打包（`.github/workflows/desktop.yml`）。`electron-builder.config.mjs` 的 `afterPack` 会检查应用里有目标平台的 arkcli；跨平台打包时缺少这个程序，打包直接失败。
- xSB 只使用内置的 arkcli，不在 PATH 中查找，也不使用用户自己装的 arkcli。方舟卡片和启动器按绝对路径调用它；它还以 `arkcli` 为名链接到 `backends/builtin/bin`（见 CLI_SETUP.md 的“可执行文件的布局”），这个目录排在子进程 PATH 中用户 PATH 的前面，所以媒体插件按命令名找到的也是它（除非用户显式设置了 `ARKCLI`）。登录凭据由 arkcli 保存在 `~/.arkcli`，和用户自己的 arkcli 共用。
- 内置程序缺失或无法运行时，卡片显示“程序异常”，只提供重新检测，不附加重装建议。
- 升级 arkcli：改 `optionalDependencies` 中的六个版本号，重新运行 `npm install`，再按下文核对输出格式。

## 登录

确认后运行 `arkcli auth login volc-sso`（不连终端）。arkcli 会自己打开浏览器，并把登录地址打印到 stderr；xSB 把这个地址显示成“打开登录页”链接，供浏览器没打开时使用。最长等待 10 分钟，可以取消（结束整个进程树）。凭据由 arkcli 保存在 `~/.arkcli`。

## 套餐与模型

- 状态来自 `arkcli auth status`：`logged_in`，以及 `profiles_summary` 中类型不是 `platform` 的套餐 profile（显示名称、档位、到期时间；已到期的不能选）。
- 模型来自 `arkcli plans model-list --plan <type> --mode direct`，`ark-code-latest` 排第一，界面显示为“智能路由”。只保留能对话的模型：`output_modalities` 含 `text`；没有模态信息时，带 `load` 的才算（如 `doubao-seed-evolving`）。向量、生图、语音合成、语音识别模型被排除，结果与 arkcli 写给 Claude 的模型清单一致。
- 没有有效套餐时给出官方套餐概览的链接；应用内不下单。

## 接入（只在 xSB 中生效）

`<userData>/backends/ark.json` 只记录 `{ claude|codex: { profile, model, baseUrl } }`，不记录 Key。`baseUrl` 取自 `arkcli profile show` 的 `base_url`。

启动器（`<userData>/backends/bin/claude-agent-acp`、`codex-acp`）在运行包装程序之前：

1. 用 `<arkcli> profile apikey get --profile <P> --format json --transform api_key` 取得 Key，放进 `XSB_ARK_API_KEY`。取不到时打印原因并以 1 退出，Hub 会把它当作后端启动失败报告。
2. **Claude**：`ANTHROPIC_BASE_URL=<base_url 去掉 /v3>`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`，各档默认模型和子智能体模型都设为所选模型，`API_TIMEOUT_MS=3000000`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`；并清除 `ANTHROPIC_API_KEY`、`CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`。
3. **Codex**：`CODEX_CONFIG={"model_provider":"xsb-ark","model":…,"model_providers":{"xsb-ark":{base_url, env_key:"XSB_ARK_API_KEY", wire_api:"responses"}}}`。codex-acp 会把它转成传给 `codex app-server` 的 `-c` 参数。Key 只放在环境变量里，因为 codex-acp 会把 `CODEX_CONFIG` 写进日志。同时清除 `MODEL_PROVIDER`、`OPENAI_BASE_URL`。

**Claude 的用户设置优先于环境变量。** 真实应用中实测发现：用户 `~/.claude/settings.json` 的 `env` 里设置的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` 会盖过进程环境，请求仍然发往用户自己的服务。所以在 macOS/Linux 上，xSB 写入 `<userData>/backends/ark/claude`（一个转发脚本）和 `ark/claude-settings.json`（地址、模型，并把 `ANTHROPIC_API_KEY`、`CLAUDE_CODE_USE_*` 置空；不含 Key）。启动器把 `CLAUDE_CODE_EXECUTABLE` 指向这个转发脚本，由它运行 `claude --settings <文件> …`。命令行设置的优先级高于用户设置；Key 仍只通过 `ANTHROPIC_AUTH_TOKEN` 环境变量传递。Windows 上 Node 不能不经 shell 启动 `.cmd`，所以只设环境变量，确认框会列出会胜出的用户设置项。另一种做法——用 `apiKeyHelper` 取 Key——实测返回 401，没有采用。

Claude、Codex 的配置文件都不改；终端里的 claude/codex 不受影响。`AgentClis.check` 只检查智能体程序版本，不检查账号或套餐；LM 调用失败时展示 ACP 返回的错误。方舟设置页的显式检测仍由 `Ark.status` 提供。

**生效时机。** 每个对话的智能体程序是一个进程，由启动器启动一次，之后跨 turn 复用（hub 的 `backends.ts`）。接入或解除只改写启动器和 `ark.json`，不会重启已在运行的进程。所以新建的对话立即生效，已打开的对话在重启应用后生效。确认框和完成提示都按这个说法（`main.ts` 的 `effect`）。已打开的对话如果在此之前因停止超时、续上下文或工具变更而重启了后端，也会提前生效。如果 Claude 自己的 `settings.json` 里设置了 `ANTHROPIC_*` 或 `apiKeyHelper`，它们会优先于进程环境，确认框会提示这一点。

已验证（干净环境，真实 arkcli 1.0.50 与 Agent Plan Medium；内置的 1.0.65 另外核对过 `auth status`、`profile show`、`plans model-list` 的解析结果和 `profile apikey get --transform api_key`）：经 codex-acp 2.6.0 和 claude-agent-acp 各发一条最小提示，都以 `end_turn` 结束并回复 OK。

## 已知问题

- Codex 会在回复前提示找不到所选模型的元数据（arkcli 自己的配置用 `model_catalog_json` 补上了这一项）。不影响使用；以后可以按 `model-list` 生成模型目录。
- Claude 在自动模式下会附带一条网关不兼容分类器计费的提示。
- Windows 启动器（`for /f` 取 Key）只有单元测试，没有在 Windows 上实际运行过。
- 真实应用验证（隔离的 userData/工作区，你本机的 arkcli、claude、codex；系统确认框由驱动脚本记录后代为确认）：卡片检测到已登录和 Agent Plan Medium → 依次接入 Claude、Codex（确认框原文核对无误）→ 后端卡片显示"通过火山方舟接入" → Claude 会话 4 秒回复 OK（在用户 settings.json 指向其他服务的情况下）→ 切到 Codex 的新会话 4 秒回复 OK → 解除 Claude 接入后启动器恢复原样，Codex 不受影响。登录这一步没有在真实应用里重跑，因为它会改动现有凭据。（这次验证用的是当时由 npm 安装的 arkcli；改为内置之后，接入流程本身没有变化。）

## 测试

`test/ark.test.ts`：JSON 与错误信封解析、内置程序的定位、状态映射（含程序缺失）、接入后的智能体检测、模型列表、每次接入变化都会重写启动器、接入记录不含 Key 且拒绝不安全的名字、启动器在 sh 中实际运行（Key、环境变量、清除项、取不到 Key 时的报错）、Windows 片段、Clis 第一次生成的启动器就带有接入设置，以及解除后移除。
