export const categoryOf = (file) => ["image", "video"].includes(file.kind) ? file.kind : "document";

export function visibleArtifacts(files, { query = "", category = "", agentId = "", sort = "recent" } = {}, agentName = (id) => id) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return files.filter(file => {
    const searchable = `${file.name} ${file.path} ${agentName(file.agentId)}`.toLocaleLowerCase();
    return (!category || categoryOf(file) === category) && (!agentId || file.agentId === agentId)
      && words.every(word => searchable.includes(word));
  }).sort((a, b) => sort === "name"
    ? a.name.localeCompare(b.name, undefined, { numeric: true }) || a.path.localeCompare(b.path)
    : Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.path.localeCompare(b.path));
}
