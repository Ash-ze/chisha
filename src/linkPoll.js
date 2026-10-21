// 链接投票：不需要任何服务器。
// 投票题目和每个人的选择都编码在链接的 # 后面（#/l/<payload>），payload = base64url(UTF-8 JSON)。
// 每个人投完会得到一条带新链接的回复，发回群里；新链接里包含他看到的所有票，所以群里"最新的那条链接"就是最新结果。
// 两个人同时投、各自发了链接也没关系：打开任何一条链接都会和本机记住的结果自动合并，也可以把多条链接一起粘贴进来合并。
// 这里全是纯函数（不依赖 DOM），便于单元测试。

export const LINK_LIMITS = { title: 40, option: 20, optionsMin: 2, optionsMax: 20, name: 12, voters: 40, payloadMax: 8000 };
export const LINK_ID_RE = /^[A-Za-z0-9]{6,10}$/;
const PAYLOAD_RE = /#\/l\/([A-Za-z0-9_-]{8,8000})/g;

/** 去掉控制字符、零宽字符、双向文本控制符，合并空白 */
export function cleanText(v) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
}

const len = (s) => [...s].length;

/** 投票人按昵称区分（不区分大小写） */
export function nameKey(name) {
  return cleanText(name).toLowerCase();
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function randomLinkId(len = 8) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return [...a].map((b) => abc[b % abc.length]).join('');
}

/** 校验并整理发起人填写的内容；不合法时抛出带中文提示的 Error */
export function newLinkPoll({ title, options, multi = false }, id = randomLinkId()) {
  const t = cleanText(title);
  if (!t) throw new Error('先写个标题吧');
  if (len(t) > LINK_LIMITS.title) throw new Error(`标题最多 ${LINK_LIMITS.title} 个字`);
  const opts = [];
  const seen = new Set();
  for (const raw of Array.isArray(options) ? options : []) {
    const o = cleanText(raw);
    if (!o) continue;
    if (len(o) > LINK_LIMITS.option) throw new Error(`每个选项最多 ${LINK_LIMITS.option} 个字`);
    const k = o.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    opts.push(o);
  }
  if (opts.length < LINK_LIMITS.optionsMin) throw new Error('至少需要 2 个不同的选项');
  if (opts.length > LINK_LIMITS.optionsMax) throw new Error(`链接投票最多 ${LINK_LIMITS.optionsMax} 个选项`);
  return { id, title: t, options: opts, multi: !!multi, votes: [] };
}

export function encodeLinkPoll(poll) {
  const obj = { v: 1, i: poll.id, t: poll.title, o: poll.options };
  if (poll.multi) obj.m = 1;
  if (poll.votes.length) obj.b = poll.votes.map((v) => [v.name, poll.multi ? v.choices : v.choices[0], v.at]);
  return b64urlEncode(JSON.stringify(obj));
}

function cleanChoices(raw, poll) {
  const arr = Array.isArray(raw) ? raw : [raw];
  if (!arr.length || !arr.every((c) => Number.isInteger(c) && c >= 0 && c < poll.options.length)) return null;
  const set = [...new Set(arr)];
  if (!poll.multi && set.length !== 1) return null;
  return set.sort((a, b) => a - b);
}

/** 解析链接里的 payload；格式不对返回 null。所有字段都重新校验，不信任链接内容。 */
export function decodeLinkPoll(payload) {
  if (typeof payload !== 'string' || payload.length < 8 || payload.length > LINK_LIMITS.payloadMax) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  let obj;
  try {
    obj = JSON.parse(b64urlDecode(payload));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || obj.v !== 1 || typeof obj.i !== 'string' || !LINK_ID_RE.test(obj.i)) return null;
  let poll;
  try {
    poll = newLinkPoll({ title: obj.t, options: obj.o, multi: obj.m === 1 }, obj.i);
  } catch {
    return null;
  }
  // 选项去重/清理后数量变了，说明内容被改过，下标对不上，整个拒绝
  if (!Array.isArray(obj.o) || poll.options.length !== obj.o.length) return null;
  const byName = new Map();
  for (const row of Array.isArray(obj.b) ? obj.b : []) {
    if (!Array.isArray(row)) continue;
    const name = cleanText(row[0]);
    if (!name || len(name) > LINK_LIMITS.name) continue;
    const choices = cleanChoices(row[1], poll);
    if (!choices) continue;
    const at = Number.isInteger(row[2]) && row[2] > 0 ? row[2] : 0;
    const k = nameKey(name);
    const prev = byName.get(k);
    if (!prev || at >= prev.at) byName.set(k, { name, choices, at });
    if (byName.size >= LINK_LIMITS.voters) break;
  }
  poll.votes = sortVotes([...byName.values()]);
  return poll;
}

function sortVotes(votes) {
  return votes.slice().sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 投票 / 改票（同一昵称覆盖）。返回新的 poll，不修改原对象。 */
export function castLinkVote(poll, name, choices, at = Math.floor(Date.now() / 1000)) {
  const n = cleanText(name);
  if (!n) throw new Error('先填个昵称吧');
  if (len(n) > LINK_LIMITS.name) throw new Error(`昵称最多 ${LINK_LIMITS.name} 个字`);
  const c = cleanChoices(poll.multi ? choices : choices.slice(0, 1), poll);
  if (!choices.length || !c) throw new Error('请至少选一个');
  const k = nameKey(n);
  const others = poll.votes.filter((v) => nameKey(v.name) !== k);
  if (others.length === poll.votes.length && others.length >= LINK_LIMITS.voters) {
    throw new Error(`链接投票最多 ${LINK_LIMITS.voters} 人，人多请用实时群投票`);
  }
  return { ...poll, votes: sortVotes([...others, { name: n, choices: c, at }]) };
}

/** 是否同一个投票（编号、选项、单/多选都一致） */
export function sameLinkPoll(a, b) {
  return !!a && !!b && a.id === b.id && a.multi === b.multi && a.options.length === b.options.length
    && a.options.every((o, i) => o === b.options[i]);
}

/**
 * 合并两份结果：按昵称合并，同一个人保留时间更晚的那一票。
 * 不是同一个投票时原样返回 a。返回 { poll, added }，added = 新增或更新的票数。
 */
export function mergeLinkPolls(a, b) {
  if (!sameLinkPoll(a, b)) return { poll: a, added: 0 };
  const map = new Map(a.votes.map((v) => [nameKey(v.name), v]));
  let added = 0;
  for (const v of b.votes) {
    const k = nameKey(v.name);
    const prev = map.get(k);
    if (!prev) {
      if (map.size >= LINK_LIMITS.voters) continue;
      map.set(k, v);
      added++;
    } else if (v.at > prev.at) {
      map.set(k, v);
      added++;
    }
  }
  return { poll: added ? { ...a, votes: sortVotes([...map.values()]) } : a, added };
}

/** 统计：每个选项的票数和投票人 */
export function tallyLinkPoll(poll) {
  const counts = poll.options.map(() => 0);
  const voters = poll.options.map(() => []);
  for (const v of poll.votes) {
    for (const c of v.choices) {
      counts[c]++;
      voters[c].push(v.name);
    }
  }
  return { counts, voters, totalVoters: poll.votes.length };
}

/** 从一段文字（比如从群里复制的几条消息）里找出所有链接投票的 payload */
export function findLinkPayloads(text) {
  return [...String(text || '').matchAll(PAYLOAD_RE)].map((m) => m[1]);
}
