// Standalone renderer preview. Electron supplies the same interface through preload.
(() => {
  const params = new URLSearchParams(location.search);
  const language = params.get("lang") ?? (navigator.language.startsWith("zh") ? "zh-CN" : "en");
  const label = (zh, en) => (language === "zh-CN" ? zh : en);
  // ?long：所有名字都加得很长，用来检查文字超长时有没有省略号、会不会撑破布局。
  const long = params.has("long");
  const L = (text) => long ? text + label("：一个名字特别特别长、专门用来检查省略号和换行的示例文字", " — an extremely long name used to check ellipsis and wrapping") : text;
  const listeners = new Set();
  const emit = (event) => listeners.forEach((fn) => fn(structuredClone(event)));
  const now = () => new Date().toISOString();
  let sequence = 0;
  const entry = (kind, text) => ({ id: "m" + ++sequence, kind, content: [{ type: "text", text }] });
  const workspace = { name: L(label("短片工作区", "Film studio")), path: long ? "/Users/someone/Documents/projects/clients/very-long-client-name/preview/film-studio-workspace" : "/preview/film" };
  const agent = (id, name, backend = "codex") => ({
    id,
    name,
    backend,
    workspace: workspace.path,
    description: "",
    conversation: true,
    state: "idle",
    createdAt: now(),
    mainSessionId: "session-" + id,
  });
  const main = agent("main", L(label("短片制作", "Short film")));
  const worker = {
    ...agent("art", L(label("定妆图", "Costume"))),
    workflowOwner: main.mainSessionId,
    workflowNode: "A",
    state: "running",
  };
  // 上一版里的 draft 节点被新版删掉了：它的对话只能查看。
  const dropped = { ...agent("draft", label("初稿", "Draft")), workflowOwner: main.mainSessionId, workflowNode: "draft", retired: true };
  const flow = {
    sessionId: main.mainSessionId,
    history: [{
      version: "film-0", retiredAt: new Date(Date.now() - 3600_000).toISOString(),
      nodes: [
        { name: "draft", kind: "task", status: "completed", paused: false, agentId: dropped.id, sessionId: dropped.mainSessionId, summary: "v1" },
        { name: "A", kind: "task", status: "running", paused: false, agentId: "art", sessionId: "session-art" },
        { name: "final", kind: "end", status: "waiting", paused: false },
      ],
      edges: [{ from: "draft", to: "A" }, { from: "A", to: "final" }],
    }],
    version: "film-1",
    paused: false,
    nodes: [
      {
        name: "A",
        kind: "task",
        status: "running",
        paused: false,
        agentId: worker.id,
        sessionId: worker.mainSessionId,
        target: "work-a",
      },
      { name: "review", kind: "task", status: "waiting", paused: false },
      { name: "final", kind: "end", status: "waiting", paused: false },
    ],
    edges: [
      { from: "A", to: "review" },
      { from: "review", to: "final" },
    ],
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const ark = { state: params.get("ark") ?? "ready", bindings: {} };
  const ARK_PLANS = [
    { profile: "agent-plan_cn-beijing_personal", name: "Agent Plan Medium", type: "agent-plan", tier: "medium", expiresAt: "2026-12-16T23:59:59+08:00", expired: false },
    { profile: "coding-plan_cn-beijing_personal", name: "Coding Plan Lite", type: "coding-plan", tier: "lite", expiresAt: "2026-10-01T23:59:59+08:00", expired: true },
  ];
  const arkView = () => structuredClone({ state: ark.state, version: ark.state === "broken" ? undefined : "1.0.65", issue: ark.state === "broken" ? "execution" : undefined,
    path: "/Applications/xsb.app/Contents/Resources/app/node_modules/@volcengine/ark-cli-darwin-arm64/bin/arkcli-darwin-arm64",
    plans: ["ready", "noPlan"].includes(ark.state) ? (ark.state === "ready" ? ARK_PLANS : [ARK_PLANS[1]]) : [], bindings: ark.bindings });
  const BACKENDS = [
    {
      name: "claude",
      cli: "claude",
      configPath: "~/.claude/settings.json",
      command: "claude-agent-acp",
      installed: true,
    },
    { name: "codex", cli: "codex", configPath: "~/.codex/config.toml", command: "codex-acp", installed: true },
  ];
  // Preview missing-program setup without touching real installations.
  const missingCli = new URLSearchParams(location.search).get("missing");
  for (const backend of BACKENDS)
    if (backend.name === missingCli) Object.assign(backend, { installed: false, missing: backend.name });

  const art = {
    id: "material",
    name: long ? "a-very-long-brief-file-name-for-checking-ellipsis-in-every-place.md" : "brief.md",
    kind: "markdown",
    agentId: main.id,
    path: workspace.path + "/brief.md",
    fileUri: new URL("brief.md", `file://${workspace.path}/`).href,
    url: "data:text/plain,Film%20brief",
    updatedAt: now(),
  };
  // 不同类型的文件，预览标签上的文件图标。
  const file = (id, name, kind) => ({ id, name, kind, agentId: main.id, sessionIds: [main.mainSessionId], path: workspace.path + "/" + name,
    fileUri: new URL(name, `file://${workspace.path}/`).href, url: "data:text/plain,preview", updatedAt: now() });
  const data = {
    workspace,
    agents: [main, worker, dropped],
    artifacts: [art, file("poster", "poster.png", "image"), file("shots", "shots.json", "text"), file("cut", "cut.mp4", "video"), file("notes", "notes.xyz", "text")],
    backends: BACKENDS,
    tasks: [],
    history: {},
    activities: {},
    pages: [],
    workflows: { [main.mainSessionId]: flow },
    transcripts: {
      main: [entry("output", label("定妆图完成后开始审片。", "Review starts after the costume design."))],
      art: [entry("output", label("正在画红外套的定妆图。", "Drawing the red coat."))],
      draft: [entry("output", label("初稿已交付。", "The first draft is delivered."))],
    },
  };
  let opened = !params.has("welcome");
  const put = (id, e) => {
    data.transcripts[id].push(e);
    emit({ agentId: id, entry: e });
  };
  const get = (id) => {
    const a = data.agents.find((a) => a.id === id);
    if (!a) throw Error("Unknown conversation");
    return a;
  };
  // 打开设置菜单（discover）时中枢为对话连上后端（新对话也建立后端会话），拉取要一会儿。
  const connected = new Set();
  function composerState(id) {
    const selected = get(id).selected ?? {};
    if (!connected.has(id)) return { connected: false, selected, configOptions: [] };
    const option = (id, category, values) => ({ configId: id, category, type: "select", currentValue: selected[id] ?? values[0],
      options: values.map(value => ({ name: value, value })) });
    return { connected: true, selected, configOptions: [
      option("model", "model", ["Preview", "Preview fast"]), option("effort", "thought_level", ["Medium", "High"]),
    ] };
  }
  // 插件：三处文件夹，规则与中枢 plugins.ts 相同（后面的地方代替同名的，工作区插件需确认）。
  const plugins = [
    { name: "browser", scope: "builtin", dir: "<app>/plugins/browser", runs: "XSB_BROWSER_SOCKET=${XSB_BROWSER_SOCKET} node ./server.mjs" },
    { name: "search", scope: "global", dir: "~/.xsb2_global/plugins/search", runs: "npx -y search-mcp\nhttps://example.com/mcp" },
    { name: "broken", scope: "global", dir: "~/.xsb2_global/plugins/broken", problem: "bad_json" },
    { name: "render", scope: "project", dir: ".xsb2/plugins/render", runs: "node ./dist/server.js", approved: false },
  ];
  const off = { global: new Set(), project: new Set() };
  function pluginViews() {
    const last = new Map(plugins.filter((p) => !p.problem).map((p) => [p.name, p]));
    return structuredClone(plugins.map((p) => {
      const enabled = !off[p.scope === "project" ? "project" : "global"].has(p.name) && !off.project.has(p.name);
      return { ...p, enabled, replaced: !p.problem && last.get(p.name) !== p, active: !p.problem && last.get(p.name) === p && enabled && p.approved !== false };
    }));
  }
  const row = (rows) => rows.map(([name, d, min, max]) => ({ name, default: d, min, max, value: undefined }));
  const backendRows = () => row([["sessionTokens", 150000, 10000, 2000000], ["promptTokens", 32000, 4000, 2000000], ["contextReserveTokens", 8192, 1024, 200000],
    ["toolOutputTokens", 4000, 500, 200000], ["contextRecoveryAttempts", 1, 0, 3]]);
  const limits = { backends: { claude: backendRows(), codex: backendRows() } };
  let projectLanguage = language;
  let consultation = { global: false, project: null, effective: false };
  window.xsb = {
    language,
    on: (fn) => listeners.add(fn),
    load: async () =>
      structuredClone(opened ? data : { workspace: null, recent: [workspace], backends: BACKENDS }),
    open: async () => {
      opened = true;
    },
    pickFolder: async () => ({ ...workspace, initialized: true }),
    newWindow: () => window.open(location.href),
    windowColors: async () => {},
    deleteConversation: async (id) => {
      const index = data.agents.findIndex((a) => a.id === id);
      if (index >= 0) { data.agents.splice(index, 1); emit({ removedAgent: id }); }
    },
    cleanUp: async () => ({ conversations: 1, bytes: 3_456_789 }),
    composerState: async (id, discover) => {
      if (discover && !connected.has(id)) { await new Promise(r => setTimeout(r, 1500)); connected.add(id); }
      return composerState(id);
    },
    setComposerOption: async (id, configId, value) => {
      (get(id).selected ??= {})[configId] = value;
      const controls = composerState(id);
      emit({ agentId: id, controls });
      return controls;
    },
    openPage: async (url, embedded, sessionId) => {
      const page = { id: "page" + ++sequence, sessionId, url, title: long ? L("网页") : "", loading: false, canGoBack: false, canGoForward: false, window: false, pinned: false, agent: false };
      if (!embedded) emit({ page });
      return structuredClone(page);
    },
    page: async (id, op) => { if (op === "close") emit({ removedPage: id }); },
    readClipboardImages: async () => null,
    copyText: (text) => navigator.clipboard.writeText(text),
    contextMenu: async () => null, // Native menus exist only in Electron.
    overlay: async () => null,     // The overlay over web pages exists only in Electron (../src/overlay.ts).
    pathOf: (file) => file.name,
    conversationFiles: async (owner) => owner === main.mainSessionId ? structuredClone(data.artifacts) : [],
    openArtifact: async () => structuredClone(art),
    revealArtifact: async () => {},
    refreshArtifact: async () => {},
    history: async (id) => ({ entries: structuredClone(data.transcripts[id]), cursor: null }),
    newSession: async (backend, title) => {
      const a = agent("chat" + ++sequence, title || label("新会话", "New session"), backend);
      data.agents.push(a);
      data.transcripts[a.id] = [];
      emit({ agent: a });
      return structuredClone(a);
    },
    // 上下文限制：与中枢 config.ts 的表相同，按后端设置。
    limitSettings: async () => structuredClone(limits),
    setLimit: async (backend, name, value) => {
      limits.backends[backend].find((l) => l.name === name).value = value ?? undefined;
      return structuredClone(limits);
    },
    projectLanguage: async () => projectLanguage,
    consultationSettings: async () => ({ ...consultation }),
    setConsultation: async (scope, value) => {
      consultation[scope] = value;
      consultation.effective = consultation.project ?? consultation.global;
      return { ...consultation };
    },
    setProjectLanguage: async (value) => (projectLanguage = value),
    plugins: async () => pluginViews(),
    setPluginEnabled: async (scope, name, enabled) => { off[scope][enabled ? "delete" : "add"](name); return pluginViews(); },
    approvePlugin: async (name) => { plugins.find((p) => p.name === name).approved = true; return pluginViews(); },
    reloadPlugins: async () => pluginViews(),
    pluginApprovals: async () => [],
    revokePluginApproval: async () => pluginViews(),
    revealPlugins: async () => true,
    setBackend: async (id, backend) => {
      const a = get(id);
      if (data.transcripts[id].some((e) => e.kind === "input")) put(id, { id: "m" + ++sequence, kind: "boundary", boundary: { kind: "backend_changed", backend, handoff: true } });
      a.backend = backend;
      emit({ agent: a });
      return structuredClone(a);
    },
    renameConversation: async (id, title) => {
      const a = get(id);
      a.name = title.trim();
      emit({ agent: a });
      return structuredClone(a);
    },
    setAvatar: async (id, avatar) => {
      const a = get(id);
      if (avatar) a.avatar = avatar; else delete a.avatar;
      emit({ agent: a });
      return structuredClone(a);
    },
    send: async (id, content) => {
      const a = get(id);
      // 先显示为尚未送达，片刻后"模型收到"，再回复：与真实中枢的插入回执顺序一致。
      const sent = { id: "m" + ++sequence, kind: "input", origin: { kind: "user" }, content, pending: true };
      put(id, sent);
      await new Promise((r) => setTimeout(r, 1200));
      const inserted = { ...sent, pending: undefined };
      data.transcripts[id] = data.transcripts[id].map((e) => (e.id === sent.id ? inserted : e));
      emit({ agentId: id, entry: inserted });
      put(id, entry("output", a.name + " · " + content.map((b) => b.text ?? b.type).join(" ")));
    },
    async cancel(id) {
      const a = get(id);
      if (a.workflowOwner || data.workflows[a.mainSessionId])
        await this.workflowControl(
          a.workflowOwner ?? a.mainSessionId,
          true,
          a.workflowNode ? [a.workflowNode] : undefined,
        );
    },
    async workflowControl(id, pause, names) {
      const f = data.workflows[id];
      if (!names) f.paused = pause;
      for (const n of f.nodes)
        if (n.agentId && (!names || names.includes(n.name))) {
          if (names) n.paused = pause;
          n.status = n.paused || f.paused ? "suspended" : "running";
          const a = get(n.agentId);
          a.state = n.status === "running" ? "running" : "idle";
          emit({ agent: a });
        }
      emit({ workflow: f });
      return structuredClone(f);
    },
    clear: async (id) =>
      put(id, { id: "m" + ++sequence, kind: "boundary", boundary: { kind: "cleared", handoff: false } }),
    backends: async () => structuredClone(BACKENDS),
    cliConfig: async (name) => ({
      path: name === "codex" ? "~/.codex/config.toml" : "~/.claude/settings.json",
      exists: true,
    }),
    revealCliConfig: async () => true,
    async checkCli(name) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      const previewState = new URLSearchParams(location.search).get("cli-state");
      if (previewState === "error") throw new Error("Preview: CLI check timed out. No real CLI was run.");
      return {
        state: !BACKENDS.find((b) => b.name === name)?.installed
          ? "missing"
          : ["broken"].includes(previewState)
            ? previewState
            : "ready",
        version: "1.0.0",
      };
    },
    async installCli(name) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      Object.assign(
        BACKENDS.find((b) => b.name === name),
        { installed: true, missing: undefined },
      );
      return { state: "ready", version: "1.0.0" };
    },
    async locateProgram(command) {
      // Electron：系统的选择文件对话框
      Object.assign(BACKENDS.find((b) => b.name === command) ?? {}, { installed: true, missing: undefined });
      return true;
    },
    // 火山方舟（Electron：main.ts 先弹系统确认框；预览里一律当作“确认”）。?ark=broken|unauthenticated|noPlan|ready
    arkStatus: async () => { await wait(300); return arkView(); },
    arkModels: async () => { await wait(300); return [{ name: "ark-code-latest" }, { name: "doubao-seed-2.1-pro", context: 1048576 }, { name: "kimi-k3.1-pro" }, { name: "deepseek-v4-pro" }]; },
    arkLogin: async () => {
      setTimeout(() => emit({ arkLoginUrl: "https://ark.volcengine.com/region:cn-beijing/arkcli/login?preview" }), 300);
      await wait(1500); ark.state = "ready"; return arkView();
    },
    arkCancelLogin: async () => {},
    arkBind: async (cli, profile, model) => {
      await wait(200);
      if (profile === null) delete ark.bindings[cli]; else ark.bindings[cli] = { profile, model, baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3" };
      const b = BACKENDS.find((x) => x.cli === cli);
      if (b) b.ark = profile === null ? undefined : { profile, model };
      return true;
    },
  };
})();
