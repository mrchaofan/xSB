// Exercise the native focus boundary and notification clicks without posting to the OS notification center.
const assert = require("node:assert/strict");

require("./window-harness.cjs").windowTest(__filename, async ({ win, js, q, click, send, has, until, untilJS }) => {
  const { BrowserWindow, Notification } = require("electron");
  const other = new BrowserWindow({ show: false, width: 320, height: 200 });
  const notices = [];
  const originalShow = Notification.prototype.show;
  const originalSupport = Notification.isSupported;
  Notification.isSupported = () => true;
  Notification.prototype.show = function () { notices.push(this); };

  const main = "#lanes .lane", task = "#task-conversation .lane";
  const invoke = (name, ...args) => js("xsb." + name + "(..." + JSON.stringify(args) + ")");
  const ask = title => "!elicit " + JSON.stringify({ message: title,
    requestedSchema: { type: "object", properties: { answer: { type: "string", title } } } });
  const execute = graph => "!call execute " + JSON.stringify({ graphJsonl: graph.map(row => JSON.stringify(row)).join("\n") });
  const openPermission = ".permission:not([data-outcome])";
  const noteFor = body => until(() => notices.find(note => note.body === body), "background notification for " + body);
  // A card synchronously reveals its request. Check which element received focus in that same interaction.
  const clickCard = async (kind, target) => {
    const active = await js(`(() => {
      document.querySelector(${JSON.stringify(main + ' .workflow-request[data-kind="' + kind + '"]')}).click();
      return document.activeElement.matches(${JSON.stringify(target)}) || document.activeElement.outerHTML.slice(0, 200);
    })()`);
    assert.equal(active, true, "focus after opening the " + kind + " card");
  };
  try {
    win.show();
    win.focus();
    await until(() => win.isFocused(), "workspace window in front");
    await until(() => has(main), "main conversation");
    const otherAgent = await js(q(main) + ".dataset.agent");
    const { id: owner } = await invoke("newSession", "mock");
    await until(() => has('#agents .session-row[aria-pressed="false"]'), "scripted conversation");
    await click('#agents .session-row[aria-pressed="false"]');
    await untilJS(q(main) + ".dataset.agent===" + JSON.stringify(owner), "scripted conversation selected");
    win.focus();
    await until(() => win.isFocused(), "workspace focused before the foreground request");
    notices.length = 0;
    await send(main, ask("Foreground question") + "\n!perm\n!say Foreground finished");
    await until(() => has(main + " .ask-panel"), "foreground question");
    await click(main + " .ask-foot button");
    await until(() => has(main + " " + openPermission), "foreground permission");
    await click(main + " " + openPermission + " .primary");
    await untilJS(q(main + " .lane-state .state") + ".dataset.state==='idle' && " +
      "[...document.querySelectorAll('#lanes .output')].some(el => el.textContent.includes('Foreground finished'))", "foreground turn completed");
    assert.deepEqual(notices.map(({ title, body }) => ({ title, body })), [], "nothing is posted for this focused window");

    const background = async () => {
      if (await js(q(main) + ".dataset.agent") !== otherAgent) await click('#agents .session-row[aria-pressed="false"]');
      other.show();
      other.focus();
      await until(() => other.isFocused() && !win.isFocused(), "another window in front");
      assert.equal(await js(q(main) + ".dataset.agent"), otherAgent);
    };
    const question = "Background question";
    const graph = [{ node: "Review", prompt: ask(question) + '\n!perm\n!call finish {"summary":"Reviewed"}' },
      { node: "End", kind: "end" }, { from: "Review", to: "End" }];
    await background();
    await invoke("send", owner, [{ type: "text", text: execute(graph) }]);

    const clickNotice = async body => {
      (await noteFor(body)).emit("click");
      await until(() => win.isFocused(), "notification brings workspace to the front");
      await untilJS(q(main) + ".dataset.agent===" + JSON.stringify(owner) + " && " +
        q('.dag-node[data-node="Review"]') + "?.getAttribute('aria-pressed')==='true' && !" +
        q("#side-workflow") + ".hidden", "notification opens the owning conversation and workflow node");
    };
    await clickNotice(question);
    await until(() => has(task + " .ask-panel:focus"), "question notification focuses its form");
    const questionId = await js(q(task + " .ask-panel") + ".dataset.question");
    const nodeAgent = await js(q(task) + ".dataset.agent");
    // Reusing Review retains its request. A card opened from the read-only snapshot must return to the active version.
    const revision = [graph[0], { node: "Published", kind: "end" }, { from: "Review", to: "Published" }];
    await send(main, execute(revision));
    await until(() => has("#flow-heading select option:nth-child(2)"), "previous workflow version");
    const openHistory = () => js(`(() => {
      const history = document.querySelector("#flow-heading select");
      history.selectedIndex = 1;
      history.dispatchEvent(new Event("change"));
    })()`);
    await openHistory();
    await until(() => has(task + "[data-readonly]"), "historical node conversation");
    assert.equal(await has(".dag-attention"), false, "historical nodes have no live request markers");
    await clickCard("question", task + ":not([data-readonly]) .ask-panel");
    await background();
    await invoke("answerQuestion", nodeAgent, { questionId, skipped: true });
    await clickNotice("Write a file");
    await until(() => has(task + " " + openPermission + ":focus"), "permission notification focuses its approval");
    await openHistory();
    assert.equal(await has(task + " " + openPermission + " .actions"), false, "the historical view cannot approve a live request");
    await clickCard("permission", task + ":not([data-readonly]) " + openPermission);
    assert.ok(await has(task + " " + openPermission + " .primary"));
    const approvalId = await js(q(task + " " + openPermission) + ".dataset.id");
    await background();
    await invoke("permit", approvalId, true);
    await clickNotice("Review");
    await until(() => has('.dag-node[data-node="Review"][data-state="completed"]'), "completed node conversation");
    for (const detail of [question, "Write a file", "Review"])
      assert.equal(notices.filter(note => note.body === detail).length, 1, "one notification for " + detail);
    console.log("Electron + Hub/ACP: focused events stay silent; background ask, approval and task completion open the matching workflow node");
  } finally {
    Notification.prototype.show = originalShow;
    Notification.isSupported = originalSupport;
    other.destroy();
  }
});
