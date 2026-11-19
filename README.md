# xsb

多个主 Agent 的协作系统：每个 Agent 背后是一个 ACP v2 后端（claude / codex，或任何说 ACP v2 的 agent），你可以和每个 Agent 直接对话，它们之间也可以直接对话和派发任务。设计见 [docs/DESIGN.md](docs/DESIGN.md)。

需要 Node ≥ 22.18。Hub 和 CLI 无运行时依赖、无构建步骤；桌面应用依赖 Electron，由 Rolldown 打包。

## 结构

npm workspaces 的 monorepo，七个库，依赖只向下（cli 与 desktop 并列，互不依赖）：

| 库 | 职责 |
| - | - |
| [@xsb/desktop](packages/desktop) | 桌面应用（Electron），Hub 的一个 ACP 客户端；设计见 [docs/GUI.md](docs/GUI.md) |
| [@xsb/cli](packages/cli) | `xsb` 命令，Hub 的一个 ACP 客户端 |
| [@xsb/hub](packages/hub) | Hub 守护进程：会话与回合、后端进程、邮件与任务、权限、协作工具 |
| [@xsb/media-mcp](packages/media-mcp) | 图片与视频生成的 MCP server，模型可更换（先接了豆包的 Seedream 与 Seedance）；角色把它配成自己的工具 |
| [@xsb/adapter](packages/adapter) | 把没有 ACP 入口的三方 agent 封装成一个普通后端 |
| [@xsb/store](packages/store) | 只追加的 JSONL 日志 + 预写日志 |
| [@xsb/protocol](packages/protocol) | 线上定义：JSON-RPC、ACP 类型、ACP 扩展、错误码 |

## 使用

先执行一次 `npm install` 把 `xsb` 命令链接进来（也可以直接运行 `packages/cli/bin/xsb`）：

```bash
npm install
```

确认要用的后端已安装（xsb 不替你安装）：

```bash
npx xsb backends
```

在项目目录里初始化并添加 Agent。`npx xsb` 只在本仓库目录树内可用；在别的目录请用绝对路径运行 `<仓库>/packages/cli/bin/xsb`（或为它设一个 shell alias），项目由当前目录向上查找 `.xsb/` 决定，也可用 `--project <目录>` 指定：

```bash
npx xsb init
npx xsb agent add director --backend claude --name 导演 --desc "统筹全片，拆解并派发工作" --instructions @director.md
npx xsb agent add writer   --backend codex  --name 编剧 --desc "写剧本和对白"
npx xsb agent add gaffer1  --backend claude --name 灯光师1 --desc "设计布光方案"
npx xsb agent add gaffer2  --backend codex  --name 灯光师2 --desc "设计布光方案"

npx xsb chat director        # 对话；它工作时你说的话直接插进这一轮，/cancel 停止，/quit 退出
npx xsb watch                # 另开一个终端，看所有 Agent 在做什么
npx xsb status               # Agent 状态与未完成的任务
npx xsb send writer "第三场改成夜戏"
```

角色不在代码里。简单的用法就是上面这些参数，每个 Agent 的说明文字在 `.xsb/agents/<id>/instructions.md`，可以直接编辑。

### 角色、资产与后台任务

要让角色真正不同（各自的工具、流程、产物），把角色写成一个目录，再让 Agent 成为它的实例：

```
.xsb/roles/cinematographer/
  role.json              { "description", "backend", "workspace", "mcpServers": { 名称: { command, args, env } } }
  instructions.md        这个角色是谁、怎么工作
  skills/shot/SKILL.md   做某一类工作的步骤；front matter 写 produces: shot 的，随"要产出 shot"的任务自动送达；inputs: 写它依据的资产类型
```

```bash
npx xsb agent add dp1 --role cinematographer --name 摄影1
```

- **工具**：`mcpServers` 只给这个角色的 Agent；慢的生成调用由 Agent 用 `start_job` 放到后台，结果稍后送回，期间 Agent 可以继续对话。
- **资产库**：角色形象、画风、剧本、镜头表、成片都登记为有 id 和版本的资产（如 `character/lin`），所有 Agent 引用同一份。`npx xsb assets` 查看。
- **产物契约**：派发任务时声明 `inputs`（依据哪些资产）和 `produces`（要交什么类型），Hub 把资产和对应的 skill 随任务送达，并在结果里核对是否交付。

格式和机制见 [packages/hub/README.md](packages/hub/README.md) 与设计文档 5.4–5.6。

Agent 也可以按需使用 `team` 的 `create_role`、`create_agent` 创建新角色与实例，并通过 `grant_permission` 授予自己已有的权限。创建和授权复用向目标角色类型派发任务的授权机制；同类型的所有实例共享持久权限。设计与调用示例见 [动态角色与转授权](docs/DYNAMIC-ROLES.md)。

语言：命令输出和报错跟随终端的语言（`LANG` 等），桌面应用跟随系统语言，目前有简体中文和英文。Agent 的工作语言是项目的设置（`.xsb/config.json` 的 `language`），第一次打开项目时按当时的语言写入，之后可以手改；预设团队按它读取对应语言的一份。详见设计文档 3.4。

后端需要你自己装好并登录，xsb 不安装、不保存凭据、也不决定权限模式，这些都用各后端自己的设置。`npx xsb backends` 列出本机后端及是否已安装；缺了会报错并给出错误码（见设计文档 2.4）。

配置分两处：`~/.xsb/config.json` 定义这台机器有哪些后端，`.xsb/config.json` 是项目设置。后端就是"一条在 stdio 上说 ACP 的命令"，可以在全局配置里新增；没有 ACP 入口的 agent 用 [@xsb/adapter](packages/adapter) 封装后同样登记。

接入编辑器等 ACP 客户端：把 agent 命令配置为 `xsb acp --agent <id>`。

Hub 是按需在后台启动的常驻进程：`npx xsb hub status | stop | log` 查看、停止、看日志。完整命令和退出码见 [packages/cli/README.md](packages/cli/README.md)。

桌面应用：一个工作区一个窗口，可以并排和多个 Agent 对话、编辑角色、预览制品。

```bash
npm start -w @xsb/desktop
```

## 开发

```bash
npm test
```

```bash
npm run typecheck
```
