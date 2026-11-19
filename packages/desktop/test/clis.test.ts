import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Clis } from "../src/clis.ts";
import { run } from "../src/agent-cli.ts";

test("explicit program selection replaces a PATH copy and launchers inherit the refreshed environment", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-path-test-"));
  const saved = { ...process.env };
  try {
    const original = path.join(directory, "original");
    const selected = path.join(directory, "selected bin");
    fs.mkdirSync(original);
    fs.mkdirSync(selected);
    const oldFile = path.join(original, "codex");
    const newFile = path.join(selected, "codex");
    fs.writeFileSync(oldFile, '#!/bin/sh\nprintf "codex-cli 1.0.0"\n', { mode: 0o755 });
    fs.writeFileSync(newFile, '#!/bin/sh\nprintf "codex-cli 2.0.0"\n', { mode: 0o755 });
    process.env.SHELL = path.join(directory, "no-shell");
    process.env.PATH = `${original}${path.delimiter}${saved.PATH}`;
    const state = path.join(directory, "state");
    const clis = new Clis(state);
    assert.equal(clis.executable("codex"), oldFile);
    assert.equal(clis.setPath("codex", newFile), true);
    assert.equal(clis.executable("codex"), newFile);
    await clis.refresh([selected]);
    const launcher = fs.readFileSync(path.join(state, "bin", "codex-acp"), "utf8");
    assert.ok(launcher.includes(newFile));
    assert.ok(launcher.includes("export PATH="));
    assert.equal((await run("codex", ["--version"])).stdout, "codex-cli 2.0.0");
    fs.rmSync(newFile);
    assert.equal(clis.executable("codex"), oldFile);
    await clis.refresh();
    assert.ok(fs.readFileSync(path.join(state, "bin", "codex-acp"), "utf8").includes(oldFile));
  } finally {
    process.env = saved;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
