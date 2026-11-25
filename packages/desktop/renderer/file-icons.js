// 文件的图标：按扩展名分类，每类一个内联 SVG 和一种颜色；认不出的扩展名用通用文件图标。
// 用在侧栏的文件标签、已打开标签列表和资产管理的缩略图上。
import { h } from "./dom.js";

/** 每类的图形：16×16，与界面其余图标同一笔画；颜色由样式按 data-type 给出。 */
const SHAPES = {
  file: '<path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3"/>',
  markdown: '<path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3"/><path d="M5.5 12V9l1.25 1.5L8 9v3M10.5 9v3M9.5 11l1 1 1-1"/>',
  text: '<path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3"/><path d="M6 8h4M6 10h4M6 12h2.5"/>',
  code: '<path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3"/><path d="M7 8.5L5.5 10 7 11.5M9 8.5l1.5 1.5L9 11.5"/>',
  html: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12"/>',
  data: '<path d="M5.5 2.5C4 2.5 4 3.5 4 5s-1 2.5-1.5 3c.5.5 1.5 1.5 1.5 3s0 2.5 1.5 2.5M10.5 2.5c1.5 0 1.5 1 1.5 2.5s1 2.5 1.5 3c-.5.5-1.5 1.5-1.5 3s0 2.5-1.5 2.5"/>',
  image: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="5.5" cy="6" r="1.2"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3"/>',
  video: '<rect x="1.5" y="3.5" width="9" height="9" rx="1.5"/><path d="M10.5 7l4-2.5v7l-4-2.5"/>',
  audio: '<path d="M6 12V3.5l7-1.5V10.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="10.5" r="1.5"/>',
  pdf: '<path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3"/><path d="M5.5 12.5V9h1a1 1 0 0 1 0 2h-1M8.5 12.5V9h.5a1.5 1.5 0 0 1 0 3.5h-.5"/>',
  sheet: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6h12M2 9.5h12M6 2.5v11"/>',
  slides: '<rect x="1.5" y="2.5" width="13" height="9" rx="1.5"/><path d="M8 11.5v2.5M5.5 14h5"/>',
  archive: '<path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3"/><path d="M7 3v1M7 5v1M7 7v1M6.5 9h1v2h-1z"/>',
};

const TYPES = {
  markdown: ["md", "markdown", "mdx"],
  text: ["txt", "log", "rtf"],
  code: ["js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "zsh", "bash", "css", "scss", "less", "sql", "lua", "vue", "svelte"],
  html: ["html", "htm"],
  data: ["json", "jsonl", "yaml", "yml", "toml", "xml", "ini", "env"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic", "tif", "tiff"],
  video: ["mp4", "m4v", "mov", "webm", "mkv", "avi"],
  audio: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"],
  pdf: ["pdf"],
  sheet: ["csv", "tsv", "xls", "xlsx", "numbers"],
  slides: ["ppt", "pptx", "key"],
  archive: ["zip", "tar", "gz", "tgz", "rar", "7z"],
};
const BY_EXTENSION = new Map(Object.entries(TYPES).flatMap(([type, list]) => list.map((ext) => [ext, type])));

/** 文件名对应的类型；没有扩展名或认不出的是 "file"。 */
export function fileType(name = "") {
  const match = /\.([a-z0-9]+)$/i.exec(String(name));
  return (match && BY_EXTENSION.get(match[1].toLowerCase())) ?? "file";
}

/** 文件名对应的图标。 */
export function fileIcon(name) {
  const type = fileType(name);
  return h("span", { class: "file-icon", "data-type": type, "aria-hidden": "true", html: `<svg viewBox="0 0 16 16">${SHAPES[type]}</svg>` });
}
