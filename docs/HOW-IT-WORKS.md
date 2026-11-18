# How It Works：协作原语与角色系统

这篇文档讲 xsb 怎么让几个智能体像一个团队那样工作，读完能回答三个问题：

| 问题 | 在哪一节 |
| - | - |
| 某一类任务，怎么知道该派给谁 | 第 3.1 节 |
| 要等两个任务都回来才继续，是靠对话历史，还是有待办清单 | 第 3.2 节 |
| 资产有版本吗；用户改了主意，旧产物怎么办 | 第 3.3 节 |

这三个问题的答案，都是由第 2 节的**协作原语**组合出来的。所以建议按顺序读：先看角色是什么（第 1 节），再看原语各自做什么、怎么写（第 2 节），然后看它们怎么组合（第 3 节）。第 4 节讲给角色写说明和技能时，怎么把这些原语写进去。

设计动机见 [DESIGN.md](DESIGN.md)。术语：智能体（Agent）、技能（skill）、中枢（Hub）、工具服务（MCP server）。

> **关于例子**：剧组、任务号、资产名是为讲解编的。凡是英文的整句（工具返回、报错、附在消息后的说明），都是照代码原文抄的，模型看到的就是这些字。

## 0. 例子与核心思路

### 0.1 贯穿全文的例子

用户要拍一部 60 秒短片《渡口》，用了预设的电影团队，建了这些智能体：

| 智能体 id | 角色 | 干什么 |
| - | - | - |
| `director1` | 导演 | 统筹、把关、请用户确认 |
| `writer1` | 编剧 | 写剧本 |
| `art1` | 美术指导 | 风格、选角、人物设定 |
| `board1` | 分镜师 | 镜头表、分镜画面 |
| `camera1`、`camera2` | 摄影师（两位，同一个角色） | 生成镜头 |
| `editor1` | 剪辑师 | 动态分镜、成片 |

### 0.2 核心思路

**能确定的事，中枢来做；需要判断的事，交给模型；提示词负责把两边接上。**

"分镜师交镜头表了吗"能确定：中枢查一下资产库就知道，不用听分镜师自己怎么说。"这份镜头表好不好"要判断：交给导演的模型去看。

由此带来这套提示词最大的特点：**很少在开头一口气叮嘱一大堆，而是在用得上的那一刻，把相关的东西递到模型眼前。** 技能正文随任务到达，笔记随话题到达，等待前写给自己的提醒随结果到达。

模型看到的文字集中在两个文件：[prompts.ts](../packages/hub/src/prompts.ts)（系统说明、消息的包装）和 [tools.ts](../packages/hub/src/tools.ts)（工具的说明、返回、报错）。

## 1. 角色是什么

### 1.1 一个目录，加几行声明

代码里没有"导演""编剧"这些词。一个角色就是一个文件夹：

```
roles/storyboard-artist/
  role.json            一句话描述、用哪个后端、带哪些工具服务
  instructions.md      岗位原则（分镜师的只有 11 行）
  skills/
    shot_list/SKILL.md     怎么做镜头表
    storyboard/SKILL.md    怎么画分镜画面
```

关键在技能文件开头的声明：

```
---
description: 把一场戏或全片拆成镜头表
produces: shot_list
inputs: script, style_guide, character
---
```

意思是：**这个角色能依据剧本、风格指南、人物设定，产出镜头表。** 这叫一条"产出契约"。

角色"会做什么"只看这种声明，不看 `instructions.md` 里怎么自我介绍。所有角色的声明收到一起，就是整支团队的分工表（[`Hub.team()`](../packages/hub/src/hub.ts)），不存在任何文件里，每次用到时现算。

### 1.2 系统说明长什么样

`director1` 开始一个会话时，收到的系统说明由 [`systemPrompt()`](../packages/hub/src/prompts.ts) 拼成（有删节）：

```
# Who you are
You are "导演" (agent id: director1). 统筹全片：定创作方向，把工作派给各部门……

你是这部片子的导演。成片是什么样子由你决定，也由你负责……   ← 角色的 instructions.md
| 步 | 资产 | 谁做 | 关口 |
| 1 | brief 创作简报 | 你自己 | 用户确认 |
……

# Language                                                 ← 工作语言
# Working with the team                                    ← 原语的用法，中枢写的，所有人一样
# Topics and continuity                                    ← 话题与记忆的规矩，所有人一样
# Assets                                                   ← 资产库的规矩，所有人一样

# The team                                                 ← 从各角色的声明算出来的
- brief: you
- script: writer1, from brief
- shot_list: board1, from script, style_guide, character
- shot: camera1, camera2, from shot_list, storyboard, style_guide, character
……

# Files                                                    ← 工作目录、共享目录
# Skills                                                   ← 本角色的技能目录，算出来的
- brief: 开工前把用户的想法定成一页创作简报 (arrives with tasks that produce "brief")
- dailies-review: 审看生成的镜头，决定通过或重拍

# Your memory at the start of this session                 ← 记忆摘要，算出来的
(empty)
```

人写的只有两处：一句话描述、岗位说明。协作规则对每个智能体一字不差；分工表、技能目录、记忆摘要都是算出来的。团队加一位摄影师，下次开会话时这张表自动多一个名字。

### 1.3 同事的话怎么进来

工具调用只能"问一句答一句"，没法过一会儿再主动对模型说话。所以任务结果、同事消息，都作为**新的一轮输入**送进会话，并套上标签，让模型分清这不是用户说的：

| 标签 | 是什么 |
| - | - |
| `<xsb-message>` | 同事发来的消息 |
| `<xsb-task>` | 派给我的任务 |
| `<xsb-task-result>` | 我派出的一个任务的结果 |
| `<xsb-task-results>` | 我等的几个任务，结果一起回来 |
| `<xsb-asset>`、`<xsb-skill>`、`<xsb-memory>` | 中枢顺带附上的资产、技能正文、我自己的笔记 |

## 2. 协作原语：xsb 的工具

中枢给每个会话挂上一个名为 `team` 的工具服务（工具在后端里显示为 `team/dispatch_task` 这样）。智能体之间的往来都经过它，没有别的通道：**一个智能体平常的回复文字只给自己会话里的人看，同事看不到**；唯一的例外是任务的结果：承接者为这个任务工作的完整经过（它说的每句话、调用过的工具、期间用户插的话），就是交给派发者的结果。

**哪些工具在手边，取决于正在做的事**（[KERNEL.md](KERNEL.md) 8）：做同事派来的任务时，总能 `report_result`、`ask` 派活的人；派活、给别人发消息要有授予：角色的团队策略（`role.json` 的 `grants`，预设里导演、技术负责人有）、用户在话里点名、派活的人转授。看不到的工具，就是这件事没给你。

### 2.0 总览

