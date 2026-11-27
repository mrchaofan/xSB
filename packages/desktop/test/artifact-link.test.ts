import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Paths } from "@xsb/hub";
import { History } from "@xsb/protocol";
import { artifactKind, artifactPath } from "../src/artifact-link.ts";
import { Workspace } from "../src/workspace.ts";

test("Markdown file links resolve escaped names, relative paths and source lines", () => {
  const base = path.resolve("/tmp/project");
  const file = path.join(base, "文档 a.md");
  assert.equal(artifactPath("./%E6%96%87%E6%A1%A3%20a.md", base), file);
  assert.equal(artifactPath("notes.md:12:3", base), path.join(base, "notes.md"));
  if (process.platform === "win32") assert.equal(artifactPath("C:%5Cdocs%5Cnotes.md", base), "C:\\docs\\notes.md");
  assert.equal(artifactPath(`${file}:12:3`, base), file);
  assert.equal(artifactPath(`${pathToFileURL(file).href}#L12`, base), file);
  assert.equal(artifactPath(`xsb-artifact://file/${encodeURIComponent(file)}?v=1`, base), file);
  assert.equal(artifactPath("../other.md#heading", base), path.resolve(base, "../other.md"));
  for (const href of ["", "javascript:alert(1)", "data:text/plain,a", "https://example.com", "//example.com/a", "file://example.com/a", "xsb-artifact://other/a", "%00", "%zz"]) {
    assert.throws(() => artifactPath(href, base));
  }
});

test("the sidebar previews supported media, markup and source, and offers other formats as files", () => {
  for (const [name, kind] of Object.entries({
    "brief.MD": "markdown", "index.htm": "html", "photo.JPG": "image", "scene.mp4": "video",
    "notes.txt": "text", "tool.ts": "text", "data.csv": "text", ".env": "text", Makefile: "text",
    "report.pdf": "unsupported", "workbook.xlsx": "unsupported", "bundle.zip": "unsupported", "custom.abc": "unsupported",
  })) assert.equal(artifactKind(name), kind, name);
});

test("clicking a file registers a preview without adding it to Files, and document links resolve beside the source", async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-artifact-link-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, "docs"));
  const file = path.join(project, "docs", "文档 a.md");
  const sibling = path.join(project, "docs", "next.md");
  fs.writeFileSync(file, "# Hello");
  fs.writeFileSync(sibling, "# Next");
  const peer = { onNotification() {}, onRequest() {}, closed: new Promise(() => {}), close() {},
    request(method: string) { assert.equal(method, History.files); return { files: [{ path: sibling, agentId: "reviewer" }] }; } };
  const ws = new Workspace(new Paths(project), peer as any, String, () => {});
  t.after(() => ws.close());
  const artifact = ws.openArtifact("docs/%E6%96%87%E6%A1%A3%20a.md:12", "writer");
  assert.equal(artifact.id, file);
  assert.equal(artifact.kind, "markdown");
  assert.equal(artifact.path, path.join("docs", "文档 a.md"));
  assert.equal(ws.artifacts.get(file), artifact);
  assert.equal(ws.openArtifact("next.md", "writer", artifact.id).id, sibling);
  assert.equal(ws.openArtifact(pathToFileURL(file).href).id, file);
  assert.deepEqual((await ws.conversationFiles("owner")).map(item => [item.path, item.agentId, item.sessionIds]), [
    [path.join("docs", "next.md"), "reviewer", ["owner"]],
  ]);
  assert.throws(() => ws.openArtifact("missing.md"), /file not found/);
  assert.throws(() => ws.openArtifact("next.md", "writer", "/unknown.md"), /unknown source/);
});
