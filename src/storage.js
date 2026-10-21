// localStorage 封装：读写失败（隐私模式、配额满）时静默降级
const PREFIX = 'chisha.';

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function randomToken(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 本机的匿名投票人标识（不是账号，清缓存就换一个） */
export function getVoterId() {
  let id = load('voterId', null);
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    id = randomToken(16);
    save('voterId', id);
  }
  return id;
}

export function newListId() {
  return 'c_' + randomToken(6);
}

// ---- 自定义转盘 ----
export const LIST_MAX_OPTIONS = 60;
export const LIST_OPTION_MAX_LEN = 20;
export const LIST_NAME_MAX_LEN = 12;

export function getCustomLists() {
  const v = load('lists.v1', []);
  if (!Array.isArray(v)) return [];
  return v.filter((l) => l && typeof l.id === 'string' && typeof l.name === 'string' && Array.isArray(l.options));
}

export function saveCustomLists(lists) {
  return save('lists.v1', lists);
}

/** 把多行文本解析成选项数组：去空行、去重、截断 */
export function parseOptions(text, maxLen = LIST_OPTION_MAX_LEN, maxCount = LIST_MAX_OPTIONS) {
  const seen = new Set();
  const out = [];
  for (const line of String(text).split(/[\n,，、]/)) {
    const o = [...line.replace(/\s+/g, ' ').trim()].slice(0, maxLen).join('');
    if (!o || seen.has(o)) continue;
    seen.add(o);
    out.push(o);
    if (out.length >= maxCount) break;
  }
  return out;
}

// ---- 排除（"这个昨天吃过"）----
export function getExcluded(setId) {
  const all = load('excluded.v1', {});
  return Array.isArray(all?.[setId]) ? all[setId] : [];
}

export function setExcluded(setId, list) {
  const all = load('excluded.v1', {}) || {};
  if (list.length) all[setId] = list;
  else delete all[setId];
  save('excluded.v1', all);
}

// ---- 喜欢的选项（权重 ×2）----
export function getFavorites(setId) {
  const all = load('favorites.v1', {});
  return Array.isArray(all?.[setId]) ? all[setId].filter((x) => typeof x === 'string') : [];
}

export function setFavorites(setId, list) {
  const all = load('favorites.v1', {}) || {};
  if (list.length) all[setId] = list;
  else delete all[setId];
  save('favorites.v1', all);
}

// ---- 最近 10 次转盘结果 ----
export const HISTORY_MAX = 10;

/** 纯函数：把一条结果放到最前面，只保留最近 max 条 */
export function addHistory(list, entry, max = HISTORY_MAX) {
  return [entry, ...(Array.isArray(list) ? list : [])].slice(0, max);
}

export function getHistory() {
  const v = load('history.v1', []);
  return Array.isArray(v) ? v.filter((e) => e && typeof e.o === 'string' && typeof e.t === 'number').slice(0, HISTORY_MAX) : [];
}

export function pushHistory(entry) {
  const list = addHistory(getHistory(), entry);
  save('history.v1', list);
  return list;
}

export function clearHistory() {
  save('history.v1', []);
}

// ---- 链接投票：本机记住每个投票见过的最新结果，打开别人的链接时自动合并 ----
export function getLinkPollCache() {
  const v = load('linkPolls.v1', {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

export function saveLinkPollCache(id, payload) {
  const all = getLinkPollCache();
  delete all[id];
  all[id] = { p: payload, at: Date.now() };
  // 只留最近 10 个
  const keep = Object.entries(all).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0)).slice(0, 10);
  save('linkPolls.v1', Object.fromEntries(keep));
}

// ---- 最近的投票 ----
export function getRecentPolls() {
  const v = load('recentPolls.v1', []);
  return Array.isArray(v) ? v : [];
}

export function rememberPoll(poll, role) {
  const list = getRecentPolls().filter((p) => p.id !== poll.id);
  const old = getRecentPolls().find((p) => p.id === poll.id);
  list.unshift({
    id: poll.id,
    title: poll.title,
    role: old?.role === 'created' ? 'created' : role,
    expiresAt: poll.expiresAt,
    at: Date.now(),
  });
  save('recentPolls.v1', list.filter((p) => !p.expiresAt || p.expiresAt > Date.now()).slice(0, 20));
}