| 组 | 原语 | 一句话 |
| - | - | - |
| 认人 | `list_agents` | 团队里有谁、各自能产出什么、在不在忙、和我谈过哪些话题、我能对它做什么 |
| 说话 | `send_message`、`broadcast`、`message_status` | 告诉同事一件事；查对方的模型看到没有 |
| 派活 | `dispatch_task` | 交给同事一件要出结果的工作；说明结果怎么回来（`sync`/`wake`/`lazy`） |
| 提问 | `ask` | 问派活给我的人一个问题，在调用里等答复 |
| 交差 | 结束这一轮；必要时 `report_result` | 这期间的完整经过就是结果；提前交、分开交、说做不了时用 `report_result` |
| 等待 | `subscribe` | 登记"这几个都回来再叫我"，然后结束本轮 |
| 收件箱 | `inbox` | 现在就读等下一轮的结果和通知 |
| 后台 | `start_job` | 把一次很慢的工具调用放到后台跑 |
| 查看与撤回 | `task_status`、`cancel_task` | 看任务状态；取消自己派出的任务 |
| 找用户 | `escalate_to_user` | 告诉用户自己在等他决定 |
| 资产 | `put_asset`、`find_assets`、`get_asset` | 登记、查找、读取共享的产物 |
| 记忆 | `remember`、`recall` | 按话题写笔记、查记忆 |
| 技能 | `load_skill` | 读自己角色的一篇技能 |

所有原语共同的四条约定：

1. **几乎都立即返回。** 结果以后送来（唤醒你，或随下一轮附上）。例外是 `sync` 的派发和 `ask`：调用最多等几十秒，结果就是返回值（见 2.3）。
2. **身份不靠参数。** 每个会话有中枢发的令牌，工具调用天然知道是谁在调，冒充不了别人。
3. **带 `topic` 的地方都该带上。** 话题是记忆的钥匙（见 3.1）。
4. **出错时返回的是能照着改的话。** 例如 `no agent "camera3". Agents: writer1, art1, board1, camera1, camera2, editor1`（列出的是除自己以外的同事）。

下面逐个讲。每个原语分四部分：参数、返回、场景例子、写法要点。

### 2.1 `list_agents`：认人

**参数**：无。

**返回**（节选）：

```json
{
  "you": "director1",
  "agents": [
    { "id": "board1", "name": "分镜师", "role": "storyboard-artist",
      "description": "把剧本拆成逐个可生成的镜头，并为每个镜头画出分镜画面：……",
      "produces": ["shot_list", "storyboard"], "state": "idle", "topics_with_you": ["渡口-镜头表"] },
    { "id": "camera1", "name": "摄影师", "produces": ["shot"], "state": "running",
      "topics_with_you": ["渡口-第3场"] },
    { "id": "camera2", "name": "摄影师", "produces": ["shot"], "state": "idle", "topics_with_you": [] }
  ]
}
```

**场景**：导演要拍第 4 场，不确定派给谁。它看到 `camera1` 在忙、`camera2` 空闲，而且第 4 场和别的场没有衔接关系，就派给 `camera2`。如果第 4 场要接第 3 场的尾帧，它会看到 `camera1` 的 `topics_with_you` 里有第 3 场，宁可排队也派给 `camera1`。

**写法要点**：分工表在系统说明里已经有了，不必每次都调。它的价值在于现算的两栏：`state`（现在忙不忙）和 `topics_with_you`（和谁有历史）。

### 2.2 `send_message`：说话

**参数**：`to`、`content`、`topic`。

**返回**：`message_id` 和 `delivery`，两种之一：

| `delivery` | 意思 |
| - | - |
| `delivered` | 对方空闲，消息立即成为它的一轮 |
| `queued behind the peer's current work` | 对方在忙，排在它当前的工作之后 |

**只有用户能插话**（[KERNEL.md](KERNEL.md) 6）。对方在忙时，Agent 发来的消息一律排在这一轮之后，哪怕发送方正是给了对方这份工作的那一方；排队期间对方的模型完全看不到它。只有中枢自己的通知（比如任务被取消）在对方忙时插进去。要改变对方正在做的事，用 `dispatch_task` 的 `onBusy: "replace"` 改派（见下文"派发"）。

**`message_status(message_id)`** 查对方的模型有没有看到这条消息，返回台账的状态：`queued`（还在排队）、`inserted`（进了对方的对话，还没往下做）、`seen`（看到了）、`discarded_unseen`（没看到，也不会看到）等。不要用它轮询。

**场景一：通知。** 用户刚把主演定为 `candidate/阿宁-2`，导演通知美术指导：

```
send_message(
  to: "art1",
  topic: "渡口-选角",
  content: "用户选定 casting/阿宁-2 为主演。售票员不选角，直接做人物设定。定妆任务稍后派给你。"
)
```

**场景二：改了要求。** 摄影师 `camera1` 正在做导演派的第 3 场，导演发现镜头表里 3-4 的动作写错了。发消息只会排在这一轮之后，摄影师会照错的做完；要它停下按新要求做，就改派：

```
dispatch_task(to: "camera1", topic: "渡口-第3场", title: "第 3 场分镜（3-4 改为'走'）",
  instructions: "……", onBusy: "replace")
```

原来的第 3 场任务被停下，结束原因记为 `superseded`（界面上显示"已改派"），为它而起的活一起撤掉；导演是停止方，不会收到它的结束通知。摄影师停下后接着做新任务。不加 `onBusy` 就是排队：新任务排在原任务之后，两件都会做完。

**写法要点**：

- **对方的回复不会自动回来。** 对方读到消息后平常说的话只留在它自己的会话里。需要对方回话，在消息里说清"请用 send_message 回复我"，或者干脆改用 `dispatch_task`，结果一定会送回来。
- **要结果的事用 `dispatch_task`，不用 `send_message`。** 消息没有状态、没有结果、不能等待、不能取消。
- **带上同一个 `topic`。** 消息和任务都进对方唯一的那条对话；`topic` 用来对口：对方的记忆笔记按话题附上，团队也据此知道这件事之前是谁经手的。
- 对方处理这条消息时出错，中枢会告诉发送方：`Your message m_… to "art1" was not processed: …`。

### 2.3 `dispatch_task`：派活

这是最常用、也最值得写好的原语。

**参数**：

| 参数 | 必填 | 写什么 |
| - | - | - |
| `to` | 是 | 同事的 id |
| `title` | 是 | 短标题，结果回来时靠它认 |
| `instructions` | 是 | 对方需要知道的一切（见下面的写法） |
| `topic` | 否 | 这件事的话题。不填就用标题，并且返回里会提醒你下次补上 |
| `inputs` | 否 | 依据的资产 id。**必须存在**，否则直接报错 `no asset "…". Look it up with find_assets.` |
| `produces` | 否 | 要交的资产类型 |
| `after` | 否 | 先等哪几个任务结束再开始（见 3.2） |
| `deliveryPref` | 否 | 结果怎么回来。`lazy`（默认）：不唤醒你，随你的下一轮附上，或用 `inbox` 读。`wake`：结果到了就唤醒你（要等结果才能往下走的活用它）。`sync`：短任务、要拿结果才能往下做时用，调用最多等 `limits.awaitSeconds`（默认 50 秒），结果就是返回值；超时则返回回执，结果之后按 `wake` 送到 |
| `grants` | 否 | 转授对方能力：给哪些人派活、发消息（只能是你自己有的） |

**返回**：

```json
{ "task_id": "t_12", "status": "dispatched", "note": "……（只在有提示时出现）" }
```

`status` 为 `` held until the tasks in `after` finish `` 时，表示任务被 `after` 挡住，还没投递。

**场景**：导演要分镜师做全片镜头表。

