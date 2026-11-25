import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Clis, link } from "../src/clis.ts";
import { run } from "../src/agent-cli.ts";

const program = (file: string, says: string) => fs.writeFileSync(file, `#!/bin/sh\nprintf "${says}"\n`, { mode: 0o755 });

test("a program is where the user said, else installed by the app, else on the user's PATH; child processes find the app's first", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-path-test-"));
  const saved = { ...process.env };
  try {
    const original = path.join(directory, "original");
    const selected = path.join(directory, "selected bin");
    fs.mkdirSync(original);
    fs.mkdirSync(selected);
    const onPath = path.join(original, "codex");
    const chosen = path.join(selected, "codex");
    program(onPath, "codex-cli 1.0.0");
    program(chosen, "codex-cli 2.0.0");
    process.env.SHELL = path.join(directory, "no-shell");
    process.env.PATH = `${original}${path.delimiter}${saved.PATH}`;
    const state = path.join(directory, "state");
    const clis = new Clis(state);
    assert.equal(clis.executable("codex"), onPath);
    // The app's own process keeps the user's PATH; its children get the app's directories first.
    assert.ok(process.env.PATH!.startsWith(original + path.delimiter) && !process.env.PATH!.includes(state));
    assert.deepEqual(clis.env().PATH!.split(path.delimiter).slice(0, 4),
      [path.join(state, "bin"), path.join(state, "builtin", "bin"), path.join(state, "installed", "bin"), original]);

    // Installed by the app: preferred to the user's PATH, and linked by name into installed/bin.
    const installed = path.join(clis.installDir("codex"), "codex");
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    program(installed, "codex-cli 3.0.0");
    clis.resync();
    assert.equal(clis.executable("codex"), installed);
    assert.equal(fs.realpathSync(path.join(state, "installed", "bin", "codex")), fs.realpathSync(installed));
    assert.equal((await run("codex", ["--version"], { env: clis.env() })).stdout, "codex-cli 3.0.0");

    // Where the user said wins, until the app installs it again (agent-cli.ts forgets the choice).
    assert.equal(clis.setPath("codex", chosen), true);
    assert.equal(clis.executable("codex"), chosen);
    const launcher = () => fs.readFileSync(path.join(state, "bin", "codex-acp"), "utf8");
    assert.ok(launcher().includes(chosen));
    assert.ok(launcher().includes(`export PATH='${clis.path()}'`));
    assert.equal((await run("codex", ["--version"], { env: clis.env() })).stdout, "codex-cli 2.0.0");
    clis.forget("codex");
    clis.resync();
    assert.equal(clis.executable("codex"), installed);
    assert.ok(!fs.existsSync(path.join(state, "bin", "codex")));
    assert.ok(launcher().includes(installed));

    // Gone from the app's folder: the user's PATH again, and its link goes with it.
    fs.rmSync(path.dirname(installed), { recursive: true });
    await clis.refresh();
    assert.equal(clis.executable("codex"), onPath);
    assert.deepEqual(fs.readdirSync(path.join(state, "installed", "bin")), []);
    assert.ok(launcher().includes(onPath));
    // Nothing half written is left behind.
    assert.ok(fs.readdirSync(path.join(state, "bin")).every((name) => !name.endsWith(".tmp")));
  } finally {
    process.env = saved;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a built-in program is linked by its command name, and a user's earlier choice for it does not replace it", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-builtin-test-"));
  const saved = { ...process.env };
  try {
    process.env.SHELL = path.join(directory, "no-shell");
    const shipped = path.join(directory, "app", "arkcli-darwin-arm64");
    fs.mkdirSync(path.dirname(shipped));
    program(shipped, "arkcli version 1.0.65");
    const theirs = path.join(directory, "their-arkcli");
    program(theirs, "arkcli version 1.0.40");
    const state = path.join(directory, "state");
    fs.mkdirSync(state);
    // An earlier version let the user point to arkcli.
    fs.writeFileSync(path.join(state, "paths.json"), JSON.stringify({ arkcli: theirs }));
    const clis = new Clis(state, { builtins: { arkcli: shipped, missing: null } });
    assert.deepEqual(fs.readdirSync(path.join(state, "builtin", "bin")), ["arkcli"]);
    assert.ok(!fs.existsSync(path.join(state, "bin", "arkcli")));
    assert.equal((await run("arkcli", ["--version"], { env: clis.env() })).stdout, "arkcli version 1.0.65");
  } finally {
    process.env = saved;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a link is made even where symbolic links cannot be", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-link-test-"));
  try {
    const target = path.join(directory, "program");
    fs.writeFileSync(target, "x");
    assert.equal(link(target, path.join(directory, "a"), "a"), "a");
    assert.equal(fs.readFileSync(path.join(directory, "a"), "utf8"), "x");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("NODE_OPTIONS is neither taken from the login shell nor kept: nothing the app starts gets it", { skip: process.platform === "win32" }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-env-test-"));
  const saved = { ...process.env };
  try {
    // A login shell whose startup files set NODE_OPTIONS and a variable of the user's.
    const shell = path.join(directory, "shell");
    fs.writeFileSync(shell, '#!/bin/sh\nexport NODE_OPTIONS=--require=/nowhere.js XSB_FROM_SHELL=yes\nexec /bin/sh -c "$2"\n', { mode: 0o755 });
    process.env.SHELL = shell;
    process.env.NODE_OPTIONS = "--max-old-space-size=1";
    delete process.env.XSB_FROM_SHELL;
    new Clis(path.join(directory, "state"));
    assert.equal(process.env.NODE_OPTIONS, undefined);
    assert.equal(process.env.XSB_FROM_SHELL, "yes");
  } finally {
    process.env = saved;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
