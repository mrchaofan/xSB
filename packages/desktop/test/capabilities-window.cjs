const assert = require("node:assert/strict");
process.env.XSB_TEST_CAPABILITY_AGENT = "1";
require("./window-harness.cjs").windowTest(__filename, async ({ win, js, q, click, draft, send, has, until, untilJS }) => {
  const lane = "#lanes .lane";
  await until(() => has(lane), "first conversation");
  const agent = await js('xsb.newSession("capabilities")');
  await untilJS('document.querySelectorAll("#agents .row").length>=2', "listed");
  const index = (await js('xsb.load().then(s=>s.agents.filter(a=>!a.workflowOwner).map(a=>a.id))')).indexOf(agent.id) + 1;
  await click(`#agents .row:nth-child(${index})`);
  await send(lane, "hello");
  const editor = q(lane + " .editor");
  await untilJS(editor + '.dataset.placeholder.includes("Standard suggestion")', "standard suggestion placeholder");
  assert.deepEqual(await js(q(lane) + '.editor.read()'), [], "placeholder is not draft content");
  assert.equal(await has(lane + " .prompt-suggestions"), false, "suggestion buttons are removed");
  assert.equal(await js(`getComputedStyle(${editor}, "::before").content.includes("Standard suggestion")`), true, "suggestion is visible as a placeholder");
  const tab = (options = {}) => js(`(() => {
    const e = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, ...${JSON.stringify(options)} });
    ${editor}.dispatchEvent(e); return e.defaultPrevented;
  })()`);
  for (const options of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
    assert.equal(await tab(options), false, "modified Tab and IME input are not completed");
  }
  const prior = await js(q(lane + " .entries") + ".children.length");
  await js(editor + '.focus()');
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await untilJS(q(lane) + '.editor.read()[0]?.text === "Standard suggestion"', "Tab completion");
  assert.equal(await js(q(lane) + '.editor.read()[0].text'), "Standard suggestion");
  assert.equal(await js(q(lane + " .entries") + ".children.length"), prior, "suggestion edits a draft only");
  assert.equal(await js('document.activeElement === ' + editor), true, "completion keeps the editor focused");
  assert.equal(await tab(), false, "Tab on a filled draft keeps normal navigation");
  await draft(lane, "my own draft");
  assert.equal(await tab(), false);
  assert.equal(await js(q(lane) + '.editor.read()[0].text'), "my own draft", "completion does not overwrite a draft");
  await draft(lane, " ");
  assert.equal(await tab(), false, "whitespace is an existing draft too");
  await js(q(lane) + '.editor.clear()');
  await untilJS(editor + '.dataset.placeholder.includes("Standard suggestion")', "suggestion restored after clearing");
  await js(q(lane) + '.capabilities.update({})');
  assert.equal(await tab(), false, "no suggestion leaves Tab available for navigation");
  assert.equal(await js(editor + '.dataset.placeholder.includes("Standard suggestion")'), false, "cleared suggestions restore the default placeholder");
  assert.equal(await has(lane + " .native-commands"), false, "no command/skill dropdown");
  await click(lane + " .model-settings");
  await until(() => has(lane + " .cascade-parent"), "model menu");
  assert.equal(await js(q(lane + " .composer-menu") + '.querySelectorAll(":scope > button").length'), 0, "no sign-in action");
  assert.equal(await js('typeof xsb.authenticate'), "undefined", "sign-in IPC is absent");
  await js(q(lane + " .composer-menu") + '.hidePopover()');
  for (const failure of ["reject-prompt", "fail-run"]) {
    const errors = await js(q(lane + " .entries") + '.querySelectorAll(".entry.error").length');
    await send(lane, failure);
    await untilJS(q(lane + " .entries") + '.querySelectorAll(".entry.error").length > ' + errors, "provider error");
    assert.equal(await js(q(lane + " .entries") + '.querySelector(".entry.error:last-child").textContent'), "Provider rejected credentials");
    assert.equal(await js(q(lane + " .entries") + '.innerText.includes("xsb hub stop")'), false);
  }
  assert.equal(await js('typeof xsb.exportSettings'), "undefined");
  assert.equal(await js('typeof xsb.importSettings'), "undefined");
  await click("#settings");
  await until(() => has("dialog.settings-dialog .settings-body"), "settings");
  const settings = await js(q("dialog.settings-dialog") + ".innerText");
  assert.equal(/Settings backup|设置备份|Export settings|导出设置|Import settings|导入设置/.test(settings), false);
  require("node:fs").writeFileSync("/tmp/xsb-capabilities-window.png", (await win.capturePage()).toPNG());
  console.log("Electron + real Hub/ACP: suggestion placeholders and Tab completion, draft/focus preservation, removed backup controls, provider errors");
});
