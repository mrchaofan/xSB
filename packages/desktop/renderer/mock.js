// 假的 window.xsb：在浏览器里直接打开 index.html 时用它，界面可以脱离 Electron 和 Hub 运行。
// Electron 里不加载这个文件：那里的 window.xsb 由 preload 提供，数据来自 ../src/workspace.ts。
// 两者遵守同一份契约，写在 ../src/bridge.ts。
// entry、agent、task、artifact 按 id 覆盖，role 按 name 覆盖：同一个键再次到达表示它更新了。
(() => {
  const listeners = new Set();
  const emit = (event) => listeners.forEach((listener) => listener(structuredClone(event)));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let seq = 0;
  const id = () => `e${++seq}`;
  const at = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60000).toISOString();
  const dataUrl = (mime, text) => `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;

  // 界面的语言：地址里的 ?lang=en 或 ?lang=zh-CN，否则跟随浏览器。Electron 里由主进程决定。
  const asked = new URLSearchParams(location.search).get("lang");
  const language = ["zh-CN", "en"].includes(asked) ? asked : navigator.language.startsWith("zh") ? "zh-CN" : "en";
  /** mock 自己说的话（冒充中枢的报错），按语言给。样例内容不在此列，保持中文。 */
  const say = (zh, en) => (language === "en" ? en : zh);

  // ---------- 样例内容 ----------

  const SCRIPT_MD = `# 第三场　渡口　夜

## 场景

深秋，夜里十一点。末班渡船已经停了，码头只剩售票亭的一盏灯。江面有雾，对岸的灯光是一条模糊的线。

## 人物

- **阿宁**，三十岁，背着一只旧帆布包
- **老周**，售票员，六十出头

## 正文

阿宁走到售票亭前，窗口已经关了一半。

**阿宁**　还有船吗？

**老周**　（没抬头）最后一班九点四十。

阿宁没有走。她把包放在长椅上，坐下，看着江面。

**老周**　（终于抬头）你等谁？

**阿宁**　不等谁。等天亮。

老周看了她一会儿，把窗口重新推开，递出一只搪瓷杯。

## 改动说明

- 原稿是黄昏，现在改为夜里，删掉了"夕阳"相关的三处描写
- 售票亭的灯成为唯一的实景光源，请灯光注意
- 结尾递杯子的动作需要看得清手，但不要看清脸`;

  const GEAR_CSV = `器材,数量,日租金,天数,小计
Aputure 600d,2,480,2,1920
Nova P300c,1,360,2,720
Astera Titan 管灯,4,120,2,960
烟雾机,1,200,2,400
黑旗 4x4,6,30,2,360
合计,,,,4360`;

  const LIGHT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 340" font-family="-apple-system, PingFang SC, sans-serif" font-size="11">
<rect width="480" height="340" fill="#fff"/>
<path d="M0 70h480" stroke="#000" stroke-dasharray="3 5"/><text x="12" y="52">江面（烟雾机在下风处）</text>
<rect x="60" y="110" width="360" height="170" fill="none" stroke="#000"/><text x="68" y="126">码头平台</text>
<rect x="300" y="150" width="80" height="60" fill="#000"/><text x="308" y="228">售票亭</text>
<rect x="110" y="220" width="110" height="18" fill="none" stroke="#000"/><text x="118" y="254">长椅</text>
<circle cx="340" cy="140" r="7" fill="#fff" stroke="#000" stroke-width="2"/><text x="352" y="138">实景灯 2700K</text>
<path d="M40 300l22-22M40 278l22 22" stroke="#000" stroke-width="2"/><text x="20" y="322">主光 600d 过柔光布</text>
<path d="M330 150L170 226" stroke="#000" stroke-dasharray="2 4"/>
<path d="M52 288L160 232" stroke="#000" stroke-dasharray="2 4"/>
<path d="M430 86h36" stroke="#000" stroke-width="4"/><text x="372" y="100">轮廓光 管灯×4</text>
</svg>`;

  const BOARD_HTML = `<!doctype html><meta charset="utf-8"><style>
body{font:13px/1.6 -apple-system,"PingFang SC",sans-serif;margin:24px;color:#000}
h1{font-size:18px;margin:0 0 16px}table{border-collapse:collapse;width:100%}
td,th{border-top:1px solid #000;padding:8px 10px 8px 0;text-align:left;vertical-align:top}th{font-weight:600}
</style><h1>第三场　分镜表</h1><table>
<tr><th>镜</th><th>景别</th><th>内容</th><th>光</th></tr>
<tr><td>1</td><td>大全景</td><td>码头与江面，售票亭一点暖光</td><td>只开实景灯和轮廓光</td></tr>
<tr><td>2</td><td>中景</td><td>阿宁走到窗口前问船</td><td>主光从左后方，脸在半影里</td></tr>
<tr><td>3</td><td>近景</td><td>老周没抬头</td><td>实景灯顶光</td></tr>
<tr><td>4</td><td>全景</td><td>阿宁坐到长椅上看江</td><td>主光降一档，雾里有轮廓</td></tr>
<tr><td>5</td><td>特写</td><td>窗口里递出搪瓷杯，只见手</td><td>实景灯，杯沿高光</td></tr>
</table>`;

  // ---------- 状态 ----------

  const spec = (agentId, name, role, backend, description, state, instructions = "") =>
    ({ id: agentId, name, role, backend, description, state, instructions, workspace: "~/Films/dukou", createdAt: at(600) });
  const addr = (agentId) => ({ agentId, sessionId: `${agentId}-main` });
  // from 为空：用户起的任务，没有派发方的会话
  const task = (taskId, title, from, to, status, produces, after = []) =>
    ({ id: taskId, title, topic: "第三场", instructions: title, initiator: from ? { kind: "agent", agentId: from } : { kind: "user" }, ...(from ? { from: addr(from) } : {}), to: addr(to), after, produces, status, createdAt: at(12), updatedAt: at(3) });
  const artifact = (artifactId, name, kind, agentId, mime, text, minutesAgo = 0) =>
    ({ id: artifactId, name, kind, agentId, path: `.xsb/shared/${name}`, url: dataUrl(mime, text), updatedAt: at(minutesAgo) });
  const md = (text) => [{ type: "text", text }];      // 内容：一组 ACP 内容块，见 ../src/content.ts
  const fromUser = (content) => ({ id: id(), kind: "input", origin: { kind: "user" }, content });
  const fromAgent = (agentId, taskId, text) => ({ id: id(), kind: "input", origin: { kind: "agent", agentId, role: "task", taskId }, content: md(text) });
  const said = (text) => ({ id: id(), kind: "output", content: md(text) });
  const tool = (title, artifactId) => ({ id: id(), kind: "tool", title, status: "done", artifactId });

  const lightPlan = artifact("a3", "第三场-布光图.svg", "image", "gaffer1", "image/svg+xml", LIGHT_SVG);
  const board = { ...artifact("a4", "第三场-分镜表.html", "html", "director", "text/html", BOARD_HTML), assetType: "storyboard" };
  const permission = { id: id(), kind: "permission", detail: "python3 budget.py --scene 3 --days 2" };

  const BACKENDS = [
    { name: "claude", command: "claude-agent-acp", installed: true },
    { name: "codex", command: "codex-acp", installed: true },
  ];
  const skill = (name, produces, description, body, inputs = "") => ({ name, produces, inputs, description, body });

  /** 应用自带的一支预设团队（原型里只放了一个角色作示意）。 */
  const TEAM = { id: "film", title: "电影创作", description: "一支 AI 短片剧组（原型里只放了一个角色作示意）。", assets: { script: "剧本", brief: "创作简报" }, roles: [{
    name: "编剧",
    role: { avatar: "person-screenwriter", name: "screenwriter", preset: null, description: "把想法写成标准格式的剧本", backend: "", instructions: "你是编剧。只写看得见、听得见的内容。",
      mcpServers: [{ name: "media", command: "xsb-media-mcp", args: [], env: [] }],
      skills: [skill("script", "script", "写或改一场戏的剧本", "# 剧本\n\n- **场景标题**：场号、内或外、地点、时间\n- **动作**：现在时，一段一个节拍", "brief")] },
    missing: [{ command: "ffmpeg", install: "剪辑用 ffmpeg。请自行安装（如 brew install ffmpeg），或指定它的位置。" }] }] };

  const sample = {
    workspace: { name: "短片《渡口》", path: "~/Films/dukou" },
    backends: BACKENDS,
    teams: [],            // 这个工作区使用的预设团队
    assetNames: { script: "剧本", lighting_plan: "布光方案", storyboard: "分镜表" },
    roles: [
      { avatar: "person-director", name: "director", preset: null, description: "统筹全片，拆解并派发工作", backend: "claude",
        instructions: "你是这部短片的导演。把用户的要求拆成任务派给合适的同事，等结果到齐后再做决定。不要自己写剧本或出布光方案。",
        mcpServers: [],
        skills: [skill("review", null, "评审同事交来的产出", "# 评审\n\n1. 对照任务要求逐条核对\n2. 指出与其他资产不一致的地方\n3. 不合格就退回，并写明要改什么")] },
      { avatar: "person-screenwriter", name: "writer", preset: null, description: "写剧本和对白", backend: "codex",
        instructions: "你是编剧。只改被要求改的那一场，改动之处在文末列出。",
        mcpServers: [],
        skills: [skill("script", "script", "写或改一场戏的剧本", "# 剧本\n\n1. 先读原稿和相关的人物资产\n2. 按「场景、人物、正文、改动说明」四段来写\n3. 用 put_asset 登记为 script/<场次>")] },
      { avatar: "animal-deer", name: "gaffer", preset: null, description: "设计布光方案", backend: "codex",
        instructions: "你是灯光师。方案必须以剧本资产为准，实景光源要在图上标出色温。",
        mcpServers: [{ name: "render", command: "npx", args: ["-y", "@acme/light-render-mcp"], env: [{ name: "RENDER_API_KEY", value: "demo-key-not-real" }] }],
        skills: [
          skill("lighting", "lighting_plan", "出一场戏的布光图和说明", "# 布光方案\n\n1. 读剧本资产，找出实景光源\n2. 画俯视布光图（SVG）\n3. 用 put_asset 登记为 lighting_plan/<场次>", "script"),
          skill("budget", null, "按天数核算器材租金", "# 器材预算\n\n逐项核对数量、日租金和天数，再与清单里的小计对照。"),
        ] },
    ],
    agents: [
      spec("director", "导演", "director", "claude", "统筹全片，拆解并派发工作", "idle"),
      spec("writer", "编剧", "writer", "codex", "写剧本和对白", "idle"),
      spec("gaffer1", "灯光师1", "gaffer", "codex", "设计布光方案", "running"),
      spec("gaffer2", "灯光师2", "gaffer", "claude", "核对器材与预算", "requires_action", "你主要负责器材和预算，布光图交给灯光师1。"),
    ],
    tasks: [
      task("t0", "拍好第三场", null, "director", "running"),
      task("t1", "第三场改写为夜戏", "director", "writer", "completed", "script"),
      task("t2", "第三场夜景布光方案", "director", "gaffer1", "running", "lighting_plan", ["t1"]),
    ],
    artifacts: [
      artifact("a1", "第三场-夜戏.md", "markdown", "writer", "text/plain", SCRIPT_MD, 4),
      artifact("a2", "器材清单.csv", "text", "gaffer2", "text/plain", GEAR_CSV, 9),
    ],
    transcripts: {
      director: [
        fromUser(md("第三场改成夜戏，今天把分镜定下来。")),
        said("好。改成夜戏会同时牵动剧本和布光，我先让编剧改稿，稿子出来后交给灯光师1出布光方案，两份都到了再定分镜。"),
        tool("dispatch_task → 编剧　第三场改写为夜戏"),
        tool("dispatch_task → 灯光师1　第三场夜景布光方案（在 t1 之后）"),
        tool("await_tasks [t1, t2]　两份都到了再定分镜"),
        said("已派发。两份结果到齐后我会接着排分镜，这期间你可以继续跟我说话。"),
      ],
      writer: [
        fromAgent("director", "t1", "把第三场从黄昏改成夜里十一点。保留阿宁和老周的对话，注意哪些描写依赖日光。改完放到共享目录。"),
        tool("读取 scenes/03.md"),
        tool("写入 shared/第三场-夜戏.md", "a1"),
        said("改完了，三处改动：\n\n- 删掉了三处和夕阳有关的描写\n- 售票亭的灯现在是场景里**唯一的实景光源**\n- 结尾递杯子的动作写成只见手、不见脸，方便灯光处理\n\n文件在 `shared/第三场-夜戏.md`。"),
      ],
      gaffer1: [
        fromAgent("director", "t2", "按夜戏版本的第三场出布光方案。前置任务 t1 的结果：剧本已改，见 shared/第三场-夜戏.md。"),
        tool("读取 shared/第三场-夜戏.md", "a1"),
      ],
      gaffer2: [
        fromUser(md("核对一下第三场器材清单的租金，按两天算。")),
        tool("读取 shared/器材清单.csv", "a2"),
        said("清单里有六项器材。我用预算脚本按两天重新算一遍，再和表里的小计对照。"),
        permission,
      ],
    },
  };

  // ---------- 回合 ----------

  let data = null;      // 这个窗口打开的工作区；null = 还没打开
  let turns = {};
  const agent = (agentId) => data.agents.find((a) => a.id === agentId);
  const blank = (path) => ({ workspace: { name: path.split("/").pop(), path }, backends: BACKENDS, teams: [], assetNames: {}, roles: [], agents: [], tasks: [], artifacts: [], transcripts: {} });

  function put(agentId, entry) {
    const list = data.transcripts[agentId];
    const i = list.findIndex((e) => e.id === entry.id);
    if (i < 0) list.push(entry); else list[i] = entry;
    emit({ agentId, entry });
  }
  function setState(agentId, state) {
    agent(agentId).state = state;
    emit({ agent: agent(agentId) });
  }
  function setTask(taskId, status) {
    const t = data.tasks.find((x) => x.id === taskId);
    Object.assign(t, { status, updatedAt: at() });
    emit({ task: t });
  }

  /** 智能体此刻在做什么；null 表示这一轮结束了。 */
  const activities = {};
  function does(agentId, kind, detail) {
    if (kind) activities[agentId] = { kind, detail, since: at() }; else delete activities[agentId];
    emit({ agentId, activity: activities[agentId] ?? null });
  }

  /** 一轮 = 依次执行的步骤：{ say } 流式输出，{ tool, artifact? } 一次工具调用，{ then } 回合内的副作用。 */
  async function runTurn(agentId, steps) {
    const turn = turns[agentId];
    Object.assign(turn, { busy: true, cancelled: false });
    setState(agentId, "running");
    for (const step of steps) {
      if (turn.cancelled) break;
      does(agentId, "waiting");
      await sleep(1500);
      if (turn.cancelled) break;
      if (step.say) {
        does(agentId, "writing");
        const entry = { id: id(), kind: "output", content: md(""), streaming: true };
        for (const chunk of step.say.match(/.{1,3}/gs)) {
          if (turn.cancelled) break;
          entry.content = md(entry.content[0].text + chunk);
          put(agentId, { ...entry });
          await sleep(45);
        }
        put(agentId, { ...entry, streaming: false });
      } else if (step.tool) {
        const entry = { id: id(), kind: "tool", title: step.tool, status: "running" };
        does(agentId, "tool", step.tool);
        put(agentId, entry);
        await sleep(900);
        if (step.artifact) {
          const meta = { ...step.artifact, updatedAt: at() };
          data.artifacts.push(meta);
          emit({ artifact: meta });
        }
        put(agentId, { ...entry, status: "done", artifactId: step.artifact?.id });
      } else if (step.then) {
        step.then();
      }
    }
    endTurn(agentId);
  }

  function endTurn(agentId) {
    if (!agent(agentId)) return;           // 这一轮进行中 Agent 被删除了
    const turn = turns[agentId];
    const next = turn.queue.shift();
    if (next) {
      // 排着的邮件轮到了：它在这一轮开始的位置第一次出现
      put(agentId, next.entry);
      runTurn(agentId, next.steps);
    } else {
      turn.busy = false;
      does(agentId, null);
      setState(agentId, "idle");
    }
  }

  /** 把一条输入送进会话：空闲则开始一轮；忙时，用户的话插进当前这一轮（永不排队），邮件排到这一轮之后。 */
  function deliver(agentId, entry, steps) {
    const turn = turns[agentId];
    if (!turn.busy) { put(agentId, entry); runTurn(agentId, steps); }
    else if (entry.origin.kind === "user") put(agentId, { ...entry, origin: { ...entry.origin, steered: true } });
    else turn.queue.push({ entry, steps });
  }

  const reply = (agentId) => [{ say: `收到，我按这个来调整。（这是原型里的示意回复，真实内容来自 ${agent(agentId).backend} 后端。）` }];

  // 开场：灯光师1 正在出方案；它完成后，汇合门满足，导演接着排分镜。
  const opening = [
    { say: "夜戏的关键是让售票亭那盏灯看起来是唯一的光源，其他灯都要藏在它的逻辑里。" },
    { tool: "写入 shared/第三场-布光图.svg", artifact: lightPlan },
    { say: "方案出好了：主光放在画左后方过柔光布，模拟售票亭灯的漫射；江面一侧四支管灯做轮廓，让人物从雾里分离出来；递杯子的特写只用实景灯。" },
    { then: () => {
      setTask("t2", "completed");
      deliver("director",
        { id: id(), kind: "input", origin: { kind: "system", role: "task_result" }, content: md("t1 和 t2 都已完成。\n你的备注：两份都到了再定分镜。\n\nt1（编剧）：剧本已改为夜戏，见 shared/第三场-夜戏.md\nt2（灯光师1）：布光方案见 shared/第三场-布光图.svg") },
        [
          { say: "两份都到了，剧本和布光对得上，我来排分镜。" },
          { tool: "写入 shared/第三场-分镜表.html", artifact: board },
          { say: "分镜表排好了，共五个镜头。第五镜的特写按编剧的意思只拍手，灯光用实景灯就够。你看一下，没问题的话我通知大家按这版准备。" },
        ]);
    } },
  ];

  /** 停止当前这一轮。重启后端进程在原型里也是它：正在进行的那一轮就此结束。 */
  function stop(agentId) {
    turns[agentId].cancelled = true;
    turns[agentId].queue = [];
    data.tasks.filter((task) => task.to.agentId === agentId && ["blocked", "queued", "running"].includes(task.status)).forEach((task) => setTask(task.id, "cancelled"));
    if (agent(agentId).state !== "requires_action") return;
    const pending = data.transcripts[agentId].find((e) => e.kind === "permission" && !e.outcome);
    put(agentId, { ...pending, outcome: "cancelled" });
    endTurn(agentId);
  }

  /** 预设团队的一个角色在工作区里的样子：preset 里带上团队给它起的显示名。 */
  const presetOf = (roleName, own) => ({ team: TEAM.id, teamTitle: TEAM.title, own, title: TEAM.roles.find((entry) => entry.role.name === roleName).name });

  window.xsb = {
    language,

    // ---------- 工作区 ----------
    load: async () => structuredClone(data ? { ...data, pages: null } : { workspace: null, recent: [sample.workspace], backends: BACKENDS }),
    pickFolder: async () => ({ path: "~/Films/new-short", initialized: false }),   // Electron：系统的选择文件夹对话框
    async open(path) {                                                             // 未初始化的文件夹会先创建 .xsb
      data = path === sample.workspace.path ? sample : blank(path);
      turns = Object.fromEntries(data.agents.map((a) => [a.id, { busy: a.state !== "idle", cancelled: false, queue: [] }]));
      if (data === sample) setTimeout(() => runTurn("gaffer1", opening), 1500);
    },
    newWindow() { window.open(location.href); },
    on(listener) { listeners.add(listener); },
    // 网页由 Electron 的主进程持有，浏览器里没有：标签栏不出现，HTML 制品退回到 iframe 预览
    openPage: async () => null,
    copyText: (text) => navigator.clipboard.writeText(text),
    async openArtifact(href) {
      const decoded = decodeURIComponent(href).replace(/:\d+(?::\d+)?$/, "");
      const artifact = data.artifacts.find((a) => a.id === decoded || a.url === href || decoded.endsWith(a.path) || decoded.endsWith(a.name));
      if (!artifact) throw new Error(`File not found: ${href}`);
      return structuredClone(artifact);
    },
    async page() {},

    // ---------- 对话 ----------
    send(agentId, content) { deliver(agentId, fromUser(content), reply(agentId)); },
    pathOf: (file) => file.name,   // Electron：文件在磁盘上的路径
    cancel: stop,
    clear(agentId) { put(agentId, { id: `b${Date.now()}`, kind: "boundary", boundary: { kind: "cleared", handoff: false } }); },
    permit(entryId, allow) {
      const [agentId, entries] = Object.entries(data.transcripts).find(([, list]) => list.some((e) => e.id === entryId));
      const pending = entries.find((e) => e.id === entryId);
      put(agentId, { ...pending, outcome: allow ? "allowed" : "rejected" });
      runTurn(agentId, allow
        ? [{ tool: "python3 budget.py --scene 3 --days 2" }, { say: "核对完了。六项器材两天合计 4360 元，和清单里的小计一致，没有算错的地方。" }]
        : [{ say: "好，我不运行脚本，改为逐行手算：六项器材两天合计 4360 元，和清单一致。" }]);
    },

    // ---------- Agent ----------
    async putAgent(spec) {
      const old = agent(spec.id);
      const next = { state: "idle", createdAt: at(), ...old, ...spec, workspace: spec.workspace || data.workspace.path };
      if (!old) {
        data.agents.push(next);
        data.transcripts[spec.id] = [];
        turns[spec.id] = { busy: false, cancelled: false, queue: [] };
      } else {
        const restart = ["role", "backend", "workspace"].some((key) => old[key] !== next[key]);
        Object.assign(old, next, { state: old.state });
        if (restart) stop(spec.id);
      }
      emit({ agent: agent(spec.id) });
      return structuredClone(agent(spec.id));
    },
    async removeAgent(agentId) {
      stop(agentId);
      data.tasks.filter((t) => t.to.agentId === agentId && ["blocked", "queued", "running"].includes(t.status)).forEach((t) => setTask(t.id, "failed"));
      data.agents = data.agents.filter((a) => a.id !== agentId);
      emit({ removedAgent: agentId });
    },
    /** 编辑一个 Agent 时要看的：它自己的补充说明，和模型实际看到的系统说明全文。 */
    async inspectAgent(agentId) {
      const a = agent(agentId);
      const role = data.roles.find((r) => r.name === a.role);
      const systemPrompt = [
        `# 你是谁\n你是「${a.name}」（${a.id}）。${a.description}`,
        [role?.instructions, a.instructions].filter(Boolean).join("\n\n"),
        role?.skills.length && `# 技能\n${role.skills.map((s) => `- ${s.name}：${s.description}${s.produces ? `（随产出 ${s.produces} 的任务自动附上）` : ""}`).join("\n")}`,
        `# 团队\n${data.agents.filter((x) => x.id !== a.id).map((x) => `- ${x.name}：${x.description}`).join("\n") || "暂无其他成员"}\n用 dispatch_task 派发任务，用 send_message 发消息，结果会稍后以消息形式送回。`,
        "# 记忆\n第三场：已改为夜戏，售票亭的灯是唯一的实景光源。",
      ].filter(Boolean).join("\n\n");
      return { instructions: a.instructions, systemPrompt };
    },

    // ---------- 角色 ----------
    /** 保存的总是工作区自己的角色：预设团队的角色保存后，工作区改用自己的版本。 */
    async putRole(role) {
      const next = { ...structuredClone(role), preset: role.preset && { ...role.preset, own: true } };      // title 随之保留
      const i = data.roles.findIndex((r) => r.name === role.name);
      if (i < 0) data.roles.push(next); else data.roles[i] = next;
      emit({ role: next });
      return structuredClone(next);
    },
    /** 删除工作区自己的角色。预设团队也有这个角色时，改回预设的版本。 */
    async removeRole(name) {
      const shipped = TEAM.roles.find((entry) => entry.role.name === name)?.role;
      data.roles = data.roles.filter((r) => r.name !== name);
      if (data.teams.includes(TEAM.id) && shipped) { data.roles.push({ ...structuredClone(shipped), preset: presetOf(name, false) }); emit({ role: data.roles.at(-1) }); }
      else emit({ removedRole: name });
    },
    /** 重启一个 Agent 的后端进程，让改过的角色从下一轮起生效。 */
    async applyRole(roleName, completed = []) {
      const done = data.agents.filter((a) => a.role === roleName).map((a) => a.id);
      done.filter((id) => !completed.includes(id)).forEach(stop);
      return { done };
    },
    /** 把角色现在的描述和后端给它的每个智能体。 */
    async syncRole(roleName) {
      const role = data.roles.find((r) => r.name === roleName);
      const done = [];
      for (const a of data.agents.filter((x) => x.role === roleName)) { await this.putAgent({ ...a, description: role.description, backend: role.backend || a.backend }); done.push(a.id); }
      return { done };
    },
    /** 使用一支团队，并给还没有智能体的角色各建一个。 */
    async buildTeam(teamId, backend) {
      await this.useTeam(teamId);
      const done = [];
      for (const { name, role } of TEAM.roles) {
        if (agent(role.name)) continue;
        await this.putAgent({ id: role.name, name, description: role.description, backend, role: role.name, workspace: "", instructions: "" });
        done.push(role.name);
      }
      return { done };
    },
    /** 启动角色里已保存的一个 MCP server 并列出它的工具。 */
    async testMcp(roleName, serverName) {
      await sleep(700);
      const server = data.roles.find((r) => r.name === roleName).mcpServers.find((s) => s.name === serverName);
      if (!["npx", "node", "python3", "uvx"].includes(server.command)) return { error: say(`找不到命令“${server.command}”`, `Command "${server.command}" not found`) };
      return { tools: serverName === "render" ? ["render_preview", "list_fixtures"] : ["generate", "get_status"] };
    },
    // ---------- 预设团队 ----------
    presets: async () => ({ teams: [{ ...structuredClone(TEAM), source: "builtin", dir: "/app/presets/zh-CN/film", language: "zh-CN", problems: [], programs: [], used: data.teams.includes(TEAM.id) }], problems: [] }),
    deriveTeam: async (id) => `~/.xsb/presets/zh-CN/${id}`,
    openFolder: async () => {},
    /** 使用一支团队：它的角色成为工作区的角色，但不复制；工作区已有的同名角色仍以工作区的为准。 */
    async useTeam(teamId) {
      if (data.teams.includes(teamId)) return;
      data.teams.push(teamId);
      Object.assign(data.assetNames, TEAM.assets);
      for (const { role } of TEAM.roles) {
        let mine = data.roles.find((r) => r.name === role.name);
        if (mine) mine.preset = presetOf(role.name, true);
        else data.roles.push(mine = { ...structuredClone(role), preset: presetOf(role.name, false) });
        emit({ role: structuredClone(mine) });
      }
    },
    async dropTeam(teamId) {
      const gone = data.roles.filter((r) => r.preset?.team === teamId && !r.preset.own).map((r) => r.name);
      const users = data.agents.filter((a) => gone.includes(a.role)).map((a) => a.id);
      if (users.length) throw new Error(say(`团队“${TEAM.title}”还有智能体在用：${users.join("、")}。`, `The team “${TEAM.title}” is still in use by ${users.join(", ")}.`));
      data.teams = data.teams.filter((t) => t !== teamId);
      data.roles = data.roles.filter((r) => !gone.includes(r.name));
      gone.forEach((name) => emit({ removedRole: name }));
      for (const r of data.roles) if (r.preset?.team === teamId) { r.preset = null; emit({ role: structuredClone(r) }); }
    },
    backends: async () => structuredClone(BACKENDS),
    async locateProgram(command) {       // Electron：系统的选择文件对话框
      Object.assign(BACKENDS.find((b) => b.name === command) ?? {}, { installed: true, missing: undefined });
      return true;
    },
    revealSkill(role, skill) {},   // Electron：在访达中打开 roles/<role>/skills/<skill>/
  };
})();
