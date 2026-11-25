// One persistent control per provider: status updates preserve focus, open details and agent drafts.
import { state } from "./app.js";
import { CLI_DETAILS, backendPresentation } from "./backend-state.js";
import { arkModelLabel } from "./ark.js";
import { backendIcon } from "./backend-icons.js";
import { h } from "./dom.js";
import { openDialog } from "./form.js";
import { t } from "./i18n.js";

const results = new Map();
const errors = new Map();
const notices = new Map();
const busy = new Map();
const listeners = new Set();
let sequence = 0;
const changed = () => listeners.forEach((refresh) => refresh());
export const refreshBackendControls = changed;

export function backendControls(backend, onChange = () => {}, { card = false } = {}) {
  const cli = backend.cli;
  const key = cli ?? backend.name;
  const provider = CLI_DETAILS[cli];
  const name = provider?.name ?? backend.name;
  const root = h(card ? "section" : "div", { class: card ? "backend-card" : "backend-controls", "aria-label": name });
  const badge = h("span", { class: "backend-badge" });
  const version = h("small", { class: "backend-version" });
  const status = h("div", { class: "backend-status", role: "status", "aria-live": "polite", "aria-atomic": "true" }, badge, version);
  const description = h("p", { class: "backend-description" });
  const notice = h("p", { class: "backend-notice", role: "status", "aria-live": "polite", hidden: true });
  const errorDetails = h("details", { class: "backend-error-details", hidden: true }, h("summary", {}, t("backend.error.details")));
  const errorText = h("p", {});
  errorDetails.append(errorText);
  let presentation;
  const button = (label, action, props = {}) => h("button", { class: "btn", type: "button", ...props, onclick: (event) => {
    event.preventDefault(); event.stopPropagation();
    root.querySelector("[popover]:popover-open")?.hidePopover();
    action();
  } }, t(label));

  const work = async (action) => {
    if (busy.has(key)) return false;
    busy.set(key, action === "install" ? "installing" : action === "locate" ? "locating" : "checking");
    errors.delete(key);
    notices.delete(key);
    changed();
    let completed = false;
    try {
      let result;
      if (action === "install") result = await xsb.installCli(cli);
      else if (action === "check") result = await xsb.checkCli(cli);
      else if (await xsb.locateProgram(cli ?? backend.missing)) {
        if (cli) result = await xsb.checkCli(cli);
      } else return false;
      if (result?.state) results.set(key, result);
      const installed = backend.installed;
      state.backends = await xsb.backends();
      Object.assign(backend, state.backends.find((b) => b.name === backend.name));
      if (action === "install") notices.set(key, { text: t("backend.installed.note"), error: false });
      if (installed !== backend.installed || action === "locate") onChange(backend);
      completed = true;
    } catch (error) {
      errors.set(key, { action, message: error.message });
      // Installation can succeed while shell setup fails: still refresh the local inventory for recovery.
      try { state.backends = await xsb.backends(); onChange(state.backends.find((b) => b.name === backend.name) ?? backend); } catch { /* Keep the original failure. */ }
    } finally {
      busy.delete(key);
      changed();
    }
    return completed;
  };

  const reveal = async () => {
    if (config.getAttribute("aria-disabled") === "true") return;
    config.setAttribute("aria-disabled", "true");
    try {
      if (await xsb.revealCliConfig(cli)) notices.set(key, { text: t("backend.config.opened"), error: false });
    } catch (error) { notices.set(key, { text: error.message, error: true }); }
    finally { config.removeAttribute("aria-disabled"); changed(); }
  };

  const login = () => {
    let copying = false;
    const copy = button("backend.login.copy", async () => {
      if (copying) return;
      copying = true;
      copy.setAttribute("aria-busy", "true");
      try { await xsb.copyText(provider.login); copy.textContent = t("backend.login.copied"); }
      catch (error) { loginFailure.textContent = error.message; }
      finally { copying = false; copy.removeAttribute("aria-busy"); }
    });
    const loginFailure = h("p", { class: "error", role: "alert" });
    const dialog = openDialog(t("backend.login.title", { name }), [
      h("p", { class: "backend-login-intro" }, t("backend.login.intro")),
      h("ol", { class: "backend-login-steps" },
        h("li", {}, t("backend.login.step1")),
        h("li", {}, t("backend.login.step2"), h("div", { class: "backend-command" }, h("code", {}, provider.login), copy)),
        h("li", {}, t("backend.login.step3"))),
      h("p", { class: "hint" }, t("backend.login.provider")), loginFailure,
    ], [
      { label: t("backend.config"), run: async () => { await reveal(); return false; } },
      { label: t("common.close") },
      { label: t("backend.login.verify"), primary: true, run: async () => {
        if (busy.has(key)) return false;
        const verify = dialog.querySelector(".actions .primary");
        verify.setAttribute("aria-disabled", "true");
        verify.textContent = t("backend.checking");
        try {
          const completed = await work("check");
          if (completed && results.get(key)?.state === "ready") return true;
          loginFailure.textContent = t("backend.login.notReady");
          return false;
        }
        finally { verify.removeAttribute("aria-disabled"); verify.textContent = t("backend.login.verify"); }
      } },
    ]);
    dialog.classList.add("backend-login");
  };

  const primary = button("backend.check", () => {
    if (presentation.primary === "login") login();
    else if (presentation.primary) work(presentation.primary);
  }, { "data-backend-primary": "" });
  const config = button("backend.config", reveal, { class: "btn backend-config", title: t("backend.config.title") });
  const locate = button("backend.locate", () => work("locate"), { class: "btn backend-quiet" });
  const reinstall = button("backend.reinstall", () => work("install"), { class: "btn backend-quiet" });
  const menuId = `backend-options-${++sequence}`;
  const more = h("button", { class: "btn backend-more-trigger", type: "button", popovertarget: menuId,
    "aria-label": t("backend.more.label", { name }), style: `anchor-name: --${menuId}` }, t("backend.more"), h("span", { "aria-hidden": "true" }, "⋯"));
  const options = h("div", { class: "backend-options", popover: "auto", id: menuId, style: `position-anchor: --${menuId}` },
    h("small", {}, t(cli ? "backend.config.path" : "backend.command")), h("code", { class: "backend-path" }, backend.configPath ?? backend.command),
    locate, cli && reinstall,
    provider && h("a", { class: "backend-guide", href: provider.guide, target: "_blank", rel: "noopener" }, t("backend.guide", { name })));
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && options.matches(":popover-open")) {
      event.preventDefault(); event.stopPropagation();
      options.hidePopover(); more.focus();
    }
  });
  const actions = h("div", { class: "backend-actions" }, primary, cli && config, more);
  if (card) root.append(h("div", { class: "backend-card-head" },
    backendIcon(backend.name, "lg"),
    h("div", { class: "backend-identity" }, h("h2", {}, name), h("small", {}, provider?.vendor ?? t("backend.custom"))), status));
  else root.append(status);
  root.append(description, actions, notice, errorDetails, options);

  const paint = () => {
    Object.assign(backend, state.backends.find((b) => b.name === backend.name));
    const result = results.get(key);
    const error = errors.get(key);
    const pending = busy.get(key);
    presentation = backendPresentation(backend, result, error, pending);
    root.dataset.tone = presentation.tone;
    root.setAttribute("aria-busy", pending ? "true" : "false");
    badge.textContent = t(`backend.status.${presentation.state}`);
    badge.dataset.tone = presentation.tone;
    version.textContent = result?.version && backend.installed ? `v${result.version}` : "";
    description.textContent = error ? t(`backend.failure.${error.action}`) : t(`backend.detail.${presentation.state}`, { name });
    if (result?.issue && !pending && !error) description.textContent += t("sentence.gap") + t(`backend.issue.${result.issue}`);
    // xSB 中的这个智能体用的是火山方舟套餐，不是它自己的登录（ark.js）。
    if (backend.ark && !pending && !error && ["found", "ready", "unauthenticated", "unknown"].includes(presentation.state))
      description.textContent = t("backend.detail.viaArk", { name, model: arkModelLabel(backend.ark.model) });
    if (!cli && presentation.state === "found") description.textContent = t("backend.detail.custom");
    if (!cli && presentation.state === "missing") description.textContent = t("backend.detail.customMissing");
    if (!card) {
      const viaArk = backend.ark && ["found", "ready", "unauthenticated", "unknown"].includes(presentation.state);
      description.hidden = ["found", "ready"].includes(presentation.state) && !viaArk;
      if (!description.hidden) description.textContent = viaArk ? t("backend.compact.viaArk", { model: arkModelLabel(backend.ark.model) }) : t(`backend.compact.${presentation.state}`);
    }
    if (!cli && presentation.state === "found") badge.textContent = t("backend.status.custom");
    primary.hidden = !presentation.primary && !pending;
    primary.setAttribute("aria-disabled", pending ? "true" : "false");
    primary.className = `btn${presentation.emphasized ? " primary" : ""}${pending ? " backend-working" : ""}`;
    primary.textContent = presentation.label ? t(`backend.action.${presentation.label}`, { name }) : "";
    primary.setAttribute("aria-label", t("backend.action.label", { name, action: primary.textContent }));
    locate.disabled = !!pending;
    locate.hidden = !cli && !backend.missing;
    reinstall.disabled = !!pending;
    reinstall.hidden = !backend.installed;
    const message = notices.get(key);
    notice.hidden = !message;
    notice.textContent = message?.text ?? "";
    notice.dataset.error = message?.error ? "true" : "false";
    errorDetails.hidden = !error;
    errorText.textContent = error?.message ?? "";
  };
  const refresh = () => { if (root.isConnected) paint(); else listeners.delete(refresh); };
  listeners.add(refresh);
  paint();
  return root;
}
