import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Paths } from "@xsb/hub";
import { History, Workflow, type WorkflowView } from "@xsb/protocol";
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

test("Files includes local Markdown deliveries from this workflow's tasks, additional work and saved versions", async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-workflow-artifacts-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const image = "角色 设定.png";
  for (const name of [image, "edited.md", "extra.md", "archived.md", "input.md", "example.md", "other.md"])
    fs.writeFileSync(path.join(project, name), name);
  let update: (payload: { workflow: WorkflowView }) => void;
  const peer = {
    onNotification(name: string, fn: typeof update) { if (name === Workflow.update) update = fn; },
    onRequest() {}, closed: new Promise(() => {}), close() {},
    request(method: string, { sessionId }: { sessionId: string }) {
      assert.equal(method, History.files);
      return { files: sessionId === "owner" ? [{ path: "edited.md", agentId: "editor" }] : [] };
    },
  };
  const ws = new Workspace(new Paths(project), peer as any, String, () => {});
  t.after(() => ws.close());

  const task = { kind: "task", status: "completed", name: "Draw", agentId: "artist", paused: false } as const;
  const output = [
    "![角色图][character]", "[edited](edited.md)", "[missing](absent.png)", "[site](https://example.org/input.md)",
    "`[example](example.md)`", "", `[character]: <${image}>`,
  ].join("\n");
  const flow: WorkflowView = {
    sessionId: "owner", version: "plan-2", format: "markdown", edges: [], paused: false,
    nodes: [{ ...task, markdown: { input: "[source](input.md)", output },
      additionalResults: [{ id: "extra", summary: "[Notes](extra.md)" }] }],
    history: [{ version: "plan-1", format: "markdown", retiredAt: "2026-11-20", edges: [],
      nodes: [{ ...task, agentId: "previous-artist", markdown: { output: "[Archive](archived.md)" } }] }],
  };
  update!({ workflow: flow });
  update!({ workflow: { ...flow, sessionId: "second", history: [], nodes: [
    { ...task, agentId: "other-artist", markdown: { output: "[Other](other.md)" } },
  ] } });

  const files = await ws.conversationFiles("owner");
  assert.deepEqual(files.map(f => [f.name, f.agentId]).sort(), [
    [image, "artist"], ["edited.md", "editor"], ["extra.md", "artist"], ["archived.md", "previous-artist"],
  ].sort());
  for (const file of files) assert.deepEqual(file.sessionIds, ["owner"]);
  assert.deepEqual((await ws.conversationFiles("second")).map(f => f.name), ["other.md"]);

  const preview = files.find(f => f.name === image)!;
  const key = new URL(preview.url).searchParams.get("key");
  assert.ok(key);
  ws.refreshArtifact(preview.id);
  assert.equal(ws.canServeArtifact(preview.id, key), true);
  assert.equal(ws.canServeArtifact(preview.id, null), false);
  assert.equal(ws.canServeArtifact(preview.id, "other"), false);
});
