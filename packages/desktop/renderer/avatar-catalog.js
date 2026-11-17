// Static, bundled artwork. IDs are persisted; URLs and model calls are never accepted here.
export const AVATARS = [
  ["person-director", "导演", "Director", "people"],
  ["person-screenwriter", "编剧", "Screenwriter", "people"],
  ["person-art-director", "美术指导", "Art Director", "people"],
  ["person-storyboard-artist", "分镜师", "Storyboard Artist", "people"],
  ["person-cinematographer", "摄影师", "Cinematographer", "people"],
  ["person-editor", "剪辑师", "Editor", "people"],
  ["person-tech-lead", "技术负责人", "Tech Lead", "people"],
  ["person-product-manager", "产品经理", "Product Manager", "people"],
  ["person-architect", "架构师", "Architect", "people"],
  ["person-developer", "开发者", "Developer", "people"],
  ["person-reviewer", "审查者", "Reviewer", "people"],
  ["person-qa", "测试工程师", "QA Engineer", "people"],
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

export const DEFAULT_AVATAR = "animal-owl";
const known = new Set(AVATARS.map((entry) => entry.id));
/** Older workspaces have no avatar; unknown IDs also safely fall back to bundled artwork. */
export const resolveAvatar = (agent = {}, role = {}) =>
  known.has(agent?.avatar) ? agent.avatar : known.has(role?.avatar) ? role.avatar : DEFAULT_AVATAR;
export const avatarSource = (id) => `./avatars/${known.has(id) ? id : DEFAULT_AVATAR}.png`;
