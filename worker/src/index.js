// 今天吃啥 · 群投票 API
// Cloudflare Worker + KV。数据模型：
//   p:<pollId>            投票本体（JSON），TTL 7 天
//   v:<pollId>:<voterId>  每个投票人一条记录（JSON + metadata），TTL 与投票同步
//   rl:<scope>:<ip>:<min> 轻量限流计数，TTL 60 秒
// 每个投票人写自己的 key，所以并发投票之间不会互相覆盖（避免写竞争）。
// 统计时用 list({prefix}) 读取 metadata 聚合，无需逐条 get。

export const LIMITS = {
  titleMax: 60,
  optionMax: 30,
  optionsMin: 2,
  optionsMax: 30,
  nameMax: 20,
  bodyMax: 8 * 1024,
  votersMax: 300,
  ttlSeconds: 7 * 24 * 3600,
  rateCreatePerMin: 10,
  rateVotePerMin: 30,
};

const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const POLL_ID_RE = /^[23456789a-zA-Z]{8,12}$/;
const VOTER_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export class HttpError extends Error {
  constructor(status, message, code = 'bad_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function randomId(len = 8) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

/** 去掉控制字符、零宽字符、双向文本控制符（防止昵称把界面文字"倒过来"），合并空白、去首尾空格 */
export function cleanText(v) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 按 Unicode 码点计算长度（中文、emoji 都算 1） */
export function textLen(s) {
  return [...s].length;
}

export function validatePollInput(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求格式不正确');
  const title = cleanText(body.title);
  if (!title) throw new HttpError(400, '标题不能为空');
  if (textLen(title) > LIMITS.titleMax) throw new HttpError(400, `标题最多 ${LIMITS.titleMax} 个字`);

  if (!Array.isArray(body.options)) throw new HttpError(400, '选项格式不正确');
  if (body.options.length > LIMITS.optionsMax * 2) throw new HttpError(400, `选项最多 ${LIMITS.optionsMax} 个`);
  const options = [];
  const seen = new Set();
  for (const raw of body.options) {
    const o = cleanText(raw);
    if (!o) continue;
    if (textLen(o) > LIMITS.optionMax) throw new HttpError(400, `每个选项最多 ${LIMITS.optionMax} 个字`);
    const k = o.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    options.push(o);
  }
  if (options.length < LIMITS.optionsMin) throw new HttpError(400, `至少需要 ${LIMITS.optionsMin} 个不同的选项`);
  if (options.length > LIMITS.optionsMax) throw new HttpError(400, `选项最多 ${LIMITS.optionsMax} 个`);

  const multi = body.multi === true;
  let deadline = null;
  if (body.deadline !== undefined && body.deadline !== null && body.deadline !== '') {
    const d = Number(body.deadline);
    if (!Number.isFinite(d)) throw new HttpError(400, '截止时间格式不正确');
    if (d < now + 30 * 1000) throw new HttpError(400, '截止时间必须晚于现在');
    if (d > now + LIMITS.ttlSeconds * 1000) throw new HttpError(400, '截止时间不能超过 7 天');
    deadline = Math.floor(d);
  }
  return { title, options, multi, deadline };
}

export function validateVoteInput(body, poll) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求格式不正确');
  const voterId = typeof body.voterId === 'string' ? body.voterId : '';
  if (!VOTER_ID_RE.test(voterId)) throw new HttpError(400, '投票人标识不正确');
  const name = cleanText(body.name);
  if (!name) throw new HttpError(400, '请填写昵称');
  if (textLen(name) > LIMITS.nameMax) throw new HttpError(400, `昵称最多 ${LIMITS.nameMax} 个字`);
  if (!Array.isArray(body.choices)) throw new HttpError(400, '请选择选项');
  const choices = [...new Set(body.choices)];
  if (choices.length === 0) throw new HttpError(400, '请至少选一个');
  for (const c of choices) {
    if (!Number.isInteger(c) || c < 0 || c >= poll.options.length) throw new HttpError(400, '选项不存在');
  }
  if (!poll.multi && choices.length > 1) throw new HttpError(400, '这个投票只能选一个');
  choices.sort((a, b) => a - b);
  return { voterId, name, choices };
}

function isClosed(poll, now) {
  return poll.deadline !== null && now >= poll.deadline;
}

function remainingTtl(poll, now) {
  // KV 的 expirationTtl 至少 60 秒
  return Math.max(60, Math.ceil((poll.expiresAt - now) / 1000));
}

async function loadPoll(env, id) {
  if (!POLL_ID_RE.test(id)) throw new HttpError(404, '投票不存在或已过期', 'not_found');
  const poll = await env.POLLS.get(`p:${id}`, { type: 'json' });
  if (!poll) throw new HttpError(404, '投票不存在或已过期', 'not_found');
  return poll;
}

function decodeName(n) {
  try {
    return decodeURIComponent(String(n ?? ''));
  } catch {
    return String(n ?? '');
  }
}

async function listVotes(env, pollId) {
  const votes = new Map();
  let cursor;
  // 最多翻几页，防止异常数据拖垮请求
  for (let page = 0; page < 5; page++) {
    const res = await env.POLLS.list({ prefix: `v:${pollId}:`, cursor, limit: 1000 });
    for (const k of res.keys) {
      if (!k.metadata) continue;
      const voterId = k.name.slice(`v:${pollId}:`.length);
      votes.set(voterId, { name: decodeName(k.metadata.n), choices: k.metadata.c || [], at: k.metadata.t || 0 });
    }
    if (res.list_complete || !res.cursor) break;
    cursor = res.cursor;
  }
  return votes;
}

export function aggregate(poll, votes) {
  const counts = poll.options.map(() => 0);
  const voters = poll.options.map(() => []);
  const sorted = [...votes.values()].sort((a, b) => a.at - b.at);
  for (const v of sorted) {
    for (const c of v.choices) {
      if (Number.isInteger(c) && c >= 0 && c < counts.length) {
        counts[c]++;
        voters[c].push(v.name);
      }
    }
  }
  return { counts, voters, totalVoters: sorted.length };
}

function publicPoll(poll, now) {
  return {
    id: poll.id,
    title: poll.title,
    options: poll.options,
    multi: poll.multi,
    deadline: poll.deadline,
    createdAt: poll.createdAt,
    expiresAt: poll.expiresAt,
    closed: isClosed(poll, now),
  };
}

async function rateLimit(env, scope, ip, limit, now) {
  const minute = Math.floor(now / 60000);
  const key = `rl:${scope}:${ip}:${minute}`;
  const current = Number((await env.POLLS.get(key)) || 0);
  if (current >= limit) throw new HttpError(429, '操作太频繁了，请稍后再试', 'rate_limited');
  // 非原子计数，只是"轻量"限流，足以挡住脚本刷票/刷创建
  await env.POLLS.put(key, String(current + 1), { expirationTtl: 120 });
}

async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > LIMITS.bodyMax) throw new HttpError(413, '内容太长了', 'too_large');
  const text = await request.text();
  if (text.length > LIMITS.bodyMax) throw new HttpError(413, '内容太长了', 'too_large');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求格式不正确');
  }
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
}

