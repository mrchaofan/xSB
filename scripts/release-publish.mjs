import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const targets = ["mac-arm64", "win-x64"];
const suffixes = ["", ".sha256", ".build.json", ".attestation.jsonl"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function releaseContext(env = process.env) {
  assert.equal(env.GITHUB_ACTIONS, "true", "Publishing requires GitHub Actions");
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted", "Publishing requires a GitHub-hosted runner");
  assert.match(env.GITHUB_REPOSITORY ?? "", /^[\w.-]+\/[\w.-]+$/);
  assert.match(env.RELEASE_TAG ?? "", /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.match(env.RELEASE_COMMIT ?? "", /^[a-f0-9]{40}$/);
  assert.match(env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.match(env.GITHUB_RUN_ID ?? "", /^\d+$/);
  return {
    repository: env.GITHUB_REPOSITORY,
    tag: env.RELEASE_TAG,
    version: env.RELEASE_TAG.slice(1),
    sourceCommit: env.RELEASE_COMMIT,
    workflowSha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
  };
}

export function verifyBuilds(directory, context, command = gh) {
  const expected = targets.flatMap((target) => suffixes.map((suffix) => `xsb-${context.version}-${target}.zip${suffix}`)).sort();
  assert.deepEqual(fs.readdirSync(directory).sort(), expected, "Unexpected or missing release assets");
  for (const target of targets) {
    const archive = `xsb-${context.version}-${target}.zip`;
    const filename = path.join(directory, archive);
    const bytes = fs.readFileSync(filename);
    assert.ok(bytes.length, `Empty archive: ${archive}`);
    const sha256 = digest(bytes);
    assert.equal(fs.readFileSync(`${filename}.sha256`, "utf8"), `${sha256}  ${archive}\n`, "Archive checksum mismatch");
    // Authenticate both the binary and the record before trusting its actual checkout commit.
    for (const subject of [filename, `${filename}.build.json`]) {
      command(["attestation", "verify", subject,
        "--repo", context.repository,
        "--signer-workflow", `${context.repository}/.github/workflows/desktop.yml`,
        "--source-ref", "refs/heads/main",
        "--source-digest", context.workflowSha,
        "--deny-self-hosted-runners",
        "--bundle", `${filename}.attestation.jsonl`]);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(`${filename}.build.json`, "utf8")), {
      schemaVersion: 1, repository: context.repository, runId: context.runId,
      workflowSha: context.workflowSha, sourceCommit: context.sourceCommit,
      version: context.version, target, archive, sha256,
    }, "Build record does not match this release run and source commit");
  }
  return expected.map((name) => {
    const bytes = fs.readFileSync(path.join(directory, name));
    return { name, digest: `sha256:${digest(bytes)}`, size: bytes.length };
  });
}

export function assertReleaseAssets(release, assets) {
  assert.deepEqual(release.assets.map(({ name }) => name).sort(), assets.map(({ name }) => name).sort(), "Release asset list mismatch");
  for (const expected of assets) {
    const actual = release.assets.find(({ name }) => name === expected.name);
    assert.equal(actual.state, "uploaded", `Incomplete upload: ${expected.name}`);
    assert.equal(actual.digest, expected.digest, `Uploaded asset digest mismatch: ${expected.name}`);
    assert.equal(actual.size, expected.size, `Uploaded asset size mismatch: ${expected.name}`);
  }
}

export function publishRelease(directory, context, command = gh) {
  const assets = verifyBuilds(directory, context, command);
  // The tag endpoint only returns published releases; listing also includes authenticated drafts.
  const endpoint = `repos/${context.repository}/releases?per_page=100`;
  const getRelease = () => {
    const pages = JSON.parse(command(["api", endpoint, "--paginate", "--slurp"]));
    const matches = pages.flat().filter((release) => release.tag_name === context.tag);
    assert.ok(matches.length <= 1, "Multiple releases match the version tag");
    return matches[0];
  };
  // API failures propagate; only a successful listing without the tag means the release is missing.
  let release = getRelease();
  if (release && !release.draft) {
    assert.equal(release.immutable, true, "Refusing to modify a published mutable release");
    assertReleaseAssets(release, assets);
    return; // A publish-only rerun verifies the locked release without replacing anything.
  }
  const files = assets.map(({ name }) => path.join(directory, name));
  if (release) {
    assert.equal(release.author.login, "github-actions[bot]", "Refusing a draft created outside Actions");
    assert.ok(release.assets.every(({ name }) => assets.some((asset) => asset.name === name)), "Unexpected assets in release draft");
    command(["release", "upload", context.tag, ...files, "--repo", context.repository, "--clobber"]);
  } else {
    command(["release", "create", context.tag, ...files, "--repo", context.repository, "--draft", "--verify-tag", "--generate-notes"]);
  }
  release = getRelease();
  assert.ok(release, "Release not found after upload");
  assert.equal(release.draft, true, "Release must remain a draft until all assets are verified");
  assert.equal(release.author.login, "github-actions[bot]");
  assertReleaseAssets(release, assets);
  command(["release", "edit", context.tag, "--repo", context.repository, "--draft=false"]);
  release = getRelease();
  assert.ok(release, "Release not found after publication");
  assert.equal(release.draft, false);
  assert.equal(release.immutable, true, "Published release was not locked");
  assertReleaseAssets(release, assets);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const context = releaseContext();
  if (process.argv[2] === "verify") verifyBuilds("release", context);
  else if (process.argv[2] === "publish") publishRelease("release", context);
  else throw new Error("Expected verify or publish");
}
