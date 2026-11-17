#!/usr/bin/env node
// A stand-in for Volcengine's arkcli, for tests: the commands this system uses, with the answers their documentation shows.
// State (what was asked, tasks) is kept in $FAKE_ARK_DIR.
import fs from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_ARK_DIR;
const SWITCHES = new Set(["yes", "no-open", "no-gallery", "inline-local", "return-last-frame", "draft", "page-all"]);
const words = [];
const flags = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith("--")) words.push(arg);
  else if (arg.includes("=")) flags[arg.slice(2, arg.indexOf("="))] = arg.slice(arg.indexOf("=") + 1);
  else if (SWITCHES.has(arg.slice(2))) flags[arg.slice(2)] = true;
  else (flags[arg.slice(2)] ??= []).push(argv[++i]);
}
const flag = (name) => (Array.isArray(flags[name]) ? flags[name].at(-1) : flags[name]);
const state = (name, fallback) => (fs.existsSync(path.join(dir, name)) ? JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) : fallback);
const keep = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
const answer = (value) => {
  if (process.env.FAKE_ARK_PREAMBLE) process.stdout.write('Preparing {input} [1]\n{not-json}\n');
  process.stdout.write(JSON.stringify(value, null, 2)); process.exit(0);
};
const fail = (message) => answer({ ok: false, error: { type: "error", message } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ words, flags }) + "\n");
if (flag("format") !== "json") fail("the caller did not ask for --format json");

if (process.env.FAKE_ARK_SIGNED_OUT) answer({ ok: false, error: { type: "auth", message: "not configured", hint: "run `arkcli auth login` and retry" } });
// The real one can also rewrite the configuration of the agents on the machine. Nothing here may ask it to.
if (words[0] === "pricing" && words[1] === "models") {
  if (process.env.FAKE_ARK_NO_PRICES) fail("pricing is not available");
  // As the real one answers for a pay-as-you-go account (2026-11-17), cut down to two models.
  answer({ page_number: 1, page_size: 50, total_count: 2, items: [
    { FoundationModelName: "doubao-seedance-2-5-flash", ChargeItems: [
      { Type: "NV2VCompletion", Price: 0.046, UnitCode: "千tokens" }, { Type: "V2VCompletion", Price: 0.028, UnitCode: "千tokens" },
      { Type: "NV2V1080Completion", Price: 0.077, UnitCode: "千tokens" }, { Type: "FinetuneNV2VCompletion", Price: 0.2, UnitCode: "千tokens" } ] },
    { FoundationModelName: "doubao-seedream-5-0", ChargeItems: [ { Type: "T2ICompletion", Price: 0.22, UnitCode: "张" }, { Type: "I2ICompletion", Price: 0.22, UnitCode: "张" } ] },
  ] });
}
if (!["+gen", "gen", "api"].includes(words[0])) fail(`the fake arkcli was asked for something that is not generation: ${words.join(" ")}`);

if (words[0] === "api") {
  if (words[1] !== "arkruntime.get_content_generation_task") fail("only a raw generation-task read is allowed");
  const { id } = JSON.parse(flag("params"));
  answer({ id, status: "succeeded", seed: 7, model: "doubao-seedance-2-5-flash-261115", resolution: "480p", usage: { completion_tokens: 48437, total_tokens: 48437 }, content: process.env.FAKE_ARK_NO_LAST_FRAME ? {} : { last_frame_url: "data:text/plain,LAST-FRAME" } });
}

if (words[0] === "+gen") {
  const tasks = state("tasks.json", []);
  if (flag("modality") === "image") {
    const file = path.join(flag("save-to"), "ark-gen.png");
    fs.writeFileSync(file, `IMAGE of ${words[1]}`);
    answer({ model: "doubao-seedream-5-0-260128", output_url: "https://example.com/x", local_path: file, local_paths: [file] });
  }
  keep("tasks.json", [...tasks, { prompt: words[1], polls: 0 }]);
  answer({ task_id: `cgt-${tasks.length + 1}`, status: "queued" });
}

if (words[0] === "gen") {
  const tasks = state("tasks.json", []);
  const task = tasks[Number(words[2].slice(4)) - 1];
  if (!task) fail(`task ${words[2]} not found`);
  if (words[1] === "delete") {
    if (!flags.yes) fail("must confirm with --yes");
    if (task.prompt === "already running") fail("only queued tasks can be cancelled");
    answer({ id: words[2], deleted: true });
  }
  task.polls++;
  keep("tasks.json", tasks);
  if (/^(slow|already running)$/.test(task.prompt)) answer({ task_id: words[2], status: { phase: "queued" } });
  if (task.polls < 2) answer({ task_id: words[2], status: { phase: "running" } });
  if (task.prompt === "refused") answer({ task_id: words[2], status: { phase: "failed", message: "the prompt was refused" } });
  const done = { task_id: words[2], status: { phase: "succeeded" } };
  if (!flag("save-to")) answer(done);
  const file = path.join(flag("save-to"), `${words[2]}.mp4`);
  fs.writeFileSync(file, "MP4-BYTES");
  answer({ ...done, local_path: file });
}

fail(`the fake arkcli does not know: ${words.join(" ")}`);
