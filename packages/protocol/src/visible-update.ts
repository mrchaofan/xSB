import { isAssistantOnly } from "./acp.ts";
import type { ContentBlock, SessionUpdate } from "./acp.ts";
import { Accepted, DeliveredAs, Discarded, OriginExt } from "./ext.ts";
import type { OriginMeta } from "./ext.ts";

export type SupplementalInput = (origin: OriginMeta, block?: ContentBlock) => boolean;

/** Project model content onto a human-facing ACP connection, including records written before audiences were stored. */
export function userVisibleUpdate(update: SessionUpdate, supplementalOrigin?: SupplementalInput): SessionUpdate | undefined {
  const meta = update._meta;
  const origin = meta?.[OriginExt.key] as OriginMeta | undefined;
  const internal = (from?: OriginMeta, block?: ContentBlock) => !!from && (from.kind === "system" && !from.role || supplementalOrigin?.(from, block) === true);
  const visible = (block: ContentBlock, from?: OriginMeta) => !isAssistantOnly(block) &&
    (block.annotations?.audience?.includes("user") === true || !internal(from, block));
  let result = update;
  if (update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk") {
    if (update.content && !visible(update.content, update.sessionUpdate === "user_message_chunk" ? origin : undefined)) return;
  } else if ((update.sessionUpdate === "user_message" || update.sessionUpdate === "agent_message") && Array.isArray(update.content)) {
    const from = update.sessionUpdate === "user_message" ? origin : undefined;
    const content = update.content.filter((b: ContentBlock) => visible(b, from));
    if (!content.length && update.content.length) return;
    if (content.length !== update.content.length) result = { ...update, content };
  }
  if (!meta) return result;

  // Older transcripts put the full scoped prompt in delivery metadata and workflow audit events.
  let changed: SessionUpdate["_meta"];
  if (Object.hasOwn(meta, "dev.xsb/workflow-log")) {
    changed = { ...meta };
    delete changed["dev.xsb/workflow-log"];
  }
  const delivery = meta[DeliveredAs.key] as DeliveredAs | undefined;
  if (typeof delivery?.scope === "string") (changed ??= { ...meta })[DeliveredAs.key] = { ...delivery, scope: true };
  for (const key of [Accepted.key, Discarded.key]) {
    const input = meta[key] as Accepted | Discarded | undefined;
    if (!Array.isArray(input?.content)) continue;
    const content = input.content.filter(b => visible(b, input.origin));
    if (!content.length && (input.content.length || internal(input.origin))) {
      changed ??= { ...meta };
      delete changed[key];
    } else if (content.length !== input.content.length) {
      (changed ??= { ...meta })[key] = { ...input, content };
    }
  }
  if (!changed) return result;
  if (!Object.keys(changed).length && result.sessionUpdate === "session_info_update" &&
      Object.keys(result).every(k => k === "sessionUpdate" || k === "_meta")) return;
  return { ...result, _meta: changed };
}
