import { assetRefsInText, assetRefTag, canonicalAssetTags, formatAssetRef, parseAssetRef } from "@xsb/protocol";
import type { AssetRef } from "@xsb/protocol";

function resource(value: object): boolean {
  if (!("type" in value)) return false;
  if (value.type === "resource_link") return "uri" in value;
  if (value.type === "resource") return "resource" in value;
  return (value.type === "image" || value.type === "audio") && "data" in value;
}
const pathLike = (value: string) => /[\\/]|^(?:file|data|https?):/i.test(value);
const fileText = (value: string) => /^(?:[\\/]|\.{1,2}[\\/]|(?:file|data|https?):|[a-z]:[\\/]|[^\s<>:]+[\\/])/i.test(value);
const legacyRef = (value: object) => Object.keys(value).length === 2 ? parseAssetRef(value) : undefined;
type KnownAsset = (ref: AssetRef) => boolean;

/** Bind bare strings only when the entire field names an existing version. Prose, paths and ACP files remain data. */
function material(value: unknown, forModel: boolean, known?: KnownAsset): unknown {
  if (typeof value === "string") {
    if (forModel) return canonicalAssetTags(value);
    const ref = !pathLike(value) && parseAssetRef(value);
    return ref && known?.(ref) ? ref : value;
  }
  if (Array.isArray(value)) return value.map(v => material(v, forModel, known));
  if (!value || typeof value !== "object" || resource(value)) return value;
  const ref = legacyRef(value);
  if (ref) return forModel ? (pathLike(ref.name) ? assetRefTag(ref) : formatAssetRef(ref)) : ref;
  return materialFields(value as Record<string, unknown>, forModel, known);
}

/** A graph node's input is always a field dictionary, even when it has fields called name and version. */
export function materialFields(fields: Record<string, unknown>, forModel: boolean, known?: KnownAsset): Record<string, unknown> {
  if (resource(fields)) return fields;
  return Object.fromEntries(Object.entries(fields).map(([k, value]) => [k, material(value, forModel, known)]));
}

/** Grants come from the frozen input fields, never from the name/URI of a file block or an arbitrary business record. */
export function inputAssetRefs(fields: Record<string, unknown> | undefined): AssetRef[] {
  function refs(value: unknown): AssetRef[] {
    if (typeof value === "string") return fileText(value) ? [] : assetRefsInText(value);
    if (Array.isArray(value)) return value.flatMap(refs);
    if (!value || typeof value !== "object") return [];
    const ref = legacyRef(value);
    return ref ? [ref] : inputAssetRefs(value as Record<string, unknown>);
  }
  return fields && !resource(fields) ? Object.values(fields).flatMap(refs) : [];
}

export function deliveryForModel<T extends { summary: string; assets: AssetRef[] }>(delivery: T) {
  return { ...delivery, summary: canonicalAssetTags(delivery.summary), assets: delivery.assets.map(formatAssetRef) };
}

/** Older immutable tool receipts keep their identity and effects while presenting the current reference format. */
export function assetReceipt(name: string, value: unknown): unknown {
  if (name === "asset_list" && Array.isArray(value)) return value.map(v => assetReceipt("asset_version_get", v));
  if (name.startsWith("asset_") && value && typeof value === "object") {
    const ref = parseAssetRef(value);
    if (ref) {
      const { name: _name, version: _version, ...rest } = value as Record<string, unknown>;
      return name === "asset_get" ? { ref: formatAssetRef(ref), ...rest } : formatAssetRef(ref);
    }
  }
  return value;
}
