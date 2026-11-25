// Standalone renderer preview. Electron supplies the same interface through preload.
(() => {
  const params = new URLSearchParams(location.search);
  const language = params.get("lang") ?? (navigator.language.startsWith("zh") ? "zh-CN" : "en");
  const label = (zh, en) => (language === "zh-CN" ? zh : en);
  const listeners = new Set();
  const emit = (event) => listeners.forEach((fn) => fn(structuredClone(event)));
  const now = () => new Date().toISOString();
  let sequence = 0;
  const entry = (kind, text) => ({ id: "m" + ++sequence, kind, content: [{ type: "text", text }] });
  const workspace = { name: label("短片工作区", "Film studio"), path: "/preview/film" };
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
  const main = agent("main", label("短片制作", "Short film"));
  const worker = {
    ...agent("art", label("定妆图", "Costume")),
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
    name: "brief.md",
    registeredName: "brief",
    assetId: main.mainSessionId + "/brief",
    assetVersion: 1,
    kind: "markdown",
    agentId: main.id,
    path: workspace.path + "/brief.md",
    url: "data:text/plain,Film%20brief",
    updatedAt: now(),
  };
  // 不同类型的文件，预览标签上的文件图标。
  const file = (id, name, kind) => ({ id, name, kind, agentId: main.id, sessionIds: [main.mainSessionId], path: workspace.path + "/" + name,
    url: "data:text/plain,preview", updatedAt: now() });
  const data = {
    workspace,
    agents: [main, worker, dropped],
    artifacts: [art, file("poster", "poster.png", "image"), file("shots", "shots.json", "text"), file("cut", "cut.mp4", "video"), file("notes", "notes.xyz", "text")],
    backends: BACKENDS,
    tasks: [],
    assetNames: {},
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
  function composerState(id) {
    const selected = get(id).selected ?? {};
    const option = (id, category, values) => ({ configId: id, category, type: "select", currentValue: selected[id] ?? values[0],
      options: values.map(value => ({ name: value, value })) });
    return { connected: true, selected, configOptions: [
      option("model", "model", ["Preview", "Preview fast"]), option("effort", "thought_level", ["Medium", "High"]),
    ] };
  }
  // 插件：三处文件夹，规则与中枢 plugins.ts 相同（后面的地方代替同名的，工作区插件需确认）。
  const plugins = [
    { name: "browser", scope: "builtin", dir: "<app>/plugins/browser", description: label("右栏浏览器", "The side panel browser"), runs: "${node} ${pluginDir}/server.mjs" },
    { name: "media", scope: "builtin", dir: "<app>/plugins/media", description: label("生成图片和视频", "Generate images and videos"), runs: "${node} ${pluginDir}/server.mjs" },
    { name: "search", scope: "global", dir: "~/.xsb2_global/plugins/search", description: label("网页搜索", "Web search"), runs: "npx -y search-mcp" },
    { name: "broken", scope: "global", dir: "~/.xsb2_global/plugins/broken", problem: "bad_json" },
    { name: "render", scope: "project", dir: ".xsb2/plugins/render", runs: "./render-mcp --gpu", approved: false },
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
  const limits = { hub: row([["jobsAtOnce", 2, 1, 16], ["workflowValidationSteps", 100000, 1000, 10000000]]), backends: { claude: backendRows(), codex: backendRows() } };
  let projectLanguage = language;
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
    composerState: async id => composerState(id),
    setComposerOption: async (id, configId, value) => {
      (get(id).selected ??= {})[configId] = value;
      const controls = composerState(id);
      emit({ agentId: id, controls });
      return controls;
    },
    openPage: async (url, embedded, sessionId) => {
      const page = { id: "page" + ++sequence, sessionId, contentsId: 0, url, title: "", loading: false, canGoBack: false, canGoForward: false, window: false, pinned: false, agent: false };
      if (!embedded) emit({ page });
      return structuredClone(page);
    },
    page: async (id, op) => { if (op === "close") emit({ removedPage: id }); },
    readClipboardImages: async () => null,
    copyText: (text) => navigator.clipboard.writeText(text),
    pathOf: (file) => file.name,
    openArtifact: async () => structuredClone(art),
    revealArtifact: async () => {},
    history: async (id) => ({ entries: structuredClone(data.transcripts[id]), cursor: null }),
    newSession: async (backend, title) => {
      const a = agent("chat" + ++sequence, title || label("新会话", "New session"), backend);
      data.agents.push(a);
      data.transcripts[a.id] = [];
      emit({ agent: a });
      return structuredClone(a);
    },
    // 限制：与中枢 config.ts 的表相同；上下文限制按后端，执行限制全局。
    limitSettings: async () => structuredClone(limits),
    setLimit: async (backend, name, value) => {
      (backend ? limits.backends[backend] : limits.hub).find((l) => l.name === name).value = value ?? undefined;
      return structuredClone(limits);
    },
    projectLanguage: async () => projectLanguage,
    setProjectLanguage: async (value) => (projectLanguage = value),
    plugins: async () => pluginViews(),
    setPluginEnabled: async (scope, name, enabled) => { off[scope][enabled ? "delete" : "add"](name); return pluginViews(); },
    approvePlugin: async (name) => { plugins.find((p) => p.name === name).approved = true; return pluginViews(); },
    reloadPlugins: async () => pluginViews(),
    revealPlugins: async () => true,
    setBackend: async (id, backend) => {
      const a = get(id);
      if (data.transcripts[id].some((e) => e.kind === "input")) put(id, { id: "m" + ++sequence, kind: "boundary", boundary: { kind: "backend_changed", backend, handoff: true } });
      a.backend = backend;
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
          : ["unauthenticated", "unknown", "broken"].includes(previewState)
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
      return { state: "unauthenticated", version: "1.0.0" };
    },
    async locateProgram(command) {
      // Electron：系统的选择文件对话框
      Object.assign(BACKENDS.find((b) => b.name === command) ?? {}, { installed: true, missing: undefined });
      return true;
    },
  };
})();
