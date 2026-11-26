import { ICON, fill, h } from "./dom.js";
import { language, t } from "./i18n.js";

function setting(options, category, ids) {
  return options.find(o => o.type === "select" && (o.category === category || ids.includes(o.configId ?? o.id)));
}

function choices(option) {
  return (option?.options ?? []).flatMap(item => item.options ?? [item]);
}

export function composerSettings(agentId, onUpdate = () => {}) {
  let latest = {}, sequence = 0, working = false, fetching = false, message = "";
  const trigger = h("button", { class: "model-settings", type: "button", "aria-haspopup": "dialog" });
  const ring = h("span", { class: "context-ring", tabindex: "0" });
  const percentLabel = h("small", { "aria-hidden": "true" });
  const usage = h("span", { class: "context-usage" }, ring, percentLabel);
  // 级联菜单：一级是"模型 ›""推理强度 ›"及当前值，悬停、点击或按 → 展开二级的选项列表，点一项即生效。
  const fields = h("div", { class: "cascade", role: "menu", "aria-label": t("composer.settings") });
  const status = h("small", { role: "status" });
  const menu = h("div", { class: "composer-menu", popover: "auto" }, fields, status);
  let openName = null;
  const el = h("div", { class: "composer-settings" }, trigger, menu);
  let lastFields;
  function draw() {
    onUpdate(latest);
    const options = Array.isArray(latest.configOptions) ? latest.configOptions : [];
    const model = setting(options, "model", ["model"]);
    const effort = setting(options, "thought_level", ["reasoning_effort", "reasoning-effort", "effort", "thought_level"]);
    const label = (option, fallback) => choices(option).find(o => o.value === option?.currentValue)?.name ?? option?.currentValue ?? fallback;
    // 还没连上后端时只知道选过的值；有一项已知，另一项就是后端默认，都不知道时显示两项的名字。
    const known = [label(model, latest.selected?.model), label(effort, latest.selected?.reasoning_effort ?? latest.selected?.effort)];
    const labels = known.some(Boolean)
      ? known.map((value) => value ?? t("composer.default"))
      : [t("composer.model"), t("composer.effort")];
    trigger.textContent = labels.join(" · ");
    trigger.title = t("composer.settings") + " · " + trigger.textContent;
    const used = latest.used, size = latest.size;
    const percent = Number.isFinite(used) && size > 0 ? Math.round(used / size * 100) : null;
    percentLabel.textContent = percent === null ? "" : percent + "%";
    ring.style.setProperty("--used", Math.min(100, percent ?? 0) + "%");
    ring.dataset.known = String(percent !== null);
    ring.title = percent === null ? t("composer.unknown") : t("composer.usage", { percent, used: used.toLocaleString(language), size: size.toLocaleString(language) });
    ring.setAttribute("aria-label", ring.title);
    ring.setAttribute("role", percent === null ? "img" : "meter");
    if (percent === null) {
      for (const attribute of ["aria-valuenow", "aria-valuemin", "aria-valuemax", "aria-valuetext"]) ring.removeAttribute(attribute);
    }
    else {
      ring.setAttribute("aria-valuenow", String(Math.min(100, percent)));
      ring.setAttribute("aria-valuemin", "0");
      ring.setAttribute("aria-valuemax", "100");
      ring.setAttribute("aria-valuetext", ring.title);
    }
    // 后端还没连上、正在拉取时，值和列表都显示"获取中"，不拿"后端默认"冒充已知的值。
    // 新对话也一样：打开菜单时中枢为它建立后端会话，设置随即可选。
    const loading = fetching && !latest.connected;
    const signature = JSON.stringify([model, effort, latest.connected, loading]);
    if (signature !== lastFields) {
      lastFields = signature;
      fill(fields, ...[[model, "model"], [effort, "effort"]].map(([option, name]) => {
        const items = choices(option);
        const current = items.find(o => o.value === option?.currentValue);
        const sub = h("div", { class: "cascade-sub", role: "menu", "aria-label": t("composer." + name) },
          ...items.map(o => h("button", { type: "button", role: "menuitemradio", class: "cascade-item", "aria-checked": String(o.value === option.currentValue),
            onclick: () => { menu.hidePopover(); request(() => xsb.setComposerOption(agentId, option.configId ?? option.id, o.value)); } },
            h("span", { class: "cascade-check", "aria-hidden": "true", html: ICON.check }), h("span", {}, o.name ?? o.value))),
          !items.length && (loading || latest.connected) && h("small", { class: "cascade-empty" }, t(loading ? "composer.loading" : "composer.unsupported")));
        const row = h("div", { class: "cascade-row", "data-name": name },
          h("button", { type: "button", role: "menuitem", class: "cascade-item cascade-parent", "aria-haspopup": "menu", "aria-expanded": "false",
            onclick: () => expand(name, true), onmouseenter: () => expand(name), onfocus: () => expand(name) },
            h("span", {}, t("composer." + name)), h("small", {}, loading ? t("composer.loading") : current?.name ?? option?.currentValue ?? t("composer.default")),
            h("span", { class: "cascade-arrow", "aria-hidden": "true", html: ICON.forward })),
          sub);
        return row;
      }));
      if (openName) expand(openName);
    }
    fields.querySelectorAll(".cascade-sub .cascade-item").forEach(b => { b.disabled = working; });
    status.textContent = message;
    status.hidden = !message;
  }
  /** fetch：只是拉取最新设置（打开菜单时），不显示"正在读取"的状态行，列表里显示获取中。 */
  async function request(operation, fetch = false) {
    const seq = ++sequence;
    working = true;
    fetching = fetch;
    message = fetch ? "" : t("composer.pending");
    draw();
    try {
      const result = await operation();
      if (seq === sequence) { latest = result; message = ""; lastFields = null; }
    } catch (error) {
      if (seq === sequence) { lastFields = null; message = error.message; }
    } finally {
      if (seq === sequence) { working = fetching = false; draw(); }
    }
  }
  /** 展开一项的二级列表；放不下时朝左展开。focus：把焦点移进去（点击或按 → 时）。 */
  function expand(name, focus = false) {
    openName = name;
    for (const row of fields.querySelectorAll(".cascade-row")) {
      const open = row.dataset.name === name;
      row.classList.toggle("open", open);
      row.querySelector(".cascade-parent").setAttribute("aria-expanded", String(open));
      if (!open) continue;
      const box = menu.getBoundingClientRect(), sub = row.querySelector(".cascade-sub");
      row.classList.toggle("flip", box.right + sub.offsetWidth + 8 > innerWidth);
      if (focus) (sub.querySelector('[aria-checked="true"]') ?? sub.querySelector("button"))?.focus();
    }
  }
  menu.addEventListener("keydown", (e) => {
    const inSub = e.target.closest(".cascade-sub");
    const list = [...(inSub ?? fields).querySelectorAll(inSub ? ".cascade-item" : ".cascade-parent")];
    const i = list.indexOf(e.target);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); list[(i + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length]?.focus(); }
    else if (e.key === "ArrowRight" && !inSub && e.target.closest(".cascade-row")) { e.preventDefault(); expand(e.target.closest(".cascade-row").dataset.name, true); }
    else if ((e.key === "ArrowLeft" || e.key === "Escape") && inSub) { e.preventDefault(); e.stopPropagation(); inSub.parentElement.querySelector(".cascade-parent").focus(); }
  });
  menu.addEventListener("toggle", () => {
    const open = menu.matches(":popover-open");
    trigger.setAttribute("aria-expanded", String(open));
    if (!open) { openName = null; fields.querySelectorAll(".cascade-row.open").forEach(r => r.classList.remove("open")); }
  });
  trigger.onclick = () => {
    if (menu.matches(":popover-open")) return menu.hidePopover();
    const rect = trigger.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(innerWidth - 228, rect.left)) + "px";
    menu.style.bottom = (innerHeight - rect.top + 7) + "px";
    menu.showPopover();
    fields.querySelector(".cascade-parent")?.focus();
    request(() => xsb.composerState(agentId, true), true);
  };
  draw();
  let updated = false;
  xsb.composerState(agentId).then(value => {
    if (!updated && !sequence) { latest = value; draw(); }
  }).catch(() => {});
  return { el, usage, update(value) { updated = true; latest = value; draw(); } };
}
