/**
 * Content: the one shape of what is said in a conversation, by anyone.
 *
 * It is a list of ACP content blocks, in order. Nothing new is defined here:
 * this is what `session/prompt` takes and what `agent_message_chunk` and
 * `user_message_chunk` carry, so content goes to a model and comes back from
 * one without being converted. The blocks the app makes and shows:
 *
 *   { type: "text", text }                                  markdown
 *   { type: "image", mimeType, data }                       the bytes, base64
 *   { type: "resource_link", uri, name, mimeType?, size? }  a file, by reference
 *
 * A block of another type is kept and shown by its type, never dropped.
 *
 * Everything else is a projection of content, and there are five:
 *
 *   model  -> content   `append`, block by block as they stream in      (here)
 *   content -> model    none: content is the prompt
 *   clipboard -> content   `fromClipboard`                              (renderer/content.js)
 *   content <-> composer   `createEditor`: `insert` and `read`          (renderer/content.js)
 *   content -> transcript  `contentView`                                (renderer/content.js)
 */
import type { ContentBlock } from "@xsb/protocol";
import { assetRefTags } from "@xsb/protocol";

export type Content = ContentBlock[];

/** Show exact workflow references as chips while keeping the surrounding message verbatim. */
export function assetReferenceParts(block: ContentBlock): Content {
  if (block.type !== "text" || !block.text?.includes("<asset>")) return [block];
  const parts: Content = [];
  let offset = 0;
  for (const { index, raw, ref } of assetRefTags(block.text)) {
    if (!ref) continue;
    if (offset < index) parts.push({ ...block, text: block.text.slice(offset, index) });
    parts.push({ type: "asset_reference", ...ref });
    offset = index + raw.length;
  }
  if (!offset) return [block];
  if (offset < block.text.length) parts.push({ ...block, text: block.text.slice(offset) });
  return parts;
}

/**
 * `content` with one more block. Text that follows text continues it: a model
 * streams a sentence in pieces, and a pasted word joins the word before it.
 */
export function append(content: Content, block: ContentBlock): Content {
  const last = content.at(-1);
  if (block.type !== "text" || last?.type !== "text") return [...content, block];
  return [...content.slice(0, -1), { ...last, text: `${last.text}${block.text}` }];
}