```
dispatch_task(
  to: "board1",
  title: "全片镜头表",
  topic: "渡口-镜头表",
  instructions: "按简报，全片 60 秒、12 个镜头左右、三场戏。第 2 场是全片的情绪转折，镜头可以密一些。
                 主演已定为阿宁（casting/阿宁-2），售票员只出现在第 2 场。
                 不要配乐镜头，简报里没有配乐。
                 交付：镜头表一份。结果里列出你认为最难生成的两三个镜头，我要拿它们试拍。",
  inputs: ["brief/渡口", "script/渡口", "style_guide/渡口", "character/阿宁", "character/售票员"],
  produces: "shot_list"
)
```

**对方收到什么。** 导演只写了 `instructions` 那段话。`board1` 实际收到的是：

```
<xsb-task from="director1" task-id="t_12" topic="渡口-镜头表" title="全片镜头表">
按简报，全片 60 秒、12 个镜头左右、三场戏……
</xsb-task>
This task works from the following assets. They are the reference: keep to them, and do not redefine what they define.
<xsb-asset id="script/渡口" version="2" by="writer1" path="/…/assets/script/渡口/v2.md">
《渡口》剧本，三场戏
---
（剧本全文）
</xsb-asset>
……（其余输入资产）
This task has to produce a "shot_list" asset. Register it with put_asset before you end your turn.
Your skill for this (files it refers to are in /…/skills/shot_list):
<xsb-skill name="shot_list">
# 镜头表
登记为 `shot_list/<片名或场次>`，markdown 表格……
</xsb-skill>
```

剧本全文、人物设定、"必须交一份镜头表"、做镜头表的完整流程，都是中枢附上的。技能是按 `produces` 配上的：`board1` 的角色里正好有一个声明 `produces: shot_list` 的技能。**分镜师不需要记得去查任何东西。**

**返回里的三种提示。** 任务照常派出，但返回的 `note` 会说明问题。都是**提示，不是拦截**，要不要取消重派由派发者定：

| 情况 | 提示原文 |
| - | - |
| 派给了没有这个流程的人（比如编剧） | `"writer1" has no procedure for producing "shot_list" and works without one. On this team it is produced by: board1.` |
| 漏了契约要求的输入（比如没给人物设定） | `` "board1" produces "shot_list" from script, style_guide, character, but `inputs` has no character asset. If one exists, cancel this and dispatch again with it. `` |
| 话题之前一直和另一个人谈 | `Topic "渡口-第3场" has so far been handled with camera1 (3x, last 2026-11-17T08:12:40Z), not with "camera2". If you meant to continue with the same peer, cancel this and send it there.` |

**写法要点**：

- **对方看不到你的对话。** 工具说明原文是 "Everything the peer needs, for it sees nothing of your conversation: the goal, what you already know or decided, the constraints, what done looks like, and what to report back." 用户在导演会话里说的"不要配乐"，不写进任务，分镜师就不知道。
- **资产给 id，不要抄内容。** 写"依据 `character/阿宁`"并放进 `inputs`，而不是把人物描述复制一遍。抄的那份和资产库里的会慢慢对不上。
- **用户的决定写成事实。** 写"主演已定为 `casting/阿宁-2`"，不写"用户好像比较喜欢第二个"。
- **写明结果里要报告什么。** 派发者以后要用的信息（"最难的两三个镜头"），在这里就要求对方报告。
- **一个任务只交给一个人，只产出一类资产。** 镜头表和分镜画面是两个任务。

对比一个写得差的：

```
dispatch_task(to: "board1", title: "镜头表", instructions: "按我们刚才讨论的做一下镜头表")
```

问题：没有话题；没有 `inputs`，分镜师拿不到剧本；没有 `produces`，中枢不会附上技能，也不会核对交付；"刚才讨论的"分镜师根本没看到。

#### 对方怎么交差：结束这一轮（隐式完结）

**承接者这一轮正常结束，任务就结束，它为任务工作的完整经过就是结果**（[DESIGN.md](DESIGN.md) 3.1 第 10 条）。 不需要调用任何工具；模型忘了"交差"这件事，任务也不会悬着（[KERNEL.md](KERNEL.md) 4）。所以：

- **最后用一段话总结结果。** 经过原样交给派发者，最后那段要完整、自足，写明没做到、没做完、没核实的。
- **还有东西要回来，就不算结束。** 为这个任务启动的后台任务、`wake`/`sync` 的子任务、或订阅还有没完的，这一轮的结束不算；带回结果的那一轮结束时再判断。
- **契约由中枢核对。** 任务有 `produces` 时，回合结束时承接者还没登记那种类型的资产，中枢就追问它：

  ```
  Your turn ended, but your task "全片镜头表" (t_12) is not done: It did not register a "shot_list" asset, which it had to produce. Register it with put_asset now, then end your turn with the result. If it cannot be done, call report_result with failed and say why.
  ```

  追问两次仍没有，任务以 `error` 结束，结果里写明原因。

- **对方在忙时来的任务排队。** 每个 Agent 只有一条对话，一次只做一件事。对方正在做事时又来一个任务，哪怕来自同一派发者，也排在当前工作之后，不插进去；派发者的回执里写明对方正在做它的哪件事。要取代那件事，派发者显式改派（`onBusy: "replace"`）。任务交给模型时，后面附一份"这里还开着的任务"，模型据此判断它是修正、补充了哪一个，还是另一件事：

  ```
  You still have these tasks open here; see whether this one changes any of them:
  - t_12 "全片镜头表" from director1, topic "渡口-镜头表"
  ```

  同一轮里开着的几个任务，以同一句话结束；要分开交、提前交、或说做不了，用 `report_result`。

**`report_result`**：参数 `task_id`（只有一个任务时可省）、`result`、`assets`、`failed`。只在承接 Agent 派来的任务时有（用户的任务，结果就是给用户的回答）。有 `produces` 时 `assets` 里没有那种类型就交不了，报错 `task t_… has to produce a "shot_list" asset: register it with put_asset and name it in "assets". If it cannot be done, set failed and say why.`；已被停止的任务交不了，报错 `task t_… was stopped; there is no result to give`。

**用户按停**：用户在一个会话里按停止，停下它的工作，也停下它正在做的任务（停止方是用户），派发者收到 `cancelled` 的结果。用户接着说话，是一个新的任务。

### 2.4 `subscribe`：等待（订阅与汇合）

**参数**：`task_ids`、`mode`（`all` 默认，或 `any`）、`note`（写给自己的提醒）。

**返回**：

```
Subscribed (0/2 finished). End your turn now; the results arrive together in one message.
```

如果调用时这些任务已经结束了，不登记，结果直接放在返回里：`Nothing to wait for, the results are in: …`。

**它做的事**：把这些任务的结果升为 `wake`，并在中枢里登记一个"门"。门没满足时，这几个任务的结果被扣住，不打扰你；满足时合成一条 `<xsb-task-results>` 消息，唤醒你，后面跟着你写的 `note`：

```
Your own note for this moment: 两场都回来后逐镜审。全部通过就派 editor1 粗剪；有重拍的先退回，不要派剪辑。
```

`any` 模式下，第一个回来就叫醒你，消息末尾列出还在跑的任务，它们的结果之后单独到达。只订一个任务，就是让它的（默认 `lazy` 的）结果改为唤醒你。

**写法要点**：

