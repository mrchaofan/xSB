import path from "node:path";
import { Discarded, History, RpcError, fileChanges, fileEditInput, fileEditPath } from "@xsb/protocol";
import type { ContentBlock, FileChange, HistoryImage, SessionUpdate } from "@xsb/protocol";
import type { Hub } from "./hub.ts";
import type { LiveSession } from "./session.ts";
import type { Store } from "@xsb/store";
import { Paths } from "./paths.ts";

/** Codex image generation can report a local savedPath alongside its inline image or file id. */
function savedOutput(output: unknown): string | undefined {
  if (!output || typeof output !== "object" || !("status" in output) || typeof output.status !== "string" ||
      !("result" in output || "fileId" in output) || !("savedPath" in output)) return;
  const path = output.savedPath;
  return typeof path === "string" && path.trim() && !path.includes("\0") ? path : undefined;
}

/** Only transcript content the desktop displays crosses its history connection. */
export function historyUpdate(update: SessionUpdate, sessionId: string, offset: number): SessionUpdate | undefined {
  const block = (content: ContentBlock, index: number): ContentBlock => content.type === "image"
    ? { type: "image", mimeType: content.mimeType, data: "", _meta: { [History.imageKey]: { sessionId, offset, index } } }
    : content;
  if (update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk") {
    return { ...update, content: block(update.content, -1) };
  }
  if (update.sessionUpdate === "session_info_update") {
    const discarded = update._meta?.[Discarded.key] as Discarded | undefined;
    return discarded ? { ...update, _meta: { ...update._meta, [Discarded.key]: { ...discarded, content: discarded.content.map(block) } } } : update;
  }
  if (update.sessionUpdate === "tool_call_update") {
    const { sessionUpdate, toolCallId, title, name, kind, status, locations, _meta } = update;
    const view: SessionUpdate = { sessionUpdate, toolCallId, title, name, kind, status, locations, _meta };
    if (update.rawInput !== undefined) view.rawInput = fileEditInput(update.rawInput) ?? null;
    if (update.rawOutput !== undefined) {
      const savedPath = savedOutput(update.rawOutput);
      view.rawOutput = savedPath ? { savedPath } : null;
    }
    if (update.content !== undefined) {
      const changes = fileChanges(update.content);
      const terminals = Array.isArray(update.content)
        ? update.content.filter(b => b?.type === "terminal" && typeof b.terminalId === "string")
        : [];
      view.content = update.content === null ? null : [...terminals, ...(changes.length ? [{ type: "diff", changes }] : [])];
    }
    return view;
  }
  if (update.sessionUpdate === "state_update" || update.sessionUpdate === "agent_thought_chunk") {
    return update.sessionUpdate === "agent_thought_chunk" ? { sessionUpdate: update.sessionUpdate, _meta: update._meta } : update;
  }
}

type FileCall = {
  status?: string | null;
  name?: string | null;
  input?: ReturnType<typeof fileEditInput> | null;
  changes?: FileChange[];
  savedPath?: string | null;
  completedAt?: { ts: string; order: number };
};
type ToolEvent = Omit<FileCall, "completedAt"> & { id: string; ts: string; order: number };
type SessionFiles = { bytes: number; calls: Map<string, FileCall> };
const bySession = new WeakMap<LiveSession, SessionFiles>();

/** Read only the transcript tail since the last request. Keep file metadata in memory,
 * never patch text, terminal output or inline image data. The transcript remains authoritative.
 */
