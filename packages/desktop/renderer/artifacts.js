import { artifactGroups, categoryOf, versionOf, visibleArtifacts } from "./artifact-catalog.js";
import { fill, h, ICON } from "./dom.js";
import { language, t } from "./i18n.js";

const dateLabel = (iso) => {
  const date = new Date(iso);
  return date.toLocaleDateString() === new Date().toLocaleDateString()
    ? date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(language, { month: "short", day: "numeric" });
};

/** 搜索控件保持原节点：新制品到达时不会打断输入或失去焦点。 */
export const artifactLabel = (artifact) => artifact.name.replaceAll("\\", "/").split("/").at(-1);

export function createArtifactBrowser(open, nameOf, assetName) {
  const filters = { query: "", category: "", agentId: "", scope: "", sort: "recent" };
  let artifacts = [], groups = [], selectedId = null;
  const results = h("div", { class: "artifact-results" });
  const summary = h("span", { class: "catalog-count", role: "status", "aria-live": "polite" });
  const clear = h("button", { class: "link", type: "button", onclick: reset }, t("artifact.filter.clear"));
  const search = h("input", { type: "search", class: "artifact-search", placeholder: t("artifact.search"), "aria-label": t("artifact.search"), oninput: () => { filters.query = search.value; render(); } });
  search.onkeydown = (event) => {
    if (event.key === "Escape") { search.value = filters.query = ""; render(); }
    if (event.key === "Enter") { const first = visible()[0]; if (first) open(first.latest.id); }
  };
  const chips = h("div", { class: "catalog-types", role: "group", "aria-label": t("artifact.filter.type") },
    ...["", "image", "video", "document"].map((category) => h("button", { type: "button", "data-category": category, onclick: () => { filters.category = category; render(); } }, t(`artifact.type.${category || "all"}`))));
  const agent = h("select", { "aria-label": t("artifact.filter.agent"), onchange: () => { filters.agentId = agent.value; render(); } });
  const scope = h("select", { "aria-label": t("artifact.filter.scope"), onchange: () => { filters.scope = scope.value; render(); } },
    ...["", "assets", "files"].map((value) => h("option", { value }, t(`artifact.scope.${value || "all"}`))));
  const sort = h("select", { "aria-label": t("artifact.sort"), onchange: () => { filters.sort = sort.value; render(); } },
    h("option", { value: "recent" }, t("artifact.sort.recent")), h("option", { value: "name" }, t("artifact.sort.name")));
  const advanced = h("details", { class: "catalog-advanced" },
    h("summary", { html: ICON.filter }, h("span", {}, t("artifact.filter.more"))),
    h("div", { class: "catalog-filters" },
      h("label", {}, t("artifact.filter.agent"), agent), h("label", {}, t("artifact.filter.scope"), scope), h("label", {}, t("artifact.sort"), sort)));
  const el = h("div", { class: "artifact-browser" },
    h("div", { class: "catalog-controls" }, search, chips,
      h("div", { class: "catalog-summary" }, summary, advanced, clear)), results);
  const visible = () => visibleArtifacts(groups, filters, nameOf);

  function reset() {
    Object.assign(filters, { query: "", category: "", agentId: "", scope: "", sort: "recent" });
    search.value = agent.value = scope.value = "";
    sort.value = "recent";
    render();
  }

  function render() {
    const list = visible();
    summary.textContent = t("artifact.results", { count: list.length, total: groups.length });
    clear.hidden = !filters.query && !filters.category && !filters.agentId && !filters.scope;
    advanced.classList.toggle("filtered", !!filters.agentId || !!filters.scope || filters.sort !== "recent");
    chips.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.category === filters.category)));
    fill(results, ...list.map((group) => {
      const a = group.latest;
      const category = categoryOf(a);
      const thumb = h("span", { class: `artifact-thumb ${category}`, html: category === "video" ? ICON.play : ICON.file });
      if (category === "image") {
        const image = h("img", { src: a.url, alt: "", loading: "lazy", decoding: "async" });
        image.onerror = () => image.remove();
        thumb.append(image);
      }
      const label = `${a.name}\n${nameOf(a.agentId)} · ${a.updatedAt}\n${a.path}`;
      return h("button", { class: "artifact-card", type: "button", title: label, "data-id": a.id, "aria-pressed": String(group.versions.some((version) => version.id === selectedId)), onclick: () => open(a.id) },
        thumb, h("span", { class: "artifact-card-text" },
          h("strong", {}, artifactLabel(a)),
          h("span", { class: "artifact-card-meta" }, h("span", {}, nameOf(a.agentId)), h("time", { datetime: a.updatedAt }, dateLabel(a.updatedAt))),
          a.description && h("small", { class: "artifact-description" }, a.description),
          h("span", { class: "artifact-badges" }, h("span", {}, group.assetId ? assetName(a.assetType ?? group.assetId.split("/")[0]) : t(`artifact.type.${category}`)),
            group.assetId && h("span", {}, versionOf(a) ? `v${versionOf(a)}` : t("artifact.latest")),
            group.versions.length > 1 && h("span", {}, t("artifact.versions", { count: group.versions.length })))));
    }));
    if (!list.length) fill(results, h("div", { class: "catalog-empty" }, h("strong", {}, t(artifacts.length ? "artifact.noResults" : "artifact.list.empty")),
      artifacts.length > 0 && h("button", { class: "btn", onclick: reset }, t("artifact.filter.clear"))));
  }

  return { el, filters, visible, groups: () => groups, focus: () => search.focus(),
    update(items, selection) {
      artifacts = items;
      selectedId = selection;
      groups = artifactGroups(items);
      const owners = [...new Set(groups.map((group) => group.latest.agentId))];
      fill(agent, h("option", { value: "" }, t("artifact.filter.agent")), ...owners.map((id) => h("option", { value: id }, nameOf(id))));
      if (!owners.includes(filters.agentId)) filters.agentId = "";
      agent.value = filters.agentId;
      render();
    }, reset };
}

