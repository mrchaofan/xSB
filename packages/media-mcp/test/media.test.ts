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
  ]);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((name) => /^xsb-ark-\w{6}$/.test(name) && fs.readdirSync(path.join(os.tmpdir(), name)).some((file) => file.endsWith(".mp4"))), []); // arkcli's own directory is not left behind

  // 2. What was not asked for is not passed, and a model never is: that is set in arkcli; a reference that is a URL is passed as it is.
  await call(conn, { prompt: "the river at night", output: "b.mp4", reference_images: ["https://example.com/style.png"] });
  assert.equal(ran()[4], "+gen the river at night --modality=video --watermark=false --input=reference_image:https://example.com/style.png --save-to=");

  // 3. An image: one call.
  const drawn = await call(conn, { prompt: "Lin, front view", output: "refs/lin_front.png", reference_images: ["lin.png"], size: "2K" }, "generate_image");
  assert.equal(drawn.content[0].text, `Saved ${dir}/refs/lin_front.png`);
  assert.equal(fs.readFileSync(path.join(dir, "refs/lin_front.png"), "utf8"), "IMAGE of Lin, front view");
  assert.equal(ran().at(-1), "+gen Lin, front view --modality=image --size=2K --output-format=png --watermark=false --save-to=TMP --input=reference_image:@CWD/lin.png");

  // 4. Failures are the tool's answer, in words an agent can act on.
  const refused = await call(conn, { prompt: "refused", output: "c.mp4" });
  assert.deepEqual([refused.isError, refused.content[0].text], [true, "generation cgt-3 failed: the prompt was refused"]);
  assert.match((await call(conn, { prompt: "x" })).content[0].text, /"output" is required/);
  stop();
  const noCli = await server({ ARKCLI: "xsb-no-such-arkcli" });
  assert.match((await call(noCli.conn, { prompt: "x", output: "e.png" }, "generate_image")).content[0].text, /"xsb-no-such-arkcli" is not installed or not on PATH.*arkcli auth login/);
  noCli.stop();
  const signedOut = await server({ FAKE_ARK_SIGNED_OUT: "1" });
  assert.match((await call(signedOut.conn, { prompt: "x", output: "e.png" }, "generate_image")).content[0].text, /arkcli \+gen x: not configured \(run `arkcli auth login` and retry\)/);
  signedOut.stop();
  const unknown = await server({ VIDEO_PROVIDER: "sora" });
  assert.match((await call(unknown.conn, { prompt: "x", output: "e.mp4" })).content[0].text, /unknown VIDEO_PROVIDER "sora"\. Known: seedance/);
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
  // The server is stopped while it waits, as the hub stops a cancelled job.
  const killed = await server();
  void call(killed.conn, { prompt: "slow", output: "g.mp4" }).catch(() => {});
  await until("the slow task is being polled", () => ran().at(-1)!.startsWith("gen get cgt-4"));
  killed.stop();
  await until("the stopped server cancelled its task", () => deleted().includes("gen delete cgt-4 --yes=true"));

  // A generation that takes too long is called off too; the answer says whether that saved its cost.
  const { conn, stop } = await server({ VIDEO_TIMEOUT_S: "0.2" });
  assert.match((await call(conn, { prompt: "slow", output: "h.mp4" })).content[0].text, /was not finished after 0\.2s\. It was cancelled at the provider and is not billed\./);
  assert.match((await call(conn, { prompt: "already running", output: "i.mp4" })).content[0].text, /The provider had already started it: it will finish and be billed/);
  assert.equal(deleted().length, 3);
  stop();
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("media-mcp: ok");
process.exit(0);
