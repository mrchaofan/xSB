import { categoryOf, visibleArtifacts } from "./artifact-catalog.js";
import { fill, h, ICON } from "./dom.js";
import { language, t } from "./i18n.js";

const dateLabel = (iso) => {
  const date = new Date(iso);
  return date.toLocaleDateString() === new Date().toLocaleDateString()
    ? date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(language, { month: "short", day: "numeric" });
};

/** 搜索控件保持原节点：新文件到达时不会打断输入或失去焦点。 */
export const artifactLabel = (artifact) => artifact.name.replaceAll("\\", "/").split("/").at(-1);

export function createArtifactBrowser(open, nameOf, reference, referenceTitle) {
  const filters = { query: "", category: "", agentId: "", sort: "recent" };
  let artifacts = [], selectedId = null;
  const results = h("div", { class: "artifact-results" });
  const summary = h("span", { class: "catalog-count", role: "status", "aria-live": "polite" });
  const clear = h("button", { class: "link", type: "button", onclick: reset }, t("artifact.filter.clear"));
  const search = h("input", { type: "search", class: "artifact-search", placeholder: t("artifact.search"), "aria-label": t("artifact.search"), oninput: () => { filters.query = search.value; render(); } });
  search.onkeydown = (event) => {
    if (event.key === "Escape") { search.value = filters.query = ""; render(); }
    if (event.key === "Enter") { const first = visible()[0]; if (first) open(first.id); }
  };
  const chips = h("div", { class: "catalog-types", role: "group", "aria-label": t("artifact.filter.type") },
    ...["", "image", "video", "document"].map((category) => h("button", { type: "button", "data-category": category, onclick: () => { filters.category = category; render(); } }, t(`artifact.type.${category || "all"}`))));
  const agent = h("select", { "aria-label": t("artifact.filter.agent"), onchange: () => { filters.agentId = agent.value; render(); } });
  const sort = h("select", { "aria-label": t("artifact.sort"), onchange: () => { filters.sort = sort.value; render(); } },
    h("option", { value: "recent" }, t("artifact.sort.recent")), h("option", { value: "name" }, t("artifact.sort.name")));
  const advanced = h("details", { class: "catalog-advanced" },
    h("summary", { html: ICON.filter }, h("span", {}, t("artifact.filter.more"))),
    h("div", { class: "catalog-filters" }, chips,
      h("label", {}, t("artifact.filter.agent"), agent), h("label", {}, t("artifact.sort"), sort)));
  const el = h("div", { class: "artifact-browser" },
    h("div", { class: "catalog-controls" }, h("div", { class: "catalog-tools" }, search, advanced),
      h("div", { class: "catalog-summary" }, summary, clear)), results);
  const visible = () => visibleArtifacts(artifacts, filters, nameOf);

  function restore(saved = {}) {
    Object.assign(filters, { query: "", category: "", agentId: "", sort: "recent" }, saved);
    search.value = filters.query;
    agent.value = filters.agentId;
    sort.value = filters.sort;
    advanced.open = false;
    render();
  }

  function reset() { restore(); }

  function render() {
    const list = visible();
    el.querySelector(".catalog-controls").hidden = !artifacts.length;
    el.querySelector(".catalog-summary").hidden = !filters.query && !filters.category && !filters.agentId;
    summary.textContent = t("artifact.results", { count: list.length, total: artifacts.length });
    clear.hidden = !filters.query && !filters.category && !filters.agentId;
    advanced.classList.toggle("filtered", !!filters.category || !!filters.agentId || filters.sort !== "recent");
    chips.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.category === filters.category)));
    fill(results, ...list.map((a) => {
      const category = categoryOf(a);
      const thumb = h("span", { class: `artifact-thumb ${category}`, html: category === "video" ? ICON.play : ICON.file });
      if (category === "image") {
        const image = h("img", { src: a.url, alt: "", loading: "lazy", decoding: "async" });
        image.onerror = () => image.remove();
        thumb.append(image);
      }
      const label = `${a.name}\n${nameOf(a.agentId)} · ${a.updatedAt}\n${a.path}`;
      const preview = h("button", { class: "artifact-card", type: "button", title: label, "data-id": a.id, "aria-pressed": String(a.id === selectedId), onclick: () => open(a.id) },
        thumb, h("span", { class: "artifact-card-text" },
          h("strong", {}, artifactLabel(a)),
          h("span", { class: "artifact-card-meta" }, h("span", {}, nameOf(a.agentId)), h("time", { datetime: a.updatedAt }, dateLabel(a.updatedAt))),
          h("small", { class: "artifact-description" }, a.path)));
      const action = t("artifact.referenceFile");
      return h("div", { class: "artifact-row" }, preview, h("button", { class: "reference-action", type: "button", "data-name": a.name,
        title: referenceTitle(), "aria-label": [action, a.name, referenceTitle()].join(" · "), onclick: () => reference(a) }, action));
    }));
    if (!list.length) fill(results, h("div", { class: "catalog-empty" }, !artifacts.length && h("span", { class: "empty-folder", html: ICON.folder }), h("strong", {}, t(artifacts.length ? "artifact.noResults" : "artifact.inSession")),
      !artifacts.length && h("small", {}, t("artifact.emptyHint")),
      artifacts.length > 0 && h("button", { class: "btn", onclick: reset }, t("artifact.filter.clear"))));
  }

  return { el, filters, visible, focus: () => search.focus(),
    update(items, selection) {
      artifacts = items;
      selectedId = selection;
      const owners = [...new Set(items.map((file) => file.agentId))];
      fill(agent, h("option", { value: "" }, t("artifact.filter.agent")), ...owners.map((id) => h("option", { value: id }, nameOf(id))));
      if (!owners.includes(filters.agentId)) filters.agentId = "";
      agent.value = filters.agentId;
      render();
    }, reset, restore };
}

/** 预览中的相邻文件，遵循当前的搜索与筛选顺序。 */
export function artifactNavigation(browser, artifact, open) {
  const list = browser.visible();
  const index = list.findIndex((file) => file.id === artifact.id);
  const previous = list[index - 1], next = index >= 0 ? list[index + 1] : null;
  const move = (neighbor, label, icon) => h("button", { class: "icon-btn artifact-step", disabled: !neighbor, title: `${t(label)}${neighbor ? ` · ${neighbor.name}` : ""}`, "aria-label": t(label), onclick: () => neighbor && open(neighbor.id), html: icon });
  return h("div", { class: "artifact-navigation" }, move(previous, "artifact.previous", ICON.back),
    h("span", { class: "artifact-position", title: t("artifact.results", { count: index + 1, total: list.length }) }, index >= 0 ? `${index + 1}/${list.length}` : "–"),
    move(next, "artifact.next", ICON.forward));
}