export async function createPoll(request, env, now = Date.now()) {
  await rateLimit(env, 'c', clientIp(request), LIMITS.rateCreatePerMin, now);
  const input = validatePollInput(await readJson(request), now);
  let id;
  for (let i = 0; i < 5; i++) {
    id = randomId(8);
    if (!(await env.POLLS.get(`p:${id}`))) break;
    id = null;
  }
  if (!id) throw new HttpError(500, '生成投票编号失败，请重试', 'server_error');
  const poll = {
    id,
    ...input,
    createdAt: now,
    expiresAt: now + LIMITS.ttlSeconds * 1000,
  };
  await env.POLLS.put(`p:${id}`, JSON.stringify(poll), { expirationTtl: LIMITS.ttlSeconds });
  return {
    status: 201,
    body: { poll: publicPoll(poll, now), results: aggregate(poll, new Map()), me: null, now },
  };
}

export async function getPoll(id, env, voterId, now = Date.now()) {
  const poll = await loadPoll(env, id);
  const votes = await listVotes(env, id);
  let me = null;
  if (voterId && VOTER_ID_RE.test(voterId)) {
    // 自己的票直接读 key，比 list 更快反映最新状态
    const mine = await env.POLLS.get(`v:${id}:${voterId}`, { type: 'json' });
    if (mine) {
      me = { name: mine.name, choices: mine.choices };
      votes.set(voterId, { name: mine.name, choices: mine.choices, at: mine.at });
    }
  }
  return { status: 200, body: { poll: publicPoll(poll, now), results: aggregate(poll, votes), me, now } };
}

