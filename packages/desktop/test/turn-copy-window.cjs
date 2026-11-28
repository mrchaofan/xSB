const assert = require("node:assert/strict");

require("./window-harness.cjs").windowTest(__filename, async ({ win, js, click, send, has, until, untilJS }) => {
  const lane = "#lanes .lane";
  const buttons = `document.querySelectorAll("${lane} .entries button.copy")`;
  const cursors = `document.querySelectorAll("${lane} .entries .turn-cursor")`;
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
  const code = ["Second paragraph", "```js", "const answer = 42;", "```"].join("\n");
  const firstInput = [
    "Check both paragraphs.",
    "!say " + firstOutput,
    update({ sessionUpdate: "tool_call_update", toolCallId: "inspect", title: toolTitle + "\n" + toolResult, status: "completed" }),
    ask,
    update({ sessionUpdate: "agent_message_chunk", messageId: "code", content: { type: "text", text: code } }),
    ask,
  ].join("\n");
  const secondInput = ["Start a separate turn.", "!say Separate reply", ask].join("\n");

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
    await js('xsb.newSession("mock", "Turn copy test")');
    const row = '#agents .row[title="Turn copy test"]';
    await until(() => has(row), "mock conversation");
    await click(row);
    await send(lane, firstInput);
    await until(() => has(panel), "first turn waiting after the tool");
    assert.ok(await has(lane + " .entry.tool + .turn-cursor"), "the cursor follows the latest tool");
    await click(skip);
    await until(() => has(lane + " .entry.output pre code"), "code following the tool");
    await until(() => has(panel), "first turn waiting after the code");
    assert.ok(await has(lane + " .entry.output pre code > .turn-cursor:last-child"), "the cursor moved to the latest output");
    assert.equal(await js(buttons + ".length"), 0, "an unfinished turn has no copy buttons");
    assert.equal(await js(cursors + ".length"), 1, "the cursor persists while the turn waits");
    if (!(await js('matchMedia("(prefers-reduced-motion: reduce)").matches'))) {
      const opacity = `getComputedStyle(${cursors}[0]).opacity`;
      await untilJS(opacity + ' === "0"', "cursor blinks off");
      await untilJS(opacity + ' === "1"', "cursor blinks on");
    }

    await click(skip);
    await untilJS(buttons + ".length === 1", "first turn ready to copy");
    assert.equal(await js(cursors + ".length"), 0, "the cursor disappears on completion");
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
      .querySelector(".md:last-child p:last-child > .turn-cursor:last-child") !== null`), "the cursor sits at the end of the last paragraph");
    assert.ok(await js(`${buttons}[0].compareDocumentPosition(${cursors}[0]) & Node.DOCUMENT_POSITION_FOLLOWING`),
      "the cursor belongs to the active turn after the completed one");
    assert.equal(await copy(0), first);
    await click(skip);
    await untilJS(buttons + ".length === 2", "both turns ready to copy");
    assert.equal(await js(cursors + ".length"), 0);
    const second = await copy(1);
    assert.ok(second.includes(secondInput));
    assert.ok(second.slice(second.indexOf(secondInput) + secondInput.length).includes("Separate reply"));
    assert.ok(!second.includes(firstOutput));
    assert.equal(await copy(0), first);

    const loaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
    win.webContents.reload();
    await loaded;
    await untilJS(buttons + ".length === 2", "completed turns restored from history");
    assert.equal(await js(cursors + ".length"), 0);
    assert.equal(await copy(0), first);
    assert.equal(await copy(1), second);
    console.log("Electron turn copy and cursor passed for live turns and history");
  } finally {
    clipboard.writeText = original;
  }
});
