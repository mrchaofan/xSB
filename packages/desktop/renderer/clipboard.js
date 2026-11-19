import { imageMimeType, isImageFileName } from "../src/image.ts";
import { t } from "./i18n.js";

/** A clipboard File may have an empty MIME type, particularly when copied from a file manager. */
export async function imageFromFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = imageMimeType(bytes);
  if (!mimeType) throw new Error(t("content.imageUnsupported"));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return { type: "image", mimeType, data: btoa(binary) };
}

/** Read event data synchronously before it expires. Native clipboard fallback applies only to paste. */
export function fromClipboard(data, nativeClipboard = false) {
  const files = [...data.files];
  const text = data.getData("text/plain");
  if (files.length) return Promise.all(files.map(async (file) => {
    const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (imageMimeType(header) || file.type.startsWith("image/") || isImageFileName(file.name)) return imageFromFile(file);
    const path = xsb.pathOf(file);
    return { type: "resource_link", uri: path ? `file://${path.split("/").map(encodeURIComponent).join("/")}` : file.name, name: file.name, size: file.size, ...(file.type ? { mimeType: file.type } : {}) };
  }));
  // Finder/path-only copies and OS screenshots are not always exposed as browser Files.
  const native = nativeClipboard && xsb.readClipboardImages ? xsb.readClipboardImages() : Promise.resolve(null);
  return Promise.resolve(native).then((images) => images?.length ? images : text ? [{ type: "text", text }] : []);
}
