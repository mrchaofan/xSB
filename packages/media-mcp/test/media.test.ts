/** The real server and the real Seedream and Seedance providers, with a stand-in for arkcli (fake-arkcli.mjs). */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection } from "@xsb/protocol";

const BIN = fileURLToPath(new URL("../bin/xsb-media-mcp", import.meta.url));
const FAKE = fileURLToPath(new URL("./fake-arkcli.mjs", import.meta.url));
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xsb-media-")));
fs.writeFileSync(path.join(dir, "lin.png"), "PNG");
/** What arkcli was run with, without the flags every call has. */
const ran = (): string[] =>
  fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => {
    const { words, flags } = JSON.parse(line);
    const shown = Object.entries(flags).filter(([name]) => !["format", "no-open", "no-gallery", "inline-local"].includes(name)).map(([name, value]) => `--${name}=${[value].flat().join(",")}`);
    return [...words, ...shown].join(" ").replaceAll(dir, "CWD").replace(/=\S*xsb-ark-\w+/, "=TMP");
  });

async function server(env: Record<string, string> = {}): Promise<{ conn: Connection; stop: () => void }> {
  const proc = spawn(process.execPath, [BIN], { cwd: dir, env: { PATH: process.env.PATH, ARKCLI: FAKE, FAKE_ARK_DIR: dir, VIDEO_POLL_MS: "10", ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const conn = new Connection(proc.stdout, proc.stdin, "test");
  await conn.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  return { conn, stop: () => proc.kill() };
}
const call = (conn: Connection, args: unknown, name = "generate_video"): Promise<any> => conn.request("tools/call", { name, arguments: args });

// 1. A video, with every setting: submitted, polled, saved where it was asked for, the last frame too.
{
  const { conn, stop } = await server();
  const { tools } = await conn.request("tools/list");
  assert.deepEqual(tools.map((t: any) => t.name), ["generate_image", "generate_video"]);
  assert.match(tools[1].description, /Seedance \(the video model set in the user's arkcli\), through arkcli/);
  assert.match(tools[0].description, /Seedream \(the image model set in the user's arkcli\)/);
  const args = { prompt: "Lin walks to the booth", output: "shots/s03_01.mp4", first_frame: "lin.png", duration: 5, resolution: "720p", ratio: "16:9", seed: 11, audio: false, last_frame_output: "shots/s03_01_last.png" };
  const result = await call(conn, args);
  assert.equal(result.content[0].text, `Saved ${dir}/shots/s03_01.mp4\nLast frame saved to ${dir}/shots/s03_01_last.png\nseed: 7\ngeneration id: cgt-1`);
  assert.equal(fs.readFileSync(path.join(dir, "shots/s03_01.mp4"), "utf8"), "MP4-BYTES");
  assert.equal(fs.readFileSync(path.join(dir, "shots/s03_01_last.png"), "utf8"), "LAST-FRAME");
  assert.deepEqual(ran(), [
    "+gen Lin walks to the booth --modality=video --duration=5 --resolution=720p --ratio=16:9 --seed=11 --generate-audio=false --watermark=false --return-last-frame=true --input=first_frame:@CWD/lin.png --save-to=",
    "gen get cgt-1 --save-to=",
    "gen get cgt-1 --save-to=",
    "gen get cgt-1 --save-to=TMP",
    'api arkruntime.get_content_generation_task --params={"id":"cgt-1"}',
  ]);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((name) => /^xsb-ark-\w{6}$/.test(name) && fs.readdirSync(path.join(os.tmpdir(), name)).some((file) => file.endsWith(".mp4"))), []); // arkcli's own directory is not left behind

  // 2. What was not asked for is not passed, and a model never is: that is set in arkcli; a reference that is a URL is passed as it is.
  await call(conn, { prompt: "the river at night", output: "b.mp4", reference_images: ["https://example.com/style.png"] });
  assert.equal(ran()[5], "+gen the river at night --modality=video --watermark=false --input=reference_image:https://example.com/style.png --save-to=");

  // 3. An image: one call.
  const drawn = await call(conn, { prompt: "Lin, front view", output: "refs/lin_front.png", reference_images: ["lin.png"], size: "2K" }, "generate_image");
  assert.equal(drawn.content[0].text, `Saved ${dir}/refs/lin_front.png`);
  assert.equal(fs.readFileSync(path.join(dir, "refs/lin_front.png"), "utf8"), "IMAGE of Lin, front view");
  assert.equal(ran().at(-1), "+gen Lin, front view --modality=image --size=2K --output-format=png --watermark=false --save-to=TMP --input=reference_image:@CWD/lin.png");

  // 4. Failures are the tool's answer, in words an agent can act on.
  const refused = await call(conn, { prompt: "refused", output: "c.mp4" });
  assert.deepEqual([refused.isError, refused.content[0].text], [true, "generation cgt-3 failed: the prompt was refused. Nothing was saved. If the reason is the prompt or the images, change them and submit again; otherwise report it to the user."]);
  assert.match((await call(conn, { prompt: "x" })).content[0].text, /"output" is required/);
  // What the tool's description rules out is refused before anything is submitted.
  const submitted = ran().length;
  assert.match((await call(conn, { prompt: "x", output: "d.mp4", reference_images: "lin.png" })).content[0].text, /"reference_images" must be an array/);
  assert.match((await call(conn, { prompt: "x", output: "d.mp4", last_frame: "lin.png" })).content[0].text, /"last_frame" needs "first_frame"/);
  assert.match((await call(conn, { prompt: "x", output: "d.mp4", first_frame: "lin.png", reference_images: ["lin.png"] })).content[0].text, /cannot be combined with "first_frame"/);
  assert.equal(ran().length, submitted);
  stop();
  const noisy = await server({ FAKE_ARK_PREAMBLE: "1" });
  assert.equal((await call(noisy.conn, { prompt: "x", output: "noisy.png" }, "generate_image")).isError, undefined);
  noisy.stop();
  const noCli = await server({ ARKCLI: "xsb-no-such-arkcli" });
  assert.match((await call(noCli.conn, { prompt: "x", output: "e.png" }, "generate_image")).content[0].text, /"xsb-no-such-arkcli" is not installed or not on PATH.*do not install it or sign in yourself.*arkcli auth login/);
  noCli.stop();
  const signedOut = await server({ FAKE_ARK_SIGNED_OUT: "1", FAKE_ARK_PREAMBLE: "1" });
  assert.match((await call(signedOut.conn, { prompt: "x", output: "e.png" }, "generate_image")).content[0].text, /^arkcli \+gen: not configured \(run `arkcli auth login` and retry\)\nWhatever arkcli advises above is for the user to do.*do not run arkcli yourself\.$/);
  signedOut.stop();
  // A model that hands over no last frame: it is taken from the video, by ffmpeg where there is one.
  const ffmpeg = path.join(dir, "fake-ffmpeg");
  fs.writeFileSync(ffmpeg, `#!/bin/sh\nfor last; do :; done\nprintf FRAME-BY-FFMPEG > "$last"\n`, { mode: 0o755 });
  const noFrame = await server({ FAKE_ARK_NO_LAST_FRAME: "1", FFMPEG: ffmpeg });
  assert.match((await call(noFrame.conn, { prompt: "a", output: "k.mp4", last_frame_output: "frames/k_last.jpg" })).content[0].text, /Last frame saved to \S+k_last\.jpg \(taken from the video: the provider returned none\)/);
  assert.equal(fs.readFileSync(path.join(dir, "frames/k_last.jpg"), "utf8"), "FRAME-BY-FFMPEG");
  noFrame.stop();
  const neither = await server({ FAKE_ARK_NO_LAST_FRAME: "1", FFMPEG: "xsb-no-such-ffmpeg" });
  assert.match((await call(neither.conn, { prompt: "a", output: "l.mp4", last_frame_output: "l_last.jpg" })).content[0].text, /Last frame NOT saved.*l_last\.jpg does not exist/);
  assert.ok(!fs.existsSync(path.join(dir, "l_last.jpg")));
  neither.stop();
  const unknown = await server({ VIDEO_PROVIDER: "sora" });
  assert.match((await call(unknown.conn, { prompt: "x", output: "e.mp4" })).content[0].text, /^unknown VIDEO_PROVIDER "sora"\. Known: seedance$/);
  assert.match((await unknown.conn.request("tools/list")).tools[1].description, /NOT AVAILABLE: unknown VIDEO_PROVIDER "sora"\. Known: seedance\. Every call fails/);
  assert.equal((await call(unknown.conn, { prompt: "x", output: "f.png" }, "generate_image")).isError, undefined); // one model being wrong does not take the other down
  unknown.stop();
}

// 5. A generation nobody waits for any more is called off at the provider, so that it is not paid for.
{
  const deleted = (): string[] => ran().filter((line) => line.startsWith("gen delete"));
  const until = async (what: string, probe: () => boolean): Promise<void> => {
    for (let i = 0; !probe(); i++) {
      if (i > 300) throw new Error(`timed out waiting for: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  // The server is stopped while it waits.
  const killed = await server();
  void call(killed.conn, { prompt: "slow", output: "g.mp4" }).catch(() => {});
  await until("the slow task is being polled", () => ran().at(-1)!.startsWith("gen get cgt-6"));
  killed.stop();
  await until("the stopped server cancelled its task", () => deleted().includes("gen delete cgt-6 --yes=true"));

  // A cancelled call (this is how the hub cancels a job) is answered, and the answer says whether that saved its cost.
  const cancelled = await server();
  const abort = new AbortController();
  const answer = cancelled.conn.request("tools/call", { name: "generate_video", arguments: { prompt: "slow", output: "j.mp4" } }, { signal: abort.signal, notify: "notifications/cancelled" });
  await until("the cancelled task is being polled", () => ran().at(-1)!.startsWith("gen get cgt-7"));
  abort.abort();
  assert.match((await answer).content[0].text, /generation cgt-7 was cancelled\. It was cancelled at the provider and is not billed\. Nothing was saved to j\.mp4\./);
  cancelled.stop();

  // A generation that takes too long is called off too; the answer says whether that saved its cost.
  const { conn, stop } = await server({ VIDEO_TIMEOUT_S: "0.2" });
  assert.match((await call(conn, { prompt: "slow", output: "h.mp4" })).content[0].text, /was not finished after 0\.2s\. It was cancelled at the provider and is not billed\./);
  assert.match((await call(conn, { prompt: "already running", output: "i.mp4" })).content[0].text, /The provider had already started it: it will finish and be billed/);
  assert.equal(deleted().length, 4);
  stop();
}

// 9. In an xsb project, every generation is written into the project's ledger with what it is estimated to cost, from
// Ark's price list; the budget the user set is a hard cap, and a cost that is not known is not taken for zero.
{
  const ledger = path.join(dir, "spend.jsonl");
  const write = (rec: object) => fs.appendFileSync(ledger, JSON.stringify(rec) + "\n");
  const records = () => fs.readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const priced = () => ran().filter((c) => c.startsWith("pricing models")).length;
  const { conn, stop } = await server({ XSB_SPEND: ledger, XSB_AGENT: "camera1" });
  const before = ran().length;
  assert.match((await call(conn, { prompt: "x", output: "n.mp4" })).content[0].text, /No budget for generation is set for this project\. Generate nothing more; tell the user/);
  assert.equal(ran().length, before, "nothing was submitted");

  write({ op: "budget", at: "t", amount: 2.5 });
  const shot = await call(conn, { prompt: "Lin at dusk", output: "s.mp4" });
  // 48437 tokens at the highest of the model's 480p prices (0.046 of NV2V, over 0.028 of V2V): 2.23 yuan.
  assert.match(shot.content[0].text, /\nCost: about 2\.23 yuan; 48437 tokens of doubao-seedance-2-5-flash-261115; 0\.046 yuan per thousand tokens, the highest of doubao-seedance-2-5-flash's applicable prices\. Spent so far: about 2\.23 yuan of the budget of 2\.50 yuan/);
  const image = await call(conn, { prompt: "Lin", output: "l.png" }, "generate_image");
  assert.match(image.content[0].text, /Cost: about 0\.22 yuan; 1 image of doubao-seedream-5-0-260128; 0\.22 yuan per image/);
  assert.equal(priced(), 1, "the price list is read once, then kept");
  assert.deepEqual(records().filter((r) => r.op === "spend").map((r) => [r.agent, r.tool, r.amount?.toFixed(2)]), [["camera1", "generate_video", "2.23"], ["camera1", "generate_image", "0.22"]]);
  // Used up: nothing more, until the user raises it.
  const spent = ran().length;
  assert.match((await call(conn, { prompt: "y", output: "m.png" }, "generate_image")).content[0].text, /The budget for generation is used up: about 2\.45 yuan of 2\.50 yuan spent/);
  assert.equal(ran().length, spent);
  write({ op: "budget", at: "t", amount: 10 });
  assert.equal((await call(conn, { prompt: "y", output: "m.png" }, "generate_image")).isError, undefined);
  stop();

  // Without a price, the cost is unknown, and that holds generation back until the user sets the budget again.
  fs.rmSync(path.join(dir, "run"), { recursive: true, force: true });
  const unpriced = await server({ XSB_SPEND: ledger, FAKE_ARK_NO_PRICES: "1" });
  assert.match((await call(unpriced.conn, { prompt: "z", output: "z.png" }, "generate_image")).content[0].text, /Cost: unknown \(no price found\); 1 image of doubao-seedream-5-0-260128; Ark's price list could not be read/);
  assert.match((await call(unpriced.conn, { prompt: "z", output: "z2.png" }, "generate_image")).content[0].text, /1 generation\(s\) since the budget was set could not be priced/);
  write({ op: "budget", at: "t", amount: 10 });
  assert.equal((await call(unpriced.conn, { prompt: "z", output: "z2.png" }, "generate_image")).isError, undefined);
  unpriced.stop();
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("media-mcp: ok");
process.exit(0);
