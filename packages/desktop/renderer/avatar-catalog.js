// Static, bundled artwork. IDs are persisted; URLs and model calls are never accepted here.
export const AVATARS = [
  ["person-larry-page", "拉里·佩奇", "Larry Page", "people"],
  ["person-jensen-huang", "黄仁勋", "Jensen Huang", "people"],
  ["person-huang-le", "黄乐", "Alice Huang", "people"],
  ["person-bill-gates", "比尔·盖茨", "Bill Gates", "people"],
  ["person-pony-ma", "马化腾", "Pony Ma", "people"],
  ["person-jack-ma", "马云", "Jack Ma", "people"],
  ["person-robin-li", "李彦宏", "Robin Li", "people"],
  ["person-steve-jobs", "乔布斯", "Steve Jobs", "people"],
  ["person-tim-cook", "蒂姆·库克", "Tim Cook", "people"],
  ["person-mark-zuckerberg", "扎克伯格", "Mark Zuckerberg", "people"],
  ["person-jeff-bezos", "贝索斯", "Jeff Bezos", "people"],
  ["person-sam-altman", "山姆·奥特曼", "Sam Altman", "people"],
  ["person-lei-jun", "雷军", "Lei Jun", "people"],
  ["person-dario-amodei", "达里奥·阿莫代伊", "Dario Amodei", "people"],
  ["person-wang-xing", "王兴", "Wang Xing", "people"],
  ["person-satya-nadella", "萨提亚·纳德拉", "Satya Nadella", "people"],
  ["animal-owl", "猫头鹰", "Owl", "animals"],
  ["animal-fox", "狐狸", "Fox", "animals"],
  ["animal-cat", "猫", "Cat", "animals"],
  ["animal-otter", "水獭", "Otter", "animals"],
  ["animal-rabbit", "兔子", "Rabbit", "animals"],
  ["animal-bear", "熊", "Bear", "animals"],
  ["animal-shiba", "柴犬", "Shiba", "animals"],
  ["animal-raccoon", "浣熊", "Raccoon", "animals"],
  ["animal-deer", "鹿", "Deer", "animals"],
  ["animal-koala", "考拉", "Koala", "animals"],
  ["animal-penguin", "企鹅", "Penguin", "animals"],
  ["animal-tiger", "老虎", "Tiger", "animals"],
].map(([id, zh, en, group]) => ({ id, zh, en, group }));

// Compatibility for previously saved role-based IDs. The picker only offers named people.
export const LEGACY_AVATARS = {
  "person-director": "person-larry-page",
  "person-screenwriter": "person-jack-ma",
  "person-art-director": "person-huang-le",
  "person-storyboard-artist": "person-dario-amodei",
  "person-cinematographer": "person-jensen-huang",
  "person-editor": "person-tim-cook",
  "person-tech-lead": "person-steve-jobs",
  "person-product-manager": "person-pony-ma",
  "person-architect": "person-bill-gates",
  "person-developer": "person-robin-li",
  "person-reviewer": "person-sam-altman",
  "person-qa": "person-satya-nadella"
};
export const DEFAULT_AVATAR = "animal-owl";
const known = new Set(AVATARS.map((entry) => entry.id));
const canonical = (id) => known.has(id) ? id : Object.hasOwn(LEGACY_AVATARS, id) ? LEGACY_AVATARS[id] : undefined;
/** Older workspaces and old role IDs resolve to current bundled artwork. */
export const resolveAvatar = (agent = {}, role = {}) =>
  canonical(agent?.avatar) ?? canonical(role?.avatar) ?? DEFAULT_AVATAR;
export const avatarSource = (id) => `./avatars/${canonical(id) ?? DEFAULT_AVATAR}.png`;
