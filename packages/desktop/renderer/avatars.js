import { AVATARS, DEFAULT_AVATAR, avatarSource, resolveAvatar } from "./avatar-catalog.js";
import { fill, h } from "./dom.js";
import { language, t } from "./i18n.js";

/** Name appears next to the image, so artwork is decorative to screen readers. */
export function avatarImage(agent, role) {
  return h("img", { class: "avatar", src: avatarSource(resolveAvatar(agent, role)), alt: "", draggable: "false",
    onerror: (event) => { const img = event.currentTarget; img.onerror = null; img.src = avatarSource(DEFAULT_AVATAR); } });
}

/** Local choices only. Empty means inherit and is intentionally saved as empty. */
export function avatarPicker(draft, role = () => undefined) {
  const picker = h("div", { class: "avatar-picker" });
  const paint = () => {
    const choice = (id, label) => h("button", {
      type: "button", class: "avatar-choice", title: label, "aria-label": label,
      "aria-pressed": String((draft.avatar ? resolveAvatar(draft) : "") === id),
      onclick: () => { draft.avatar = id; paint(); },
    }, avatarImage({ avatar: id }, id ? undefined : role()), id === "" && h("small", {}, label));
    fill(picker,
      h("div", { class: "avatar-default" }, choice("", t("avatar.auto"))),
      ...["people", "animals"].map((group) => h("div", { class: "avatar-group" },
        h("small", {}, t(`avatar.${group}`)),
        h("div", { class: "avatar-grid" }, ...AVATARS.filter((entry) => entry.group === group)
          .map((entry) => choice(entry.id, language === "zh-CN" ? entry.zh : entry.en))))));
  };
  paint();
  return picker;
}