- **调完就结束本轮。** 原文："You receive all results together in one message when the condition holds, as a new turn or, if you are working then, within your turn: polling or sleeping does not bring them sooner." 条件满足时结果才来：你空闲就作为新的一轮，你正忙就插进这一轮。轮询和 sleep 不会让它来得更早，只会白占着这一轮。
- **只能等自己在这个会话里派出的任务。** 否则报错 `task t_… was dispatched from another session of yours` 或 `no task "t_…" dispatched by you`。
- **note 写三样：下一步做什么、继续之前查什么、不满足时怎么办。**

  | 写得差 | 写得好 |
  | - | - |
  | `等结果` | `两场都回来后逐镜审。全部通过就派 editor1 粗剪；有重拍的先退回，不要派剪辑。` |
  | `看看怎么样` | `先看 2-3 的人物脸是否与定妆图一致，那是试拍的重点。重拍超过三次的镜头，退回 board1 改设计，不要再让摄影师碰运气。` |

  note 不会被中枢理解，只会被原样送回。它要能让一个已经忘了前情的你，看完就知道该干什么。

- **接了任务的人也可以用。** 处理别人派来的任务时，订阅自己的后台任务或子任务，然后结束本轮；任务在它们回来之前不会结束（详见 3.2 的例子）。

### 2.5 `start_job`：后台跑慢调用

**参数**：`server`（自己角色的一个工具服务名）、`tool`、`arguments`、`title`、`topic`。

**返回**：`{ "task_id": "t_41", "status": "started; the result will be delivered to you" }`

**场景**：摄影师要生成镜头 2-1 的小样，一次生成要几分钟。

```
start_job(
  server: "media",
  tool: "generate_video",
  title: "2-1 小样",
  topic: "渡口-第2场",
  arguments: { "prompt": "……", "first_frame": "/…/assets/frame/2-1/v1.png",
               "duration": 6, "resolution": "480p", "output": "shots/s02_01_draft.mp4" }
)
```

`arguments` 和直接调 `media` 的 `generate_video` 时一模一样。区别只是：直接调会卡在那里几分钟，谁找它都找不到；用 `start_job` 立即返回，结果以 `<xsb-task-result>` 送回。

**它是一种任务。** 所以能 `subscribe` 等、能 `cancel_task` 撤，在任务列表里看得到。

**写法要点**：

- `server` 只能是**自己角色** `role.json` 里配的工具服务，否则报错 `your role has no MCP server "media"`。导演的角色没配 `media`，所以导演不能直接生成视频，只能派给摄影师。
- 每次后台调用都单独启动一次那个工具服务，用完即关，所以只适合无状态的工具：提交生成、渲染、转码。
- **中枢重启时不会重跑。** 还在跑的后台任务会被标为失败：`xsb stopped while this job ran, so its outcome is unknown. It was not run again; start it again if it is still needed.` 因为一次生成可能已经花了钱，要不要再来一次由模型决定。
- 后台任务没有 `after`。需要先后顺序（比如接上一镜的尾帧）时，拿到前一个结果再提交下一个。

### 2.6 `task_status`、`cancel_task`：查看与撤回

**`task_status(task_id)`** 看一个任务（自己派出的，或派给自己的）：状态、谁发起、谁结束、承接者是否已看到。不带参数时列出三组：

```json
{
  "dispatched_by_you": [ { "task_id": "t_21", "title": "第2场", "to": "camera1", "status": "running" } ],
  "assigned_to_you": [],
  "subscribed": [ { "task_ids": ["t_21", "t_22"], "mode": "all", "note": "两场都回来后逐镜审……" } ]
}
```

这就是"我现在手上有什么"的唯一来源（见 3.2）。

被订阅扣住的结果，用 `task_status` 也读不到正文，只看到：`Held for your subscription: it arrives together with the others in one message. Do not act on it before then.` 否则模型可能按一半的结果先行动，合并消息到了又处理一遍。

**`cancel_task(task_id)`** 只能撤自己派出的任务或后台任务（用户可以撤任何任务，见 `xsb tasks cancel`）。**撤的人自己知道，所以不再送回结果**，从自己的另一个会话撤也一样：任务记为 `cancelled`，原因和谁撤的留在 `task_status` 里；订阅也不再等它，只等其余的。

**停止会传染。** 中枢记着每件活是为哪些任务而起：派发或启动后台任务时，派发所在会话里已交给模型、还没结束的任务都算，不需要模型声明。撤一个任务时，中枢把只为它而起的活（一层层往下，穿过已经完成的中间任务）一起撤掉；同时还为别的未结束任务而起的活不撤，只告诉派发它的会话。只为被撤的活在忙的承接者，它的工作被停下，等它停下后整次撤销才落账（所以 `cancel_task` 可能答"正在停"）；还有别的活在做的承接者收到一条通知，列出它手上被撤的任务、中枢替它撤掉的活、因还有别的用处而没撤的活。被连带撤掉的任务，结果写成 `Cancelled with "…" (t_…), which director1 cancelled.`。撤的人自己不收回音；派发它的会话如果不是撤的人、也没收到那条通知、工作也没被停下，照常收到 `cancelled` 结果。中枢判任务失败（承接者那一轮出错）时同样连带。数据结构和算法见 [TASK-GRAPH.md](TASK-GRAPH.md)。

| 任务当时的状态 | 发生什么 | 返回 |
| - | - | - |
| 还在对方队列里 | 从队列里拿掉，没开始就结束 | `Task t_… cancelled.` |
| 对方已经拿到 | 当即记为取消；对方被告知"停下"，并附上中枢一起撤掉的东西。对方这个会话若因此没有别的任务开着，中枢停下它正在跑的这一轮，通知留在收件箱随它下一轮附上；还有别的任务开着就插进去告诉它 | `Task t_… cancelled.` |
| 后台任务在跑 | 中止那次工具调用 | `Task t_… is being stopped.` |

**场景**：用户说阿宁的风衣要换成红色。导演立刻撤掉还没开始的第 4 场拍摄任务，止损（完整流程见 3.3）。

**写法要点**：不要用 `task_status` 轮询，工具说明原文是 "Do not poll with it: results are delivered to you." 撤后台生成时要知道：中枢能中止调用，但外部服务那边已经开始生成的，撤不撤得掉、计不计费，由那个服务决定。摄影师说明里因此写了"提交前把提示词再读一遍"。

### 2.7 `put_asset`、`find_assets`、`get_asset`：资产

**`put_asset`** 参数：`type`、`name`、`description`，加上 `path`（文件）或 `content`（文本）二选一。

```
put_asset(type: "shot", name: "2-1",
  description: "第2场第1镜，小样 480p。首帧 frame/2-1，提示词与参数见下……",
  path: "shots/s02_01_draft.mp4")
```

返回 `{ "id": "shot/2-1", "version": 1, "description": "…", "path": "/…/assets/shot/2-1/v1.mp4", "by": "camera1" }`。

- 文件被**复制**进资产库，以后不再改写。同一个 id 再登记就是第 2 版，旧版保留（版本规则见 3.3）。
- `type` 和 `name` 各是一个词，不能含 `/` 或空格，不能以 `.` 开头。`type` 用任务或分工表里的类型名，不要自造同义词：写 `shot_list` 就别写 `shotlist`，否则 `produces` 核对不上。
- `path` 可以是相对自己工作目录的路径。
- 任务有 `produces` 时，回合结束前登记好那种类型的资产，任务结果里据此列出交付物（见 3.2）；用 `report_result` 交时在 `assets` 里点名。

