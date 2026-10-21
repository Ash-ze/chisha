import { describe, it, expect, beforeEach } from 'vitest';
import { handleRequest, LIMITS, cleanText, validatePollInput } from '../worker/src/index.js';
import { MockKV } from './mockKV.js';

let clock;
let env;
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

function req(method, path, body, headers = {}) {
  return new Request('http://localhost' + path, {
    method,
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': headers.ip || '1.1.1.1', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function call(method, path, body, headers) {
  const res = await handleRequest(req(method, path, body, headers), env, clock.now);
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

async function makePoll(extra = {}) {
  const r = await call('POST', '/api/polls', { title: '今晚吃啥', options: ['火锅', '烧烤', '日料'], ...extra });
  expect(r.status).toBe(201);
  return r.body.poll;
}

const V1 = 'voter_aaaaaaaaaaaaaaaa';
const V2 = 'voter_bbbbbbbbbbbbbbbb';

beforeEach(() => {
  clock = { now: T0 };
  env = { POLLS: new MockKV({ now: () => clock.now }), ALLOWED_ORIGINS: '*' };
});

describe('POST /api/polls', () => {
  it('创建投票并返回 id，KV 中写入 7 天 TTL', async () => {
    const poll = await makePoll();
    expect(poll.id).toMatch(/^[23456789a-zA-Z]{8}$/);
    expect(poll.options).toEqual(['火锅', '烧烤', '日料']);
    expect(poll.multi).toBe(false);
    expect(poll.deadline).toBeNull();
    expect(poll.expiresAt).toBe(T0 + 7 * 24 * 3600 * 1000);
    const put = env.POLLS.puts.find((p) => p.key === `p:${poll.id}`);
    expect(put.opts.expirationTtl).toBe(LIMITS.ttlSeconds);
  });

  it('清理空白、去重、忽略空选项', async () => {
    const poll = await makePoll({ title: '  吃\n啥  ', options: [' 火锅 ', '火锅', '', '  ', '烧烤'] });
    expect(poll.title).toBe('吃 啥');
    expect(poll.options).toEqual(['火锅', '烧烤']);
  });

  it('校验：标题、选项数量与长度、截止时间', async () => {
    const bad = [
      [{ title: '', options: ['a', 'b'] }, '标题'],
      [{ title: 'x'.repeat(61), options: ['a', 'b'] }, '标题'],
      [{ title: 'ok', options: ['a'] }, '至少'],
      [{ title: 'ok', options: ['a', 'a'] }, '至少'],
      [{ title: 'ok', options: 'a,b' }, '选项'],
      [{ title: 'ok', options: ['a', 'x'.repeat(31)] }, '选项'],
      [{ title: 'ok', options: Array.from({ length: 31 }, (_, i) => `o${i}`) }, '最多'],
      [{ title: 'ok', options: ['a', 'b'], deadline: T0 - 1000 }, '截止'],
      [{ title: 'ok', options: ['a', 'b'], deadline: T0 + 8 * 24 * 3600 * 1000 }, '7 天'],
      [{ title: 'ok', options: ['a', 'b'], deadline: 'tomorrow' }, '截止'],
    ];
    for (const [body, word] of bad) {
      const r = await call('POST', '/api/polls', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toContain(word);
    }
  });

  it('中文与 emoji 按字符计长度', async () => {
    const r = await call('POST', '/api/polls', { title: '吃'.repeat(60), options: ['🍜'.repeat(30), '饭'] });
    expect(r.status).toBe(201);
  });

  it('拒绝非 JSON 和超大请求体', async () => {
    expect((await call('POST', '/api/polls', '{bad json')).status).toBe(400);
    const big = { title: 'a', options: ['a', 'b'], pad: 'x'.repeat(LIMITS.bodyMax) };
    expect((await call('POST', '/api/polls', big)).status).toBe(413);
  });

  it('同一 IP 频繁创建会被限流（429），换 IP 或过一分钟恢复', async () => {
    for (let i = 0; i < LIMITS.rateCreatePerMin; i++) await makePoll();
    const r = await call('POST', '/api/polls', { title: 'x', options: ['a', 'b'] });
    expect(r.status).toBe(429);
    expect((await call('POST', '/api/polls', { title: 'x', options: ['a', 'b'] }, { ip: '2.2.2.2' })).status).toBe(201);
    clock.now += 61 * 1000;
    expect((await call('POST', '/api/polls', { title: 'x', options: ['a', 'b'] })).status).toBe(201);
  });
});

describe('GET /api/polls/:id', () => {
  it('返回投票和空结果', async () => {
    const poll = await makePoll();
    const r = await call('GET', `/api/polls/${poll.id}`);
    expect(r.status).toBe(200);
    expect(r.body.poll.title).toBe('今晚吃啥');
    expect(r.body.results).toEqual({ counts: [0, 0, 0], voters: [[], [], []], totalVoters: 0 });
    expect(r.body.me).toBeNull();
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('不存在 / 格式非法 / 已过期 返回 404', async () => {
    expect((await call('GET', '/api/polls/abcdefgh')).status).toBe(404);
    expect((await call('GET', '/api/polls/..%2f..')).status).toBe(404);
    const poll = await makePoll();
    clock.now += 7 * 24 * 3600 * 1000 + 1;
    expect((await call('GET', `/api/polls/${poll.id}`)).status).toBe(404);
  });
});

describe('POST /api/polls/:id/vote', () => {
  it('两人投票后结果正确聚合，且返回自己的选择', async () => {
    const poll = await makePoll();
    let r = await call('POST', `/api/polls/${poll.id}/vote`, { voterId: V1, name: '小明', choices: [0] });
    expect(r.status).toBe(200);
    expect(r.body.me).toEqual({ name: '小明', choices: [0] });
    r = await call('POST', `/api/polls/${poll.id}/vote`, { voterId: V2, name: '小红', choices: [0] }, { ip: '3.3.3.3' });
    expect(r.body.results.counts).toEqual([2, 0, 0]);
    expect(r.body.results.voters[0]).toEqual(['小明', '小红']);

    const g = await call('GET', `/api/polls/${poll.id}?voter=${V2}`);
    expect(g.body.results.totalVoters).toBe(2);
    expect(g.body.me).toEqual({ name: '小红', choices: [0] });
  });

  it('每个投票人独立的 KV key（避免写竞争），改票覆盖自己的记录', async () => {
    const poll = await makePoll();
    await call('POST', `/api/polls/${poll.id}/vote`, { voterId: V1, name: '小明', choices: [0] });
    await call('POST', `/api/polls/${poll.id}/vote`, { voterId: V2, name: '小红', choices: [1] });
    const keys = [...env.POLLS.store.keys()].filter((k) => k.startsWith('v:'));
    expect(keys.sort()).toEqual([`v:${poll.id}:${V1}`, `v:${poll.id}:${V2}`]);
    // 投票记录 TTL 不超过投票本身的剩余寿命
    const put = env.POLLS.puts.find((p) => p.key === `v:${poll.id}:${V1}`);
    expect(put.opts.expirationTtl).toBeLessThanOrEqual(LIMITS.ttlSeconds);
    expect(put.opts.metadata).toEqual({ n: encodeURIComponent('小明'), c: [0], t: T0 });
    expect(JSON.stringify(put.opts.metadata)).toMatch(/^[\x20-\x7e]*$/); // 纯 ASCII

    clock.now += 5000;
    const r = await call('POST', `/api/polls/${poll.id}/vote`, { voterId: V1, name: '小明明', choices: [2] });
    expect(r.body.results.counts).toEqual([0, 1, 1]);
    expect(r.body.results.totalVoters).toBe(2);
    expect(r.body.results.voters[2]).toEqual(['小明明']);
  });

  it('并发投票互不覆盖', async () => {
    const poll = await makePoll();
    const ids = Array.from({ length: 20 }, (_, i) => `voter_${String(i).padStart(16, '0')}`);
    await Promise.all(ids.map((voterId, i) => call('POST', `/api/polls/${poll.id}/vote`, { voterId, name: `人${i}`, choices: [i % 3] }, { ip: `9.9.9.${i}` })));
    const g = await call('GET', `/api/polls/${poll.id}`);
    expect(g.body.results.totalVoters).toBe(20);
    expect(g.body.results.counts).toEqual([7, 7, 6]);
  });

  it('单选投票不能多选；多选投票可以', async () => {
    const single = await makePoll();
    const r1 = await call('POST', `/api/polls/${single.id}/vote`, { voterId: V1, name: 'a', choices: [0, 1] });
    expect(r1.status).toBe(400);
    const multi = await makePoll({ multi: true });
    const r2 = await call('POST', `/api/polls/${multi.id}/vote`, { voterId: V1, name: 'a', choices: [2, 0, 0] });
    expect(r2.status).toBe(200);
    expect(r2.body.me.choices).toEqual([0, 2]);
    expect(r2.body.results.counts).toEqual([1, 0, 1]);
  });

  it('校验：昵称、voterId、选项下标', async () => {
    const poll = await makePoll();
    const cases = [
      { voterId: V1, name: '', choices: [0] },
      { voterId: V1, name: '名'.repeat(21), choices: [0] },
      { voterId: 'short', name: 'a', choices: [0] },
      { voterId: 'has spaces and <script>xx', name: 'a', choices: [0] },
      { voterId: V1, name: 'a', choices: [] },
      { voterId: V1, name: 'a', choices: [3] },
      { voterId: V1, name: 'a', choices: [-1] },
      { voterId: V1, name: 'a', choices: ['0'] },
      { voterId: V1, name: 'a', choices: [0.5] },
      { voterId: V1, name: 'a' },
    ];
    for (const c of cases) {
      const r = await call('POST', `/api/polls/${poll.id}/vote`, c);
      expect(r.status, JSON.stringify(c)).toBe(400);
    }
  });

  it('用户文本原样存储（不在服务端转义），由前端用 textContent 渲染', async () => {
    const poll = await makePoll({ title: '<img src=x onerror=alert(1)>', options: ['<b>a</b>', '"b"'] });
    expect(poll.title).toBe('<img src=x onerror=alert(1)>');
    const r = await call('POST', `/api/polls/${poll.id}/vote`, { voterId: V1, name: '<script>', choices: [0] });
    expect(r.body.results.voters[0]).toEqual(['<script>']);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('截止后不能投票，GET 显示 closed', async () => {
    const poll = await makePoll({ deadline: T0 + 10 * 60 * 1000 });
    expect(poll.closed).toBe(false);
    clock.now += 11 * 60 * 1000;
    const r = await call('POST', `/api/polls/${poll.id}/vote`, { voterId: V1, name: 'a', choices: [0] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('closed');
    const g = await call('GET', `/api/polls/${poll.id}`);
    expect(g.body.poll.closed).toBe(true);
  });

  it('投票刷太快会被限流', async () => {
    const poll = await makePoll();
    let last;
    for (let i = 0; i <= LIMITS.rateVotePerMin; i++) {
      last = await call('POST', `/api/polls/${poll.id}/vote`, { voterId: V1, name: 'a', choices: [i % 3] }, { ip: '5.5.5.5' });
    }
    expect(last.status).toBe(429);
  });

  it('不存在的投票返回 404', async () => {
    const r = await call('POST', '/api/polls/abcdefgh/vote', { voterId: V1, name: 'a', choices: [0] });
    expect(r.status).toBe(404);
  });
});

describe('路由与 CORS', () => {
  it('OPTIONS 预检返回 204 和 CORS 头', async () => {
    const res = await handleRequest(new Request('http://localhost/api/polls', { method: 'OPTIONS', headers: { origin: 'https://a.example' } }), env);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('ALLOWED_ORIGINS 白名单只回显匹配的来源', async () => {
    env.ALLOWED_ORIGINS = 'https://ok.example, https://ok2.example';
    const ok = await handleRequest(new Request('http://localhost/api/health', { headers: { origin: 'https://ok2.example' } }), env);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://ok2.example');
    const no = await handleRequest(new Request('http://localhost/api/health', { headers: { origin: 'https://evil.example' } }), env);
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('默认（未配置 ALLOWED_ORIGINS）不允许任何跨域来源，但同源和无 Origin 的请求正常', async () => {
    delete env.ALLOWED_ORIGINS;
    const pre = await handleRequest(new Request('http://localhost/api/polls', { method: 'OPTIONS', headers: { origin: 'https://a.example' } }), env);
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    const cross = await call('POST', '/api/polls', { title: 'x', options: ['a', 'b'] }, { origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
    expect(cross.body.code).toBe('forbidden_origin');
    expect([...env.POLLS.store.keys()].some((k) => k.startsWith('p:'))).toBe(false); // 没有写入
    const same = await call('POST', '/api/polls', { title: 'x', options: ['a', 'b'] }, { origin: 'http://localhost' });
    expect(same.status).toBe(201);
    expect((await call('GET', '/api/health')).status).toBe(200);
  });

  it('白名单之外的来源投票会被拒绝（403），不会写入', async () => {
    env.ALLOWED_ORIGINS = 'https://ok.example';
    const poll = await makePoll();
    const r = await call('POST', `/api/polls/${poll.id}/vote`, { voterId: V1, name: 'a', choices: [0] }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect([...env.POLLS.store.keys()].some((k) => k.startsWith('v:'))).toBe(false);
    const ok = await call('POST', `/api/polls/${poll.id}/vote`, { voterId: V1, name: 'a', choices: [0] }, { origin: 'https://ok.example' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://ok.example');
  });

  it('白名单条目末尾多写的斜杠会被忽略', async () => {
    env.ALLOWED_ORIGINS = 'https://ok.example/';
    const ok = await handleRequest(new Request('http://localhost/api/health', { headers: { origin: 'https://ok.example' } }), env);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://ok.example');
  });

  it('未知路径 404，错误方法 405，health 正常', async () => {
    expect((await call('GET', '/api/nope')).status).toBe(404);
    expect((await call('GET', '/api/polls')).status).toBe(405);
    expect((await call('DELETE', '/api/polls/abcdefgh')).status).toBe(405);
    expect((await call('GET', '/api/health')).body.ok).toBe(true);
  });
});

describe('工具函数', () => {
  it('cleanText 去掉控制字符、零宽字符和双向文本控制符', () => {
    expect(cleanText('a\u0000b\u200bc\n\nd')).toBe('a b c d');
    expect(cleanText('\u202e小明\u202c')).toBe('小明');
    expect(cleanText('a\u2066b\u2069')).toBe('a b');
    expect(cleanText(123)).toBe('');
  });
  it('validatePollInput 拒绝数组 / null', () => {
    expect(() => validatePollInput(null)).toThrow();
    expect(() => validatePollInput([])).toThrow();
  });
});
