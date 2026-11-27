/** File operations in an ACP v2 tool_call_update diff. The optional text patch is for display. */
export type FileChange =
  | { operation: "add" | "modify" | "delete"; path: string }
  | { operation: "move" | "copy"; path: string; oldPath: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const validPath = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !value.includes("\0");

/** Claude's NotebookEdit and an Edit that fills an empty file can complete without a diff.
 * Keep only the relevant fields from their ACP rawInput, never the text being written. */
export function fileEditInput(input: unknown) {
  if (!record(input)) return;
  if (validPath(input.notebook_path)) return { notebook_path: input.notebook_path };
  if (validPath(input.file_path) && input.old_string === "" && typeof input.new_string === "string" && input.new_string.length)
    return { file_path: input.file_path, old_string: "" };
}

/** Match the retained input to the native tool name, which can arrive in a separate update. */
export function fileEditPath(name: unknown, input: unknown): string | undefined {
  if (!record(input)) return;
  if (name === "NotebookEdit" && validPath(input.notebook_path)) return input.notebook_path;
  if (name === "Edit" && input.old_string === "" && validPath(input.file_path)) return input.file_path;
}

/** Ignore unfamiliar content and operation types; locations may belong to read-only tools. */
export function fileChanges(content: unknown): FileChange[] {
  const files: FileChange[] = [];
  if (!Array.isArray(content)) return files;
  for (const block of content) {
    if (!record(block) || block.type !== "diff" || !Array.isArray(block.changes)) continue;
    for (const change of block.changes) {
      if (!record(change) || !validPath(change.path) || change.fileType === "directory") continue;
      const { operation, path, oldPath } = change;
      if (operation === "add" || operation === "modify" || operation === "delete") {
        files.push({ operation, path });
      } else if ((operation === "move" || operation === "copy") && validPath(oldPath)) {
        files.push({ operation, path, oldPath });
      }
    }
  }
  return files;
}