**`find_assets(type?, query?)`** 只列每样东西的最新版。`query` 在 id 和描述里找子串。

**`get_asset(id)`** 读一个资产，`shot/2-1@1` 读旧版。小的文本资产（32KB 以内的 md、txt、json 等）直接带正文，图片和视频只给路径。

**写法要点**：

- **定义之前先找。** 系统说明原文："Before you describe or create something that may already be defined, call find_assets. If it exists, use it as it is." 美术指导要画售票员，先查 `find_assets(type: "character", query: "售票员")`，有就用，别再造一个。
- **`description` 是别人找到它的依据。** 写它是什么、给什么用；版本有特别含义时写出来（"小样"还是"正式版"）。写"新版本""改好了"等于没写。
- **改定义就是出新版本，不是起新 id。** 不要登记 `character/阿宁-红衣`，而是给 `character/阿宁` 出第 2 版。否则所有写着 `character/阿宁` 的地方都不会跟着变。

### 2.8 `remember`、`recall`：记忆

**`remember(topic, content, peers?)`** 写这个话题的笔记，**覆盖**原来的那条。`content` 为空就是删除。`peers` 不填时，用中枢记下的和你谈过这个话题的人。

**`recall(query?)`** 同时查三样：笔记、话题账本（谁和谁就哪个话题打过几次交道）、相关任务（最近 15 个）。不带参数列出全部。

**场景**：用户选定主演后，导演按说明记下来：

```
remember(
  topic: "渡口-选角",
  content: "主演：casting/阿宁-2（用户选定）。定妆 character/阿宁 由 art1 负责，已登记 v1。售票员不选角。未决：无。",
  peers: ["art1"]
)
```

一周后上下文丢了，导演调 `recall("选角")`，拿到的就是这条，而不是一段要重新翻的历史。

**写法要点**：

- **写"现在是什么"，不写"发生过什么"。** 工具说明原文："Keep it current: what was decided, which peer owns it, what is open."

  | 写得差（流水账） | 写得好（当前结论） |
  | - | - |
  | `给用户看了五个候选，用户先选了1，后来又说2好，然后让art1做定妆` | `主演：casting/阿宁-2（用户选定）。定妆由 art1 负责。未决：无。` |

- **话题要短、稳定、粒度合适。** 同一件事的消息、任务、笔记，用一字不差的同一个话题。

  | 太粗 | 合适 | 太细 |
  | - | - | - |
  | `镜头` | `渡口-第3场` | `第3场第2次重拍` |
  | 什么都往里装，提示失去意义 | 一件事从头到尾用它 | 每次都变，接不上历史 |

- **什么时候 `remember`**：系统说明原文是 "After a decision, an agreement or a handoff"，即做了决定、达成一致、交接之后。
- **什么时候 `recall`**：联系同事谈一件可能有历史的事之前。

### 2.9 `load_skill`：读技能

**参数**：`name`。返回技能正文，以及技能旁边文件所在的目录。名字不对时报错并列出有哪些：`no skill "review". Your skills: brief, cut-review, dailies-review`。

技能有两种到达方式：

| 技能 | 怎么到达 | 靠不靠得住 |
| - | - | - |
| 声明了 `produces` 的 | 任务的 `produces` 与它相同时，中枢把正文附在任务后面 | 靠得住，不依赖模型 |
| 没声明的（如导演的 `dailies-review`） | 系统说明里只列名称和一句话，模型自己判断何时 `load_skill` | 取决于模型自觉 |

**场景**：摄影师交回第 2 场的小样，导演要审片。"审片"不产出资产，没有任务会把技能带过来，所以导演要自己 `load_skill("dailies-review")`。导演的说明里因此明确写了"你逐镜审，按技能 `dailies-review`"，给它一个提醒。

**写法要点**：见 4.3。

## 3. 原语怎么组合：回答三个问题

### 3.1 某一类任务，怎么知道该派给谁

要回答的其实是两个问题：

- **这类活谁会做？** 镜头表该找分镜师。这是静态的，看**契约**。
- **这件事之前是谁在跟？** 两位摄影师都会拍，但第 3 场一直是 `camera1` 在拍。这是动态的，看**记忆**。

**契约**来自技能的 `produces` / `inputs` 声明，出现在三个地方：系统说明的 "The team" 一节、`list_agents` 的 `produces` 一栏、`dispatch_task` 返回的契约提示（2.3）。

**记忆**分两层：

| | 话题账本 | 笔记 |
| - | - | - |
| 谁来记 | 中枢，自动。只要发过带话题的消息或任务就有记录，双方各记一笔 | 智能体自己，调 `remember` |
| 记什么 | 谁和谁就哪个话题打过几次交道、最后一次是什么时候 | 这个话题现在的结论 |
| 靠不靠得住 | 靠得住，重启后从消息日志重建 | 取决于模型有没有记 |

它们在五个时刻出现在模型眼前：

1. **开新会话**：写进系统说明最后一节。

   ```
   # Your memory at the start of this session
   - 渡口-选角 (with art1): 主演：casting/阿宁-2（用户选定）……
   - 渡口-第3场 (with camera1): no note yet
   ```

   第二行来自账本：这件事你和 `camera1` 谈过，但没记笔记。

2. **`list_agents`**：每位同事带 `topics_with_you`。
3. **派发或发消息给了另一个人**：返回里的话题提示（2.3 表格第三行）。
4. **收到带话题的消息或任务**：中枢附上接收方自己关于这个话题的笔记：

   ```
   Your own note on this topic:
   <xsb-memory topic="渡口-选角">
   主演：casting/阿宁-2（用户选定）……
   </xsb-memory>
   ```

5. **主动 `recall`**。

**组合起来，导演派一个活的完整过程是：**

```
1. 看系统说明的 The team：shot 由 camera1、camera2 产出         契约，静态
2. recall("第3场")：账本显示一直和 camera1 谈                   记忆，动态
3. dispatch_task(to: "camera1", topic: "渡口-第3场", produces: "shot", inputs: […])
4. 读返回的 note：没有提示，说明人、输入、话题都对上了            中枢兜底
```

第 2 步漏了也不要紧：派给 `camera2` 时，第 4 步会收到话题提示。中枢保证模型知情，换不换人由模型定。

| 问题 | 靠什么 | 谁保证 |
| - | - | - |
| 这类活谁会做 | 分工表（技能声明） | 中枢 |
| 这件事之前谁在跟 | 话题账本（实际流过的消息） | 中枢 |
| 当时定了什么 | 笔记 | 模型 |

### 3.2 等两个任务都回来再继续：没有待办清单

先给结论：**不是只靠对话历史，也没有待办清单。** 中枢记住"在等谁"（门），模型把"等到之后要做什么"写成一句 note 交给中枢保管，到时原样还回来。

#### 一条完整的时间线

导演要同时拍第 2、3 场，两场都过了才交剪辑。摄影师那边每个镜头又要后台生成。这里同时用到了 `dispatch_task`、`subscribe`、`start_job`、`put_asset` 四个原语，跨三个智能体：

