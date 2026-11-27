import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleArtifacts } from "../renderer/artifact-catalog.js";

const file = (id: string, extra = {}) => ({ id, path: id, name: id.split("/").at(-1), kind: "markdown", agentId: "writer", updatedAt: "2026-11-17T12:00:00Z", ...extra });

test("file list filters by name, path, type, and agent and sorts names naturally", () => {
  const files = [
    file("雪景.png", { kind: "image", path: "场景/雪景.png", agentId: "art", updatedAt: "2026-11-17T14:00:00Z" }),
    file("剧本.md"), file("clip", { kind: "video", path: "scratch/snow.mp4", agentId: "art" }),
  ];
  const nameOf = (id: string) => id === "art" ? "美术指导" : "编剧";
  assert.deepEqual(visibleArtifacts(files, { query: " 美术 场景 ", category: "image", agentId: "art" }, nameOf).map(f => f.id), ["雪景.png"]);
  assert.equal(visibleArtifacts(files, { query: "SNOW" }, nameOf)[0].id, "clip");
  assert.equal(visibleArtifacts(files, { category: "document" }, nameOf)[0].id, "剧本.md");
  assert.equal(visibleArtifacts(files, { query: "不存在" }, nameOf).length, 0);
  assert.deepEqual(visibleArtifacts([file("10.md"), file("2.md")], { sort: "name" }).map(f => f.id), ["2.md", "10.md"]);
});
