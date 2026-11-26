import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertReleaseAssets, publishRelease, releaseContext, verifyBuilds } from "../../../scripts/release-publish.mjs";

const env = {
  GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", GITHUB_REPOSITORY: "mrchaofan/xSB",
  RELEASE_TAG: "v1.2.3", RELEASE_COMMIT: "a".repeat(40), GITHUB_SHA: "b".repeat(40), GITHUB_RUN_ID: "123",
};

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-release-publish-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const context = releaseContext(env);
  for (const target of ["mac-arm64", "win-x64"]) {
    const archive = `xsb-${context.version}-${target}.zip`;
    const filename = path.join(directory, archive);
    const bytes = Buffer.from(`fixture-${target}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync(filename, bytes);
    fs.writeFileSync(`${filename}.sha256`, `${sha256}  ${archive}\n`);
    fs.writeFileSync(`${filename}.build.json`, JSON.stringify({
      schemaVersion: 1, repository: context.repository, runId: context.runId,
      workflowSha: context.workflowSha, sourceCommit: context.sourceCommit,
      version: context.version, target, archive, sha256,
    }));
    // The gh boundary is mocked; these tests do not claim to validate a cryptographic signature.
    fs.writeFileSync(`${filename}.attestation.jsonl`, "fixture bundle");
  }
  const assets = verifyBuilds(directory, context, () => "");
  const release = { tag_name: context.tag, draft: true, immutable: false, author: { login: "github-actions[bot]" }, assets: assets.map((asset) => ({ ...asset, state: "uploaded" })) };
  const calls: string[][] = [];
  let exists = false;
  const command = (args: string[]) => {
    calls.push(args);
    if (args[0] === "attestation") return "";
    if (args[0] === "api") {
      if (args[1].includes("/releases/tags/")) {
        if (!exists || release.draft) throw Object.assign(new Error("missing"), { stderr: "gh: Not Found (HTTP 404)" });
        return JSON.stringify(release);
      }
      assert.equal(args[1], `repos/${context.repository}/releases?per_page=100`);
      assert.ok(args.includes("--paginate") && args.includes("--slurp"));
      return JSON.stringify([[{ tag_name: "v0.0.1" }], exists ? [release] : []]);
    }
    if (args[1] === "create") exists = true;
    if (args[1] === "upload") release.assets = assets.map((asset) => ({ ...asset, state: "uploaded" }));
    if (args[1] === "edit") { release.draft = false; release.immutable = true; }
    return "";
  };
  return { directory, context, assets, release, calls, command, setExists: () => { exists = true; } };
}

test("local execution and self-hosted publishing are rejected", () => {
  assert.throws(() => releaseContext({ ...env, GITHUB_ACTIONS: "false" }), /GitHub Actions/);
  assert.throws(() => releaseContext({ ...env, RUNNER_ENVIRONMENT: "self-hosted" }), /GitHub-hosted/);
});

test("both binaries and build records require the expected workflow signature", (t) => {
  const f = fixture(t);
  verifyBuilds(f.directory, f.context, f.command);
  assert.equal(f.calls.length, 4);
  for (const args of f.calls) {
    assert.equal(args[args.indexOf("--signer-workflow") + 1], "mrchaofan/xSB/.github/workflows/desktop.yml");
    assert.equal(args[args.indexOf("--source-digest") + 1], env.GITHUB_SHA);
    assert.ok(args.includes("--deny-self-hosted-runners"));
  }
  assert.throws(() => publishRelease(f.directory, f.context, (args: string[]) => {
    if (args[0] === "attestation") throw new Error("invalid signature");
    return f.command(args);
  }), /invalid signature/);
  assert.ok(!f.calls.some((args) => args[0] === "release"));
});

test("extra assets, modified bytes and records from another build commit or run are rejected", (t) => {
  const f = fixture(t);
  const filename = path.join(f.directory, "xsb-1.2.3-mac-arm64.zip");
  fs.writeFileSync(path.join(f.directory, "extra.zip"), "extra");
  assert.throws(() => verifyBuilds(f.directory, f.context, () => ""), /Unexpected or missing/);
  fs.unlinkSync(path.join(f.directory, "extra.zip"));
  const original = fs.readFileSync(filename);
  fs.writeFileSync(filename, "tampered");
  assert.throws(() => verifyBuilds(f.directory, f.context, () => ""), /checksum mismatch/);
  fs.writeFileSync(filename, original);
  const record = JSON.parse(fs.readFileSync(`${filename}.build.json`, "utf8"));
  for (const change of [{ sourceCommit: "c".repeat(40) }, { runId: "999" }]) {
    fs.writeFileSync(`${filename}.build.json`, JSON.stringify({ ...record, ...change }));
    assert.throws(() => verifyBuilds(f.directory, f.context, () => ""), /Build record does not match/);
  }
});

test("publishing uploads a draft before locking and verifies the resulting asset digests", (t) => {
  const f = fixture(t);
  publishRelease(f.directory, f.context, f.command);
  const mutations = f.calls.filter((args) => args[0] === "release");
  assert.deepEqual(mutations.map((args) => args[1]), ["create", "edit"]);
  assert.ok(mutations[0].includes("--draft"));
  assert.ok(mutations[1].includes("--draft=false"));
  assert.equal(f.release.immutable, true);
  f.calls.length = 0;
  publishRelease(f.directory, f.context, f.command);
  assert.ok(!f.calls.some((args) => args[0] === "release"), "Published rerun must not upload or edit");
});

test("draft lookup uses all release pages because the tag endpoint hides drafts", (t) => {
  const f = fixture(t);
  f.setExists();
  assert.throws(() => f.command(["api", `repos/${f.context.repository}/releases/tags/${f.context.tag}`]), /missing/);
  f.calls.length = 0;
  publishRelease(f.directory, f.context, f.command);
  const lookups = f.calls.filter((args) => args[0] === "api");
  assert.equal(lookups.length, 3, "find draft, verify uploaded draft, verify published release");
  assert.ok(lookups.every((args) => args.includes("--paginate") && args.includes("--slurp")));
  assert.deepEqual(f.calls.filter((args) => args[0] === "release").map((args) => args[1]), ["upload", "edit"]);
});

test("failed listings, ambiguous tags and vanished drafts never trigger publication", (t) => {
  const f = fixture(t);
  for (const status of [403, 404, 429, 500]) {
    assert.throws(() => publishRelease(f.directory, f.context, (args: string[]) => {
      if (args[0] === "api") throw Object.assign(new Error(`HTTP ${status}`), { stderr: `HTTP ${status}` });
      return f.command(args);
    }), new RegExp(`HTTP ${status}`));
  }
  assert.throws(() => publishRelease(f.directory, f.context, (args: string[]) => {
    if (args[0] === "api") return JSON.stringify([[f.release], [f.release]]);
    return f.command(args);
  }), /Multiple releases/);
  assert.ok(!f.calls.some((args) => args[0] === "release"));
  assert.throws(() => publishRelease(f.directory, f.context, (args: string[]) => {
    if (args[0] === "api") return "[[]]";
    return f.command(args);
  }), /Release not found after upload/);
  assert.ok(!f.calls.some((args) => args[0] === "release" && args[1] === "edit"));
});

test("draft reruns resume expected assets and refuse manual drafts or extra uploads", (t) => {
  const f = fixture(t);
  f.setExists();
  f.release.author.login = "human";
  assert.throws(() => publishRelease(f.directory, f.context, f.command), /draft created outside Actions/);
  f.release.author.login = "github-actions[bot]";
  f.release.assets.push({ name: "extra.zip", digest: "sha256:extra", size: 5, state: "uploaded" });
  assert.throws(() => publishRelease(f.directory, f.context, f.command), /Unexpected assets in release draft/);
  assert.ok(!f.calls.some((args) => args[0] === "release"));
  f.release.assets.length = 0;
  publishRelease(f.directory, f.context, f.command);
  assert.deepEqual(f.calls.filter((args) => args[0] === "release").map((args) => args[1]), ["upload", "edit"]);
});

test("an altered upload is caught before publication", (t) => {
  const f = fixture(t);
  assert.throws(() => publishRelease(f.directory, f.context, (args: string[]) => {
    const result = f.command(args);
    if (args[0] === "release" && args[1] === "create") f.release.assets[0].digest = "sha256:tampered";
    return result;
  }), /digest mismatch/);
  assert.ok(!f.calls.some((args) => args[0] === "release" && args[1] === "edit"));
  assert.equal(f.release.draft, true);
});

test("API errors, mutable releases and uploaded digest changes fail closed", (t) => {
  const f = fixture(t);
  assert.throws(() => publishRelease(f.directory, f.context, (args: string[]) => {
    if (args[0] === "api") throw Object.assign(new Error("forbidden"), { stderr: "HTTP 403" });
    return f.command(args);
  }), /forbidden/);
  f.setExists();
  f.release.draft = false;
  assert.throws(() => publishRelease(f.directory, f.context, f.command), /published mutable release/);
  f.release.immutable = true;
  f.release.assets[0].digest = "sha256:tampered";
  assert.throws(() => publishRelease(f.directory, f.context, f.command), /digest mismatch/);
  assert.throws(() => assertReleaseAssets({ ...f.release, assets: [] }, f.assets), /asset list mismatch/);
  assert.ok(!f.calls.some((args) => args[0] === "release"));
});

test("a new publication without GitHub's immutable lock is reported as a failure", (t) => {
  const f = fixture(t);
  assert.throws(() => publishRelease(f.directory, f.context, (args: string[]) => {
    const result = f.command(args);
    if (args[0] === "release" && args[1] === "edit") f.release.immutable = false;
    return result;
  }), /Published release was not locked/);
});