```
director1                         camera1                              camera2
─────────                         ───────                              ───────
dispatch_task(camera1,"第2场")→t_21
dispatch_task(camera2,"第3场")→t_22
subscribe([t_21,t_22],
  note:"两场都回来后逐镜审……")
结束本轮（空闲）
                                  收到 t_21
                                  start_job(2-1 小样)→t_41
                                  start_job(2-2 小样)→t_42
                                  subscribe([t_41,t_42],
                                    note:"回来逐个检查，合格的登记")
                                  结束本轮 → t_21 保持开启              收到 t_22，同样处理……
用户："进度怎么样？"
回答（普通的一轮）
                                  t_41、t_42 生成完 → 第二轮
                                  检查，put_asset(shot/2-1)、(shot/2-2)
                                  以结果结束这一轮 → t_21 完成
                                                                       …… t_22 完成
门满足 → 合并结果 + note → 下一轮
逐镜审……
```

三个关键时刻：

**① 导演结束本轮后是空闲的。** 用户可以随时找它；`t_21` 先回来时，结果被门扣住，不打扰它。

**② `camera1` 第一轮结束时，`t_21` 没有完结。** 它为 `t_21` 启动的后台任务还在跑、结果会唤醒它，所以这一轮的结束不算完结（[KERNEL.md](KERNEL.md) 4）。生成结果回来后，它检查、登记，以结果结束那一轮，`t_21` 就此完成。要是它忘了登记要交的 `shot`，中枢会追问它（见 2.3 末尾"对方怎么交差"）。

**③ 导演收到合并结果时，交付物是中枢核对过的。**

```
<xsb-task-results waited-for="all">
<xsb-task-result task-id="t_21" by="camera1" topic="渡口-第2场" title="第2场" status="completed">
第 2 场 4 个镜头全部完成小样……2-3 重拍了两次，原因是……
Assets it delivered:
<xsb-asset id="shot/2-1" version="1" by="camera1" path="…">…</xsb-asset>
……
</xsb-task-result>
<xsb-task-result task-id="t_22" by="camera2" … status="failed">
3-2 的首帧有真人人脸，生成服务拒绝了……
</xsb-task-result>
</xsb-task-results>
Your own note for this moment: 两场都回来后逐镜审。全部通过就派 editor1 粗剪；有重拍的先退回，不要派剪辑。
```

`Assets it delivered` 是中枢按 `camera1` 点名的 id 从资产库里取的，不是照抄它自己的说法。`camera2` 没登记 `shot`，就交不了 `completed`，只能以 `failed` 交差并说明原因。最后一行是导演当初写给自己的 note。

#### 为什么 note 能替代待办清单

设想没有它。导演派出任务后，和用户聊了十几轮别的事。两场戏回来时，"我当初打算拿到之后干什么"埋在很长的历史里，可能翻错，也可能忘了还有条件要查。

有了 note，这句话**不在历史里等着被想起，而是跟着结果出现在最新的一轮**。它不是一张"接下来要做的事"的表，而是在每个等待点上挂一句话。中枢不理解它，只保管和送回；"是不是全部通过"仍由模型对着结果判断。

#### 另一种等法：`after`

上面是**派发者在等**。另一种是**让下游任务自己等**，派发者不用醒来中转：

```
dispatch_task(to: "board1",  title: "分镜画面", produces: "storyboard", …)              → t_31
dispatch_task(to: "editor1", title: "动态分镜", produces: "animatic", after: ["t_31"], …)
```

第二个任务先不投递。`t_31` 结束后，中枢把它送给剪辑师，附上 `t_31` 的结果和一句：

```
This task was held until the following tasks finished. Their results are your input; if one of them failed or is not sufficient, say so in your result instead of guessing.
```

前一个任务失败了也照样送过去，由剪辑师判断还能不能做。

| | `subscribe` | `after` |
| - | - | - |
| 谁在等 | 派发者 | 下游任务 |
| 等到之后 | 派发者醒来，自己决定下一步 | 下游直接开工 |
| 适合 | 中间要把关、要判断 | 纯粹的先后顺序 |

#### "现在做到第几步了"记在哪

没有一张进度表。信息分在四处：

| 记的是什么 | 在哪 | 怎么看 |
| - | - | - |
| 哪些任务没结束、谁在等什么 | 中枢（任务和门的日志） | `task_status()` 不带参数 |
| 等到之后要做什么 | 门上的 note | 随结果送回 |
| 整个流程的先后 | 统筹角色的说明文字 | 导演说明里的 11 步表格 |
| 已经定下来的结论 | 笔记 | `recall` |

要特别说明第三行：**流程顺序只是提示词，不是程序。** 导演说明写"前一步定稿，才派发依据它的下一步"，但中枢不会阻止它在剧本没定稿时就派镜头表。中枢管的是每一步的两头：进门时把输入和技能递到手上，出门时查有没有交东西。

### 3.3 资产的版本，和用户改主意之后

#### 有一个产物中心，名字永远指向最新版

团队要达成一致的东西都登记在资产库里（原语见 2.7）。版本规则：

```
.xsb/assets/script/渡口/
  v1.md      第一稿，还在，谁也不会去改它
  v2.md      第二稿     ← script/渡口 指的是它；script/渡口@1 指第一稿
```

导演昨天说过"依据 `script/渡口`"，今天这句话不用改，它自动指向新剧本。

版本也用来表达同一样东西的不同阶段。摄影师先出小样，登记为 `shot/2-1` 第 1 版；导演通过后出正式版，登记为第 2 版。剪辑师说"用 `shot/2-1`"，拿到的自然是正式版。成片的粗剪、导演版、锁定版也都是 `cut/渡口` 的版本。

#### 用户改了主意：这里没有机制，只有提示词

三个问题里，这是中枢做得最少的一处。

**场景**：片子拍了一半。阿宁的人物设定是 `character/阿宁` 第 1 版（深灰风衣），第 2、3 场的镜头都拍完了，第 1 场是一个渡口的空镜，第 4 场还在 `camera2` 的队列里。用户对导演说："阿宁的风衣换成红色吧。"

**导演说明期望的处理过程**，每一步对应的原语：

| 步 | 做什么 | 原语 |
| - | - | - |
| 1 | 先不动手，告诉用户代价："含阿宁的分镜画面和第 2、3 场共 9 个镜头要重新生成；第 1 场空镜、剧本、镜头表不受影响。确定要改吗？" | 无，是推理 |
| 2 | 用户确认后，立刻撤掉还在排队的第 4 场 | `cancel_task` |
| 3 | 派美术指导改人物设定 | `dispatch_task(to: "art1", inputs: ["character/阿宁"], produces: "character")` |
| 4 | 美术指导登记第 2 版 | `put_asset(type: "character", name: "阿宁", …)` |
| 5 | 依次重派分镜画面、重拍第 2、3、4 场 | `dispatch_task` + `after` 或 `subscribe` |
| 6 | 记下现在以哪一版为准 | `remember(topic: "渡口-人物", content: "阿宁改红色风衣，以 character/阿宁 v2 为准；第2、3场已按 v2 重拍。")` |

**其中中枢保证的和只靠模型的：**

