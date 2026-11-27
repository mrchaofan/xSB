import fs from "node:fs";
import path from "node:path";
import { ensureDirectory, syncDirectory } from "@xsb/store";
import type { Asset, AssetRef } from "@xsb/protocol";
import { assetRefsInText, formatAssetRef, parseAssetRef } from "@xsb/protocol";
import type { LiveSession, Turn } from "./session.ts";
import type { Hub } from "./hub.ts";
import type { Flow } from "./workflow-state.ts";
import { word, fingerprint } from "./workflow-graph.ts";
import { newId, now } from "./util.ts";

const refOf = (a: Asset): AssetRef => ({ name: a.name, version: "v" + a.version });
const assetKey = (name: string) => "workflow/" + name;
function assetName(v: unknown) {
  const name = word(v, "asset name");
  if (name in Object.prototype) throw Error("Invalid asset name");
  return name;
}

export const assetVersion = (hub: Hub, ref: AssetRef) =>
  hub.state.assets.get(assetKey(ref.name))?.find((a) => ref.version === "v" + a.version);

export function findAsset(hub: Hub, ref: AssetRef) {
  const asset = assetVersion(hub, ref);
  if (!asset) throw Error("Unknown asset version");
  return asset;
}

/** Resolve directory and content access against this specific attempt's fixed grants.
 * The caller commits any new asset, pointer and receipt together in the flow WAL. */
export function accessAsset(
  hub: Hub,
  f: Flow,
  s: LiveSession,
  turn: Turn,
  name: string,
  a: Record<string, any>,
): { value: unknown; registered?: Asset; pointer?: { id: string; version: string | null } } {
  const spec = hub.agent(s.agentId);
  const i = spec.workflowNode ? f.instances[spec.workflowNode] : undefined;
  const work = i?.work?.attempt === turn.first.messageId ? i.work : undefined;
  let result: unknown, registered: Asset | undefined;
  const ref = (name === "asset_get" || name === "asset_version_put") ? parseAssetRef(a.ref) : undefined;
  if (a.ref !== undefined && !ref) throw Error("Expected an asset reference name@vN");
  const asset = assetName(ref ? ref.name : a.name);
  const granted = [
    ...(work?.grants ?? []),
    ...(!work && i?.last?.valid ? i.last.assets : []),
    ...turn.inputs
      .filter((input) => input.in)
      .flatMap((input) => {
        // Only the user can grant a new reference by message. The serialized
        // assignment (including quoted predecessor summaries) already has fixed grants.
        const blocks =
          input.origin.kind === "user"
            ? input.content
            : (i?.interruptions.find((p) => p.id === input.interruptionId)?.prompt ?? []);
        return blocks.flatMap((b) => (b.type === "text" ? assetRefsInText(b.text ?? "") : []));
      }),
  ];
  const allowed = (v: Asset) =>
    !i || v.by === s.agentId || granted.some((r) => r.name === v.name && r.version === "v" + v.version);
  const exact = (version: string) => {
    const v = findAsset(hub, { name: asset, version });
    if (!allowed(v)) throw Error("Asset version outside this assignment");
    return v;
  };
  const versions = hub.state.assets.get(assetKey(asset)) ?? [];
  if (name === "asset_list") return { value: versions.filter(allowed).map(v => formatAssetRef(refOf(v))) };
  if (name === "asset_get") {
    const v = exact(ref!.version);
    result = { ref: formatAssetRef(ref!), path: v.path, content: hub.assets.text(v) };
    if (work && !work.staged) {
      const reads = (work.reads ??= []);
      if (!reads.some((r) => r.name === asset && r.version === ref!.version)) reads.push(refOf(v));
    }
  } else if (name === "asset_version_get") {
    const version = work?.selected[asset] ?? hub.state.assetPointers.get(assetKey(asset));
    if (!version) return { value: null };
    result = formatAssetRef(refOf(exact(version)));
    if (work && !work.staged) work.selected[asset] = version;
  } else {
    if (i && (!work || work.staged)) throw Error("Artifact writes closed");
    if (name === "asset_version_put") {
      if (i && work?.kind !== "extra")
        throw Error("Only the main agent or additional work can select the current pointer");
      result = formatAssetRef(refOf(exact(ref!.version)));
      return { value: result, pointer: { id: assetKey(asset), version: ref!.version } };
    } else if (name === "asset_put" && a.path === null) {
      if (work?.kind === "graph") throw Error("Graph work cannot clear assets");
      const current = hub.state.assetPointers.get(assetKey(asset));
      if (current) exact(current);
      return { value: null, pointer: { id: assetKey(asset), version: null } };
    } else if (name === "asset_put") {
      if (i && versions.length && !versions.some(allowed)) throw Error("Asset outside this assignment");
      const source = fs.realpathSync(path.resolve(spec.workspace, word(a.path, "file path")));
      if (!fs.statSync(source).isFile()) throw Error("Expected a file");
      if (i && fs.existsSync(hub.paths.assets)) {
        const relative = path.relative(fs.realpathSync(hub.paths.assets), source);
        if (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) {
          const registeredPath = path.join(hub.paths.assets, relative);
          const authorized = [...hub.state.assets.values()].some((list) =>
            list.some((v) => v.path === registeredPath && allowed(v)),
          );
          if (!authorized) throw Error("Source version outside this assignment");
        }
      }
      const dir = path.join(hub.paths.assets, "workflow", fingerprint(asset));
      ensureDirectory(dir);
      const version = versions.length + 1,
        file = path.join(dir, newId("file") + path.extname(source));
      fs.copyFileSync(source, file, fs.constants.COPYFILE_EXCL);
      const fd = fs.openSync(file, "r+");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.chmodSync(file, 0o444);
      syncDirectory(dir);
      registered = {
        id: assetKey(asset),
        type: "workflow",
        name: asset,
        version,
        path: file,
        description: asset,
        by: s.agentId,
        sessionId: f.owner,
        createdAt: now(),
      };
      result = formatAssetRef(refOf(registered));
    } else throw Error("Unknown asset tool");
  }
  return { value: result, registered };
}
