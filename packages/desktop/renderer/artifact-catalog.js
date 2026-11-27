// 不依赖 DOM：制品按资产身份聚合，历史版本留在组内，工作文件各自保留。
export function artifactGroups(artifacts) {
  const groups = new Map();
  for (const artifact of artifacts) {
    const assetId = artifact.assetType === "workflow" && artifact.registeredName && artifact.assetVersion > 0 ? artifact.assetId : undefined;
    const key = assetId ? `asset:${assetId}` : `file:${artifact.id}`;
    const group = groups.get(key) ?? { key, assetId, versions: [] };
    group.versions.push(artifact);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    group.versions.sort((a, b) => b.assetVersion - a.assetVersion || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return { ...group, latest: group.versions[0] };
  });
}

export const categoryOf = (artifact) => ["image", "video"].includes(artifact.kind) ? artifact.kind : "document";

export function visibleArtifacts(groups, { query = "", category = "", agentId = "", scope = "", sort = "recent" } = {}, agentName = (id) => id) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return groups.filter((group) => {
    const a = group.latest;
    const haystack = `${a.name} ${a.path} ${a.description ?? ""} ${group.assetId ?? ""} ${agentName(a.agentId)}`.toLocaleLowerCase();
    return (!category || categoryOf(a) === category) && (!agentId || a.agentId === agentId)
      && (!scope || (scope === "assets" ? !!group.assetId : !group.assetId))
      && words.every((word) => haystack.includes(word));
  }).sort((a, b) => sort === "name"
    ? a.latest.name.localeCompare(b.latest.name, undefined, { numeric: true }) || a.key.localeCompare(b.key)
    : Date.parse(b.latest.updatedAt) - Date.parse(a.latest.updatedAt) || a.key.localeCompare(b.key));
}
