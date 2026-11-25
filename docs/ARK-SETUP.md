# 火山方舟接入（仅 xSB）

在“设置 → 模型后端”的“火山方舟”卡片里完成：安装 arkcli → 登录 → 选套餐 → 让 xSB 中的 Claude Code / Codex 使用方舟模型，或解除接入。每一步都由主进程先弹出系统确认框（`main.ts`），用户确认后才执行。不做工作区级接入。

## 分层

| 层 | 职责 |
| --- | --- |
| `renderer/ark.js` | 卡片：状态、下一步操作、套餐列表、每个智能体的接入状态；选择套餐和模型的对话框 |
| `renderer/backend.js` | 后端卡片注明“通过火山方舟接入 · 模型” |
| `preload.cjs` / `main.ts` | 白名单 IPC：`arkStatus`、`arkModels`、`arkInstall`、`arkLogin`、`arkCancelLogin`、`arkBind`；安装、登录、接入、解除的确认框 |
| `src/ark.ts` | 调用 arkcli 的唯一位置；npm 安装；记录接入（`ark.json`）；生成启动器片段 `arkLaunch` |
| `src/clis.ts` | 后端 ACP 包装的启动器：构造时就带上 `arkLaunch` 的片段，所以第一次生成的启动器已包含方舟设置 |

## 安装

1. 确认框写明用哪个 npm、装到哪里，以及不会给智能体添加 arkcli 的技能。
2. 有用户自己的 `npm` 时运行 `npm install --global --include=optional @volcengine/ark-cli@latest`；如果全局目录无写权限（EACCES/EPERM），改为 `--prefix <userData>/backends/installed/npm` 再装一次。
3. 没有 npm 时，用随应用打包的 npm（`dist/npm`，由 `rolldown.config.js` 从依赖 `npm` 复制），以 Electron 作为 Node 运行（`ELECTRON_RUN_AS_NODE=1`），安装到应用自己的前缀。同时在 PATH 最前面放一个临时的 `node` 转发脚本，让 arkcli 的 postinstall（`node scripts/postinstall.js`）也能运行。
4. 设置 `ARKCLI_SKIP_SKILLS=1`：否则 arkcli 的 postinstall 会执行 `+connect --refresh`，把技能装进本机所有智能体。
5. 用 `npm root --global` 找到包，记录**原生二进制**的路径（`bin/arkcli-<os>-<arch>`，或平台子包里的同名文件）到 `paths.json`（`Clis.setPath`）。之后不依赖 PATH，也不依赖 node；Hub 的 PATH 里还会有一个同名启动器，媒体插件也能找到它。

已验证：在临时前缀中用打包后的 npm、Electron 作 Node、PATH 中没有 node 的情况下，9 秒装好 1.0.65，记录到原生二进制，`~/.claude/skills` 没有新增内容。

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

Claude、Codex 的配置文件都不改；终端里的 claude/codex 不受影响。接入后，`AgentClis.check` 只检查程序版本，状态报告为 `ready (via ark)`，不再检查它们自己的登录。设置下次启动会话时生效，正在进行的会话不受影响。如果 Claude 自己的 `settings.json` 里设置了 `ANTHROPIC_*` 或 `apiKeyHelper`，它们会优先于进程环境，确认框会提示这一点。

已验证（干净环境，真实 arkcli 1.0.50 与 Agent Plan Medium）：经 codex-acp 2.6.0 和 claude-agent-acp 各发一条最小提示，都以 `end_turn` 结束并回复 OK。

## 已知问题

- Codex 会在回复前提示找不到所选模型的元数据（arkcli 自己的配置用 `model_catalog_json` 补上了这一项）。不影响使用；以后可以按 `model-list` 生成模型目录。
- Claude 在自动模式下会附带一条网关不兼容分类器计费的提示。
- Windows 启动器（`for /f` 取 Key）只有单元测试，没有在 Windows 上实际运行过。
- 真实应用验证（隔离的 userData/工作区，你本机的 arkcli、claude、codex；系统确认框由驱动脚本记录后代为确认）：卡片检测到已登录和 Agent Plan Medium → 依次接入 Claude、Codex（确认框原文核对无误）→ 后端卡片显示"通过火山方舟接入" → Claude 会话 4 秒回复 OK（在用户 settings.json 指向其他服务的情况下）→ 切到 Codex 的新会话 4 秒回复 OK → 解除 Claude 接入后启动器恢复原样，Codex 不受影响。安装和登录这两步没有在真实应用里重跑：安装另外在临时前缀中实测过，登录会改动现有凭据。

## 测试

`test/ark.test.ts`：JSON 与错误信封解析、各种 npm 布局下的原生程序定位、状态映射、模型列表、两种安装路径（EACCES 回退、内置 npm + node 转发脚本）、接入记录不含 Key 且拒绝不安全的名字、启动器在 sh 中实际运行（Key、环境变量、清除项、取不到 Key 时的报错）、Windows 片段、Clis 第一次生成的启动器就带有接入设置，以及解除后移除。