function sessionFiles(session: LiveSession, store: Store) {
  const file = Paths.transcript(session.agentId, session.id);
  const size = store.bytes(file);
  let cache = bySession.get(session);
  if (!cache || size < cache.bytes) {
    cache = { bytes: 0, calls: new Map() };
    bySession.set(session, cache);
  }
  if (size === cache.bytes) return cache.calls.values();
  const tail: ToolEvent[] = [];
  for (const { record, offset } of store.readBackwardEntries(file, size)) {
    if (offset < cache.bytes) break;
    const u = record.update;
    if (u?.sessionUpdate !== "tool_call_update" || typeof u.toolCallId !== "string") continue;
    if (u.status === undefined && u.name === undefined && u.rawInput === undefined && u.content === undefined && u.rawOutput === undefined) continue;
    tail.push({
      id: u.toolCallId, status: u.status, name: u.name,
      input: u.rawInput === undefined ? undefined : fileEditInput(u.rawInput) ?? null,
      changes: u.content === undefined ? undefined : fileChanges(u.content),
      savedPath: u.rawOutput === undefined ? undefined : savedOutput(u.rawOutput) ?? null,
      ts: record.ts ?? "", order: record.toolOrder ?? offset,
    });
  }
  for (const event of tail.reverse()) {
    const call: FileCall = cache.calls.get(event.id) ?? {};
    if (event.status !== undefined && event.status !== call.status) {
      call.status = event.status;
      call.completedAt = event.status === "completed" ? { ts: event.ts, order: event.order } : undefined;
    }
    if (event.name !== undefined) call.name = event.name;
    if (event.input !== undefined) call.input = event.input;
    if (event.changes !== undefined) call.changes = event.changes;
    if (event.savedPath !== undefined) call.savedPath = event.savedPath;
    cache.calls.set(event.id, call);
  }
  cache.bytes = size;
  return cache.calls.values();
}

export function historyFiles(hub: Hub, owner: string) {
  const completed: { ts: string; order: number; agentId: string; changes?: FileChange[]; savedPath?: string | null }[] = [];
  for (const session of hub.live.values()) {
    if (session.id !== owner && hub.agent(session.agentId).workflowOwner !== owner) continue;
    for (const call of sessionFiles(session, hub.state.store)) {
      if (!call.completedAt) continue;
      const savedPath = call.savedPath ?? (call.changes?.length ? undefined : fileEditPath(call.name, call.input));
      if (call.changes?.length || savedPath)
        completed.push({ ...call.completedAt, agentId: session.agentId, changes: call.changes, savedPath });
    }
  }
  completed.sort((a, b) => a.ts.localeCompare(b.ts) || a.order - b.order);
  const files = new Map<string, string>();
  for (const { changes, savedPath, agentId } of completed) {
    const workspace = hub.agent(agentId).workspace;
    const resolve = (target: string) => hub.paths.resolveStored(path.resolve(workspace, target));
    for (const change of changes ?? []) {
      const file = resolve(change.path);
      if (change.operation === "move") files.delete(resolve(change.oldPath));
      if (change.operation === "delete") files.delete(file);
      else files.set(file, agentId);
    }
    if (savedPath) files.set(resolve(savedPath), agentId);
  }
  return { files: [...files].map(([path, agentId]) => ({ path, agentId })) };
}

/** Page boundaries fall before a complete input, so output and multi-block input stay together. */
export function historyPage(store: Store, agentId: string, sessionId: string, before?: number, turns = 10) {
  const reversed: SessionUpdate[] = [];
  let cursor: number | null = null;
  let inputs = 0;
  let inputId: string | undefined;
  for (const { offset, record } of store.readBackwardEntries(Paths.transcript(agentId, sessionId), before)) {
    const update = record.update as SessionUpdate;
    if (inputs >= turns && !(update.sessionUpdate === "user_message_chunk" && update.messageId === inputId)) break;
    if (update.sessionUpdate === "user_message_chunk" && update.messageId !== inputId) {
      if (inputs >= turns) break;
      inputId = update.messageId;
      inputs++;
    }
    const view = historyUpdate(update, sessionId, offset);
    if (view) reversed.push(view);
    cursor = offset;
  }
  return { updates: reversed.reverse(), cursor: cursor === 0 || reversed.length === 0 ? null : cursor };
}

export function historyImage(store: Store, agentId: string, ref: HistoryImage): ContentBlock {
  if (!Number.isSafeInteger(ref.offset) || ref.offset < 0 || !Number.isSafeInteger(ref.index) || ref.index < -1) throw RpcError.invalidParams("invalid image reference");
  const update = store.readAt(Paths.transcript(agentId, ref.sessionId), ref.offset)?.update;
  const discarded = update?._meta?.[Discarded.key] as Discarded | undefined;
  const content = ref.index === -1 ? update?.content : discarded?.content[ref.index];
  if (content?.type !== "image" || typeof content.data !== "string") throw RpcError.notFound("history image");
  return content;
}