/** 预览中的相邻制品和版本选择，遵循当前的搜索与筛选顺序。 */
export function artifactNavigation(browser, artifact, open) {
  const group = browser.groups().find((g) => g.versions.some((a) => a.id === artifact.id));
  const list = browser.visible();
  const index = list.findIndex((g) => g.key === group?.key);
  const previous = list[index - 1], next = index >= 0 ? list[index + 1] : null;
  const move = (neighbor, label, icon) => h("button", { class: "icon-btn artifact-step", disabled: !neighbor, title: `${t(label)}${neighbor ? ` · ${neighbor.latest.name}` : ""}`, "aria-label": t(label), onclick: () => neighbor && open(neighbor.latest.id), html: icon });
  return h("div", { class: "artifact-navigation" }, move(previous, "artifact.previous", ICON.back),
    h("span", { class: "artifact-position", title: t("artifact.results", { count: index + 1, total: list.length }) }, index >= 0 ? `${index + 1}/${list.length}` : "–"),
    move(next, "artifact.next", ICON.forward));
}

/** 完整信息只在详情面板显示，路径可复制，版本与查看方式保持可访问。 */
export function artifactDetails(browser, artifact, nameOf, open) {
  const group = browser.groups().find((g) => g.versions.some((a) => a.id === artifact.id));
  const path = h("code", {}, artifact.path);
  const copy = h("button", { class: "icon-btn", title: t("artifact.copyPath"), "aria-label": t("artifact.copyPath"), html: ICON.copy, onclick: async () => {
    try { await xsb.copyText(artifact.path); copy.title = t("content.copied"); }
    catch { copy.title = t("content.copyFailed"); }
  } });
  const item = (label, value) => h("div", { class: "artifact-detail-field" }, h("small", {}, t(label)), value);
  return h("div", { class: "artifact-detail-fields" },
    item("artifact.fileName", h("strong", {}, artifact.name)),
    artifact.description && item("artifact.description", h("p", {}, artifact.description)),
    item("artifact.location", h("div", { class: "artifact-location" }, path, copy)),
    item("artifact.createdBy", h("span", {}, nameOf(artifact.agentId))),
    item("artifact.updated", h("time", { datetime: artifact.updatedAt }, new Date(artifact.updatedAt).toLocaleString(language))),
    group?.versions.length > 1 && item("artifact.version", h("select", { "aria-label": t("artifact.version"), onchange: (event) => open(event.target.value) },
      ...group.versions.map((a) => h("option", { value: a.id, selected: a.id === artifact.id }, `v${versionOf(a)} · ${dateLabel(a.updatedAt)}`)))));
}
