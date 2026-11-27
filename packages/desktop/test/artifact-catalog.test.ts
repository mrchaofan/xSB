import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactGroups, visibleArtifacts } from "../renderer/artifact-catalog.js";

const file = (id: string, extra = {}) => ({ id, path: id, name: id.split("/").at(-1), kind: "markdown", agentId: "writer", updatedAt: "2026-11-17T12:00:00Z", ...extra });

test("only registered workflow versions share a catalog entry, including files with version-like paths", () => {
  const asset = { assetId: "workflow/scene", registeredName: "scene", assetType: "workflow" };
  const items = [
    file("/a", { ...asset, assetVersion: 2, updatedAt: "2026-11-17T13:00:00Z" }),
    file("/b", { ...asset, assetVersion: 10, updatedAt: "2026-11-17T10:00:00Z" }),
    file("/c", { ...asset, assetVersion: 1 }),
    file("/x/doc.md", { path: ".xsb/assets/script/scene/v1.md" }),
    file("/y/doc.md", { path: ".xsb/assets/script/scene/v2.md" }),
  ];
  const groups = artifactGroups(items);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].assetId, "workflow/scene");
  assert.equal(groups[0].latest.id, "/b");
  assert.deepEqual(groups[0].versions.map((a) => a.id), ["/b", "/a", "/c"]);
  assert.equal(items[0].id, "/a");
});

test("catalog combines name, path, description, type, member and source filters", () => {
  const groups = artifactGroups([
    file("image1", { kind: "image", assetId: "workflow/snow", assetType: "workflow", registeredName: "snow", assetVersion: 1, name: "雪景.png", description: "场景参考", agentId: "art", updatedAt: "2026-11-17T14:00:00Z" }),
    file("script", { name: "剧本.md" }),
    file("clip", { kind: "video", path: "scratch/snow.mp4", agentId: "art" }),
  ]);
  const nameOf = (id: string) => id === "art" ? "美术指导" : "编剧";
  assert.deepEqual(visibleArtifacts(groups, {}, nameOf).map((g) => g.latest.id), ["image1", "clip", "script"]);
  assert.deepEqual(visibleArtifacts(groups, { query: " 美术 场景 ", category: "image", agentId: "art", scope: "assets" }, nameOf).map((g) => g.latest.id), ["image1"]);
  assert.equal(visibleArtifacts(groups, { query: "SNOW", scope: "files" }, nameOf)[0].latest.id, "clip");
  assert.equal(visibleArtifacts(groups, { category: "document" }, nameOf)[0].latest.id, "script");
  assert.equal(visibleArtifacts(groups, { query: "不存在" }, nameOf).length, 0);
  assert.deepEqual(visibleArtifacts(artifactGroups([file("10.md"), file("2.md")]), { sort: "name" }).map((g) => g.latest.id), ["2.md", "10.md"]);
});
