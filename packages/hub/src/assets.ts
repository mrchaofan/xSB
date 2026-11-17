/**
 * The asset library: the one place a character, a style, a script or a shot
 * is defined, so that every agent works from the same thing.
 *
 * An asset is a file with an id (`<type>/<name>`). Registering copies the file
 * into the library, where nothing rewrites it; registering the same id again
 * adds a version. Agents pass ids, not paths of their own working files.
 */
import fs from "node:fs";
import path from "node:path";
import { Assets as AssetsExt } from "@xsb/protocol";
import type { Asset } from "@xsb/protocol";
import type { Hub } from "./hub.ts";
import type { LiveSession } from "./session.ts";
import { ops } from "./state.ts";
import { now } from "./util.ts";

/** Text assets up to this size are shown to a model in full, not only by path. */
const INLINE_BYTES = 32 * 1024;
const TEXT = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".srt", ".fountain"]);

const part = (value: string, what: string): string => {
  const v = value.trim();
  if (!v || v.startsWith(".") || /[\/\\\s]/.test(v)) throw new Error(`asset ${what} "${value}" must be one word without "/" and not start with "."`);
  return v;
};

export class Assets {
  private hub: Hub;

  constructor(hub: Hub) {
    this.hub = hub;
  }

  /** Register a file, or text, as the next version of `<type>/<name>`. */
  put(by: LiveSession, input: { type: string; name: string; description: string; path?: string; content?: string }): Asset {
    const type = part(input.type, "type");
    const name = part(input.name, "name");
    const id = `${type}/${name}`;
    const version = (this.hub.state.assets.get(id)?.length ?? 0) + 1;
    const dir = path.join(this.hub.paths.assets, type, name);
    fs.mkdirSync(dir, { recursive: true });
    let file: string;
    if (input.path) {
      const source = path.resolve(this.hub.agent(by.agentId).workspace, input.path);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`no file at ${source}`);
      file = path.join(dir, `v${version}${path.extname(source)}`);
      fs.copyFileSync(source, file);
    } else if (input.content !== undefined) {
      file = path.join(dir, `v${version}.md`);
      fs.writeFileSync(file, input.content);
    } else {
      throw new Error(`give "path" (a file) or "content" (text)`);
    }
    const item = by.current?.req.item;
    const asset: Asset = {
      id,
      type,
      name,
      version,
      description: input.description,
      path: file,
      by: by.agentId,
      taskId: item?.taskId,
      createdAt: now(),
    };
    this.hub.state.commit([ops.putAsset(asset)]);
    this.hub.broadcast(AssetsExt.update, { asset });
    return asset;
  }

  /** An asset by id, optionally `<id>@<version>`. The latest version otherwise. */
  get(ref: string): Asset | undefined {
    const [id, version] = ref.split("@");
    const versions = this.hub.state.assets.get(id);
    return version ? versions?.[Number(version) - 1] : versions?.at(-1);
  }

  /** Latest versions, optionally of one type and matching a word. */
  find(type?: string, query?: string): Asset[] {
    const q = query?.trim().toLowerCase();
    return [...this.hub.state.assets.values()]
      .map((versions) => versions.at(-1)!)
      .filter((a) => (!type || a.type === type) && (!q || `${a.id} ${a.description}`.toLowerCase().includes(q)));
  }

  /** The text of a small text asset; undefined for media and for anything large. */
  text(asset: Asset): string | undefined {
    if (!TEXT.has(path.extname(asset.path).toLowerCase())) return undefined;
    try {
      return fs.statSync(asset.path).size <= INLINE_BYTES ? fs.readFileSync(asset.path, "utf8") : undefined;
    } catch {
      return undefined;
    }
  }
}
