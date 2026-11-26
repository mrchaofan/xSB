import { Discarded, History, RpcError } from "@xsb/protocol";
import type { ContentBlock, HistoryImage, SessionUpdate } from "@xsb/protocol";
import type { Store } from "@xsb/store";
import { Paths } from "./paths.ts";

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
    const { sessionUpdate, toolCallId, title, status, locations, _meta } = update;
    return { sessionUpdate, toolCallId, title, status, locations, _meta };
  }
  if (update.sessionUpdate === "state_update" || update.sessionUpdate === "agent_thought_chunk") {
    return update.sessionUpdate === "agent_thought_chunk" ? { sessionUpdate: update.sessionUpdate, _meta: update._meta } : update;
  }
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