| 中枢保证 | 只靠模型 |
| - | - |
| 人物设定出第 2 版，旧版保留 | 判断哪些旧产物作废 |
| 之后派出的任务拿到第 2 版 | 判断哪些不受影响 |
| 撤掉排队的任务 | 记住"现在以第 2 版为准" |

资产库此刻的样子：

```
character/阿宁     v1（灰风衣）  v2（红风衣）  ← 最新
shot/2-1           v1                         ← 照灰风衣拍的，但库里看不出来
shot/2-2           v1                         ← 同上
shot/1-1           v1                         ← 空镜，本来就不受影响
```

**中枢分不出后三行的区别。** 因为：

- 资产没有"草稿 / 定稿 / 作废"这样的状态。
- 没有记录"`shot/2-1` 是依据 `character/阿宁` 的哪一版做的"。
- 上游出了新版，下游不会被标记，也没人被通知。
- 用户不能直接在界面上改资产或标记作废，只能跟智能体说。

#### 模型凭什么判断

**一是分工表，它同时是一张"谁依赖谁"的图：**

```
- character: art1, from brief, script, casting
- shot_list: board1, from script, style_guide, character
- storyboard: board1, from shot_list, style_guide, character
- shot: camera1, camera2, from shot_list, storyboard, style_guide, character
- animatic: editor1, from shot_list, storyboard
```

改了 `character`，顺着找：`shot_list`、`storyboard`、`shot` 都依据它，`animatic` 又依据 `storyboard`；`script` 不依据它。

但这张图只精确到"类型"，所以两头都不准：

- **会多报。** 按图，镜头表也该重做；但换风衣颜色不改变镜头怎么拆，镜头表其实不用动。
- **分不到个体。** 图说得出"镜头依赖人物设定"，说不出"哪几个镜头里有阿宁"。第 1 场空镜不用重拍，是导演读镜头表看出来的。

判断错了（多做了白花钱，漏做了人物穿帮），没有任何东西会提醒它。

**二是几句规则：**

| 写在哪 | 说了什么 |
| - | - |
| 系统说明（所有人） | 改一个定义，是给同一个 id 登记新版本，不是起新 id |
| 系统说明（所有人） | 任务带来的资产是事实；有错或不够，在结果里说，不要悄悄重新定义 |
| 导演说明 | 用户改了主意，先说清这会让哪些已完成的工作作废，再执行 |
| 导演说明 | 改了主意立刻通知取消还在排队的任务 |
| 导演说明 | 用户选定后，把决定写进任务再往下派，并用 `remember` 记下来 |
| 美术指导说明 | 定稿后一个字都不要改：改一个词都可能让人物换一张脸 |
| 导演、剪辑师 | 成片始终是同一个 `cut/<片名>`；锁定画面后不再改取舍和顺序 |

#### 一个容易踩的点：版本在送达时才定

任务的 `inputs` 写 `character/阿宁`、不带版本号时，**是在任务送达那一刻才取最新版**，不是派发那一刻。任务在对方队列里排着的时候人物设定出了第 2 版，送到时拿到的就是第 2 版。多数时候这正是想要的；但"小样通过了，用完全相同的输入出正式版"这种场合，要写成 `character/阿宁@1` 把版本固定住。

#### 得失

好处：规则少；"名字永远指向最新版"让绝大多数引用不用维护；旧版本全留着，改错了能指回去。

风险：照旧版做的下游产物在库里和有效产物看起来一样，漏判一个，要到审片时才靠肉眼发现；"哪一版是用户确认过的"只在笔记里。

要补强，缺的是三条能确定的信息：登记资产时记下它用的输入各是第几版；上游出新版时在查询结果里提示"依据的版本已不是最新"；给资产一个由人确认的"定稿"标记。都没有实现。

## 4. 给角色写说明和技能：怎么把原语写进去

第 2 节讲的是模型怎么调原语。这一节讲写角色的人（用户，或预设团队的作者）怎么写 `instructions.md` 和 `SKILL.md`，让模型在对的时候调对的原语。

### 4.1 三处各写什么

| 写在哪 | 写什么 | 不写什么 |
| - | - | - |
| `instructions.md` | 岗位原则；统筹角色再写流程的**顺序和关口** | 谁做什么（分工表会算出来）；原语的通用用法（系统说明里有） |
| 技能 front matter | `description`、`produces`、`inputs` | 别的字段中枢不读 |
| 技能正文 | 这类工作的步骤：登记成什么 id、什么格式、用哪个工具和参数、交付前自查什么、结果里写什么 | 角色原则（放说明里） |

一个判断标准：**同一句话如果对所有角色都成立，它属于系统说明，不要写进角色。** "派任务要写清楚""等结果要结束本轮"都是这类。

### 4.2 写进说明的：顺序、关口、和"什么时候调哪个原语"

预设导演说明里的几句，示范了怎么写：

| 说明原文 | 落到哪个原语 |
| - | - |
| "前一步定稿，才派发依据它的下一步。派发时用 `inputs` 写明依据哪些资产，用 `produces` 写明要交什么。" | `dispatch_task` 的两个字段 |
| "镜头互不依赖的场可以同时派给多位摄影师，用 `subscribe` 订阅它们，结果一起回来。" | 并行 + 汇合 |
| "用户选定后，把决定写进任务再往下派，并用 `remember` 记下来。" | `instructions` 的写法 + `remember` 的时机 |
| "改了主意立刻通知取消还在排队的任务。" | `cancel_task` 的时机 |
| "你逐镜审，按技能 `dailies-review`。" | 提醒 `load_skill` |

共同点：**不解释原语是什么，只说在这个岗位上什么时候用。** 原语的用法系统说明里已经讲过，角色说明负责把它和业务里的时刻对上。

### 4.3 写进技能的：具体到工具名和参数

预设摄影师的 `shot` 技能，流程部分是这样写的：

```
3. 为每个镜头写提示词（见下），用 `start_job` 提交：`server: "media"`，`tool: "generate_video"`，小样分辨率。
4. 用 `subscribe` 订阅这些后台任务，然后结束本轮：任务会保持开启，结果回来时接着做。回来后检查文件，不合格的调整后重拍（再提交、再 `subscribe`）。
5. 用 `put_asset` 把每个小样登记为 `shot/<镜号>`（`path` 指向视频文件），描述里写提示词与参数，并注明是小样。以交给导演审的内容结束本轮，写明这些小样；这个任务到此结束。
6. 导演通过后会再派任务出正式版：……登记为同一个 `shot/<镜号>` 的新版本，描述里注明是正式版。
```

几个值得学的地方：

- **写到参数级**：`server: "media"`、`tool: "generate_video"`，模型不用猜。
- **说清这一步之后发生什么**："任务会保持开启，结果回来时接着做"。模型知道结束本轮不等于交差。
- **把业务阶段映射成版本**：小样和正式版是同一个 id 的两个版本，`description` 里注明是哪个。
- **说清任务在哪里结束**："这个任务到此结束"，正式版是导演另派的任务。
- **结果里要写什么单列一节**（该技能末尾"结果里要写"：镜号、资产 id、生成了几次、重拍原因、取消过的任务是否计费）。派发者要靠这些做判断。

**声明了 `produces` 的技能和没声明的，写法不同：**

