/** Narrow AIR compatibility boundary. Internal consumers always use ACP shapes. */
import type { PromptSuggestion, SessionUpdate } from "@xsb/protocol";
/** AIR adapters gate baseline compatibility on presence of this object. No optional AIR features are claimed. */
export const AIR_COMPATIBILITY = { jetbrains: { air: { version: 1, capabilities: [] } } };
export function airSuggestions(update: SessionUpdate): PromptSuggestion[] | undefined {
  const raw = update.sessionUpdate === "session_info_update" ? (update._meta?.promptSuggestions as { suggestions?: unknown } | undefined)?.suggestions : undefined;
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap(item => typeof item?.text === "string" && item.text.trim() ? [{ prompt: [{ type: "text", text: item.text }] }] : []);
}
