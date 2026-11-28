const assert = require("node:assert/strict");

require("./window-harness.cjs").windowTest(__filename, async ({ win, js, click, send, has, until, untilJS }) => {
  const lane = "#lanes .lane";
  const buttons = `document.querySelectorAll("${lane} .entries button.turn-copy")`;
  const cursors = `document.querySelectorAll("${lane} .entries .turn-cursor")`;
  const indicators = `document.querySelectorAll("${lane} .entries .turn-indicator")`;
  const activity = `document.querySelector("${lane} .entries .turn-indicator > .turn-cursor + .turn-activity")`;
  const label = `${activity}?.getAttribute("aria-label") ?? ""`;
  const elapsed = `(${activity}?.dataset.elapsed ?? "").trim()`;
  const panel = lane + " .ask-panel";
  const skip = panel + " .ask-foot .btn:not(.primary)";
  // A blocking ACP question gives us a deterministic point to inspect the unfinished turn.
  const ask = "!elicit " + JSON.stringify({
    message: "Ready to continue?",
    requestedSchema: { type: "object", properties: { note: { type: "string", title: "Note" } } },
  });
  const update = data => "!update " + JSON.stringify(data);
  const firstOutput = "**First paragraph**";
  const toolTitle = "Inspect source";
  const toolResult = "Found the source";
  const codeLine = "const answer = 42;";
  const code = ["Second paragraph", "```js", codeLine, "```"].join("\n");
  const firstInput = [
    "Check both paragraphs.",
    "!say " + firstOutput,
    update({ sessionUpdate: "tool_call_update", toolCallId: "inspect", title: toolTitle + "\n" + toolResult, status: "completed" }),
    ask,
    update({ sessionUpdate: "agent_message_chunk", messageId: "code", content: { type: "text", text: code } }),
    ask,
  ].join("\n");
  const secondInput = [
    "Start a separate turn.", "!say Separate reply", ask,
    update({ sessionUpdate: "tool_call_update", toolCallId: "inspect-again", title: toolTitle, status: "in_progress" }),
    "!waitForInput",
  ].join("\n");

  const { clipboard } = require("electron");
  const original = clipboard.writeText;
  let captured;
  const capture = value => { captured = value; };
  clipboard.writeText = capture;
  assert.equal(clipboard.writeText, capture);
  const copy = async index => {
    captured = undefined;
    await js(`${buttons}[${index}].click()`);
    await until(() => captured !== undefined, "turn copied through Electron IPC");
    return captured;
  };

  try {
    await until(() => has(lane), "initial conversation opened");
    const agent = await js('xsb.newSession("mock", "Turn copy test")');
    const row = '#agents .row[title="Turn copy test"]';
    await until(() => has(row), "mock conversation");
    await click(row);
    await untilJS(`document.querySelector("${lane}").dataset.agent === ${JSON.stringify(agent.id)}`, "mock conversation selected");
    await send(lane, firstInput);
    await until(() => has(panel), "first turn waiting after the tool");
    await untilJS(`/answer|回答/i.test(${label})`, "the cursor states that the agent needs an answer");
    assert.ok(await has(lane + " .entry.tool + .turn-indicator"), "the cursor and status follow the latest tool");
    assert.ok(await js(`${activity}.getBoundingClientRect().width > 0 && ${activity}.getBoundingClientRect().height > 0`),
      "the activity label is visible next to the cursor");
    assert.ok(!await has(`${lane} .composer [data-activity], ${lane} .composer .turn-activity, ${lane} .composer-row > .hint[role=status]`),
      "the composer has no duplicate activity status");
    await click(skip);
    await until(() => has(lane + " .entry.output pre code"), "code following the tool");
    await until(() => has(panel), "first turn waiting after the code");
    await untilJS(`/answer|回答/i.test(${label})`, "the status moved to the latest output");
    assert.ok(await has(lane + " .entry.output pre code > .turn-indicator:last-child"), "the cursor and status moved into the code block");
    const selectedCode = await js(`(() => {
      const code = document.querySelector("${lane} .entry.output pre code");
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const text = selection.toString();
      selection.removeAllRanges();
      return [text.trimEnd(), code.textContent.trimEnd()];
    })()`);
    assert.deepEqual(selectedCode, [codeLine, codeLine], "selecting or reading the live code block copies only its source");
    assert.equal(await js(buttons + ".length"), 0, "an unfinished turn has no copy buttons");
    assert.equal(await js(cursors + ".length"), 1, "the cursor persists while the turn waits");
    if (!(await js('matchMedia("(prefers-reduced-motion: reduce)").matches'))) {
      const opacity = `getComputedStyle(${cursors}[0]).opacity`;
      await untilJS(`${opacity} === "0" && Number(getComputedStyle(${activity}).opacity) > 0
        && Number(getComputedStyle(${activity}.parentElement).opacity) > 0`, "status stays visible while the cursor blinks off");
      await untilJS(opacity + ' === "1"', "cursor blinks on");
    }

    await click(skip);
    await untilJS(buttons + ".length === 1", "first turn ready to copy");
    assert.equal(await js(indicators + ".length"), 0, "the cursor and its status disappear on completion");
    const first = await copy(0);
    assert.ok(first.includes(firstInput), "copy preserves the original input");
    // The input is itself a mock program which mentions the expected output. Verify the actual records after it.
    let remaining = first.slice(first.indexOf(firstInput) + firstInput.length);
    for (const part of [firstOutput, toolTitle, toolResult, code]) {
      const pos = remaining.indexOf(part);
      assert.ok(pos >= 0, "copy includes the next record: " + part);
      remaining = remaining.slice(pos + part.length);
    }

    await send(lane, secondInput);
    await until(() => has(panel), "second turn waiting");
    assert.equal(await js(buttons + ".length"), 1, "only the first turn can be copied");
    assert.equal(await js(cursors + ".length"), 1);
    assert.ok(await js(`Array.from(document.querySelectorAll("${lane} .entry.output")).at(-1)
      .querySelector(".md:last-child p:last-child > .turn-indicator:last-child") !== null`), "the cursor and status sit at the end of the last paragraph");
    assert.ok(await js(`${buttons}[0].compareDocumentPosition(${cursors}[0]) & Node.DOCUMENT_POSITION_FOLLOWING`),
      "the cursor belongs to the active turn after the completed one");
    assert.equal(await copy(0), first);
    await click(skip);
    await untilJS(`(${label}).includes(${JSON.stringify(toolTitle)}) && /^\\d+:\\d{2}$/.test(${elapsed})`, "running tool name and elapsed time");
    assert.ok(await has(lane + " .entry.tool + .turn-indicator"), "the status follows the newly started tool");
    const initialTime = await js(elapsed);
    await untilJS(`/^\\d+:\\d{2}$/.test(${elapsed}) && ${elapsed} !== ${JSON.stringify(initialTime)}`, "elapsed time advances beside the cursor");
    await click(lane + " .send");
    await untilJS(buttons + ".length === 2", "both turns ready to copy");
    assert.equal(await js(indicators + ".length"), 0, "stopping a tool clears its status and timer");
    const second = await copy(1);
    assert.ok(second.includes(secondInput));
    assert.ok(second.slice(second.indexOf(secondInput) + secondInput.length).includes("Separate reply"));
    assert.ok(!second.includes(firstOutput));
    assert.equal(await copy(0), first);

    const loaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
    win.webContents.reload();
    await loaded;
    await untilJS(buttons + ".length === 2", "completed turns restored from history");
    assert.equal(await js(indicators + ".length"), 0, "history restores completed turns without activity indicators");
    assert.equal(await copy(0), first);
    assert.equal(await copy(1), second);
    console.log("Electron turn copy, cursor and activity passed for live turns and history");
  } finally {
    clipboard.writeText = original;
  }
});