| | 声明了 `produces` | 没声明 |
| - | - | - |
| 怎么到达 | 随任务自动附上 | 模型自己 `load_skill` |
| 开头要写 | 不用写"什么时候用"，来了就是要用 | `description` 要让模型一看就知道什么时候该读它 |
| 例 | `shot_list`：`description: 把一场戏或全片拆成镜头表` | `dailies-review`：`description: 审看生成的镜头，决定通过或重拍` |

能声明 `produces` 的就声明：靠得住的路径比靠自觉的路径好。审片、拆解任务这类不产出资产的工作没法声明，那就在角色说明里点名提醒（4.2 表格最后一行）。

### 4.4 例子：给剧组加一位作曲

预设剧组没有配乐（导演说明："这支剧组没有单独的配乐和配音工具"）。假设用户接入了一个能生成音乐的工具服务，想加一位作曲。下面的角色是**为讲解假设的**，工具服务 `music-mcp` 和它的 `generate_music` 工具都不存在。

**第一步：`role.json`**，配上工具服务。只有这个角色的智能体拿得到它，所以只有作曲能 `start_job` 去生成音乐。

```json
{
  "description": "按锁定画面的成片写配乐，交付与画面等长的音乐",
  "mcpServers": {
    "music": { "command": "music-mcp", "env": { "MUSIC_API_KEY": "…" } }
  }
}
```

**第二步：`instructions.md`**，只写岗位原则，几行就够：

```
你是作曲。你为锁定画面之后的成片写配乐。

- **只在画面锁定之后工作**。画面没锁就配乐，剪辑一改全部白做。
- **音乐服务于情绪，不抢对白**。有对白的段落压低或留白。
- **生成按量计费**。先出一段 30 秒的小样定调，导演通过后再出全长。
```

**第三步：技能 `skills/score/SKILL.md`**，声明契约，正文写到原语和参数：

```
---
description: 为锁定的成片写配乐
produces: score
inputs: brief, cut
---
# 配乐

1. 读输入：`brief` 里的基调与"观众看完的感受"，`cut` 的最新版。用 `get_asset` 取得成片文件路径，
   用 `ffprobe` 读出总时长。
2. 按成片列出情绪段落：起止时间、情绪、有没有对白。
3. 先出 30 秒小样定调：`start_job`，`server: "music"`，`tool: "generate_music"`。
   然后 `subscribe` 订阅它并结束本轮，任务会保持开启。
4. 结果回来后自己听一遍。不合格就改描述重出，一次只改一处。
5. 用 `put_asset` 登记为 `score/<片名>`，描述里注明是小样、时长、用的描述词。
   以交给导演审的内容结束本轮，写明它；这个任务到此结束。
6. 导演通过后会另派任务出全长：登记为同一个 `score/<片名>` 的新版本，描述里注明是全长。

## 结果里要写
段落表；资产 id 与版本；是小样还是全长；生成了几次、每次为什么重来。
```

**写完之后自动发生的事**（不需要改任何别处）：

- 每个智能体的系统说明下次绑定时，"The team" 一节多一行：`- score: composer1, from brief, cut`。
- 导演 `list_agents` 时看得到 `composer1` 能产出 `score`。
- 导演派 `produces: "score"` 给作曲时，这篇技能自动附在任务后面。
- 导演漏了 `cut` 输入时，返回里提示缺 `cut`。

**还要改的一处**：导演的说明。流程表里加一步"锁定画面后派作曲出配乐，你审，再交剪辑师混入"，并去掉"没有配乐工具"那一句。分工表只告诉导演"谁会做"，**什么时候做、做完谁审，仍要写进统筹角色的说明。**

### 4.5 常见的写法错误

| 错误 | 后果 | 改成 |
| - | - | - |
| 在说明里写"镜头表交给分镜师做" | 改了团队成员就过时；和算出来的分工表重复 | 删掉，靠 "The team" |
| 技能声明 `produces: shotlist`，别处都写 `shot_list` | 契约对不上：任务不会附上技能，派发时提示"没人能产出" | 类型名全团队统一 |
| 技能里写"生成视频" | 模型可能直接调 `generate_video` 卡住几分钟 | 写"用 `start_job` 提交，`server: "media"`……" |
| 技能里写"做完交给导演" | 模型可能用 `send_message` 发过去，任务却没交付 | 写"在结果里交导演审"，并说明任务在哪里结束 |
| 技能里没写登记成什么 id | 各人各起名字，`find_assets` 找不到 | 写明 `shot/<镜号>` 这样的格式 |
| 不产出资产的技能（如审片）没在说明里点名 | 模型不一定想到去 `load_skill` | 在角色说明里写"按技能 `…`" |

## 5. 归纳：这套提示词的几个做法

| 做法 | 例子 |
| - | - |
| **用得上的时候才递过来** | 镜头表的做法不在分镜师的系统说明里，随"做镜头表"的任务一起到 |
| **提示，不拦截** | 派给了编剧，任务照发，返回里说"做这个的是 board1" |
| **让模型把"之后要做的事"存在中枢** | `subscribe` 的 note，随结果原样送回 |
| **事实由中枢写，不由模型说** | "该交镜头，但没登记"是中枢查库写的 |
| **在模型可能忘的时刻重说一遍** | 任务保持开启后，结果回来时重说"你在替谁做哪个任务、要交什么" |
| **讲道理，而不只下禁令** | 不说"禁止轮询"，说"结果在这一轮结束后才能送达，轮询只会让它更晚" |
| **角色的能力来自声明** | 技能的 `produces` 同时决定分工表、技能随任务附上、派错时的提示 |
| **要求如实汇报** | 任务结果要写明没做到、没验证的部分；前置任务失败也照样送达并要求说明 |

## 6. 哪些没有验证过

本文是读代码和预设文字写成的，没有运行系统。[DESIGN.md](DESIGN.md) 第 8 节写明：真实模型会不会照分工表派发、会不会正确使用 `inputs` 和 `produces`、话题换人的提示有没有用，都只用模拟的后端测过；电影团队的流程没有用真实模型完整跑过一部片子。

第 3.3 节"改主意之后判断作废范围"尤其如此：它完全是提示词行为，没有测试覆盖，文中的处理过程是导演说明期望的样子，不是观察到的结果。第 4.4 节的作曲角色是假设的，没有写进预设，也没有跑过。

## 附：代码在哪

| 内容 | 位置 |
| - | - |
| 系统说明、标签的包装、记忆摘要、结果块 | [prompts.ts](../packages/hub/src/prompts.ts) |
| 原语的参数、说明、返回、三种提示 | [tools.ts](../packages/hub/src/tools.ts) |
| 派发、汇合、`after`、撤回与传染、通知、台账 | [kernel.ts](../packages/hub/src/kernel.ts)（[KERNEL.md](KERNEL.md)） |
| 投进会话、后台任务 | [delivery.ts](../packages/hub/src/delivery.ts)、[jobs.ts](../packages/hub/src/jobs.ts) |
| 话题账本、笔记、门的数据 | [state.ts](../packages/hub/src/state.ts) |
| 资产库 | [assets.ts](../packages/hub/src/assets.ts) |
| 角色与技能声明的读取 | [roles.ts](../packages/hub/src/roles.ts) |
| 分工表的计算 | [hub.ts](../packages/hub/src/hub.ts) 的 `team()` |
| 预设团队的角色与技能 | [presets/zh-CN/](../packages/hub/presets/zh-CN) |