export async function vote(request, id, env, now = Date.now()) {
  await rateLimit(env, 'v', clientIp(request), LIMITS.rateVotePerMin, now);
  const poll = await loadPoll(env, id);
  if (isClosed(poll, now)) throw new HttpError(403, '投票已截止', 'closed');
  const input = validateVoteInput(await readJson(request), poll);
  const votes = await listVotes(env, id);
  if (!votes.has(input.voterId) && votes.size >= LIMITS.votersMax) {
    throw new HttpError(403, `这个投票人数已满（${LIMITS.votersMax} 人）`, 'full');
  }
  const prev = votes.get(input.voterId);
  const record = { name: input.name, choices: input.choices, at: prev?.at || now, updatedAt: now };
  await env.POLLS.put(`v:${id}:${input.voterId}`, JSON.stringify(record), {
    expirationTtl: remainingTtl(poll, now),
    // metadata 只放 ASCII（昵称做 URI 编码），兼容各实现对非 ASCII 元数据的处理
    metadata: { n: encodeURIComponent(input.name), c: input.choices, t: record.at },
  });
  votes.set(input.voterId, record);
  return {
    status: 200,
    body: {
      poll: publicPoll(poll, now),
      results: aggregate(poll, votes),
      me: { name: input.name, choices: input.choices },
      now,
    },
  };
}

/** 允许跨域的来源列表。没配置时默认不允许任何跨域来源（只接受同源请求），"*" 表示任意来源。 */
export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

/** 请求来源是否被允许：没有 Origin 头（非浏览器/同源 GET）、同源、或在白名单里 */
export function originAllowed(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  if (origin === new URL(request.url).origin) return true;
  const allowed = allowedOrigins(env);
  return allowed.includes('*') || allowed.includes(origin);
}

function corsHeaders(request, env) {
  const allowed = allowedOrigins(env);
  const origin = request.headers.get('origin');
  let allow = '';
  if (allowed.includes('*')) allow = '*';
  else if (origin && allowed.includes(origin)) allow = origin;
  const h = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
  if (allow) h['access-control-allow-origin'] = allow;
  return h;
}

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extra,
    },
  });
}

export async function handleRequest(request, env, now = Date.now()) {
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  // 浏览器从不在白名单里的网站发来的请求直接拒绝（CORS 只能挡住"读结果"，挡不住"写"，这里补上）
  if (!originAllowed(request, env)) return json(403, { error: '不允许的来源', code: 'forbidden_origin' }, cors);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  try {
    if (path === '/api/health' && request.method === 'GET') {
      return json(200, { ok: true, now }, cors);
    }
    if (path === '/api/polls') {
      if (request.method !== 'POST') throw new HttpError(405, '不支持的请求方法', 'method_not_allowed');
      const r = await createPoll(request, env, now);
      return json(r.status, r.body, cors);
    }
    let m = path.match(/^\/api\/polls\/([^/]+)$/);
    if (m) {
      if (request.method !== 'GET') throw new HttpError(405, '不支持的请求方法', 'method_not_allowed');
      const r = await getPoll(m[1], env, url.searchParams.get('voter'), now);
      return json(r.status, r.body, cors);
    }
    m = path.match(/^\/api\/polls\/([^/]+)\/vote$/);
    if (m) {
      if (request.method !== 'POST') throw new HttpError(405, '不支持的请求方法', 'method_not_allowed');
      const r = await vote(request, m[1], env, now);
      return json(r.status, r.body, cors);
    }
    throw new HttpError(404, '接口不存在', 'not_found');
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message, code: err.code }, cors);
    console.error(err);
    return json(500, { error: '服务器开小差了，请稍后再试', code: 'server_error' }, cors);
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
