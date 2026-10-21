import { describe, it, expect } from 'vitest';
import {
  LINK_LIMITS, newLinkPoll, encodeLinkPoll, decodeLinkPoll, castLinkVote, mergeLinkPolls,
  tallyLinkPoll, findLinkPayloads, cleanText,
} from '../src/linkPoll.js';

const base = () => newLinkPoll({ title: '今晚吃啥？', options: ['火锅', '烧烤', '日料'] }, 'Abc23456');

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

describe('链接投票：创建与编码', () => {
  it('编码后能原样解码（含中文、emoji）', () => {
    const p = newLinkPoll({ title: '🍜 今晚吃啥', options: ['火锅', '烧烤', '日料'], multi: true }, 'Abc23456');
    const payload = encodeLinkPoll(p);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeLinkPoll(payload)).toEqual(p);
  });

  it('清理空白、去重、校验数量和长度', () => {
    const p = newLinkPoll({ title: '  吃\n啥 ', options: [' 火锅 ', '火锅', '', '烧烤'] });
    expect(p.title).toBe('吃 啥');
    expect(p.options).toEqual(['火锅', '烧烤']);
    expect(p.id).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(() => newLinkPoll({ title: '', options: ['a', 'b'] })).toThrow('标题');
    expect(() => newLinkPoll({ title: 'x', options: ['a'] })).toThrow('至少');
    expect(() => newLinkPoll({ title: 'x', options: ['a', 'x'.repeat(LINK_LIMITS.option + 1)] })).toThrow('选项');
    expect(() => newLinkPoll({ title: 'x', options: Array.from({ length: 21 }, (_, i) => `o${i}`) })).toThrow('最多');
  });

  it('20 个选项、40 个人时链接长度仍在可接受范围', () => {
    let p = newLinkPoll({ title: '公司楼下吃什么好呢', options: Array.from({ length: 20 }, (_, i) => `第${i}家面馆`) }, 'Abc23456');
    for (let i = 0; i < LINK_LIMITS.voters; i++) p = castLinkVote(p, `同事${i}号`, [i % 20], 1700000000 + i);
    const payload = encodeLinkPoll(p);
    expect(payload.length).toBeLessThan(LINK_LIMITS.payloadMax);
    expect(decodeLinkPoll(payload).votes).toHaveLength(LINK_LIMITS.voters);
  });
});

describe('链接投票：解码时不信任链接内容', () => {
  it('乱码、截断、非 base64 返回 null', () => {
    const payload = encodeLinkPoll(castLinkVote(base(), '小明', [0], 1));
    expect(decodeLinkPoll(payload.slice(0, payload.length - 5))).toBeNull();
    expect(decodeLinkPoll('not base64!!')).toBeNull();
    expect(decodeLinkPoll('')).toBeNull();
    expect(decodeLinkPoll(null)).toBeNull();
    expect(decodeLinkPoll('x'.repeat(LINK_LIMITS.payloadMax + 1))).toBeNull();
    expect(decodeLinkPoll(b64url([1, 2, 3]))).toBeNull();
    expect(decodeLinkPoll(b64url({ v: 2, i: 'Abc23456', t: 'x', o: ['a', 'b'] }))).toBeNull();
    expect(decodeLinkPoll(b64url({ v: 1, i: '../../x', t: 'x', o: ['a', 'b'] }))).toBeNull();
  });

  it('选项被篡改成重复项（下标会错位）时整个拒绝', () => {
    expect(decodeLinkPoll(b64url({ v: 1, i: 'Abc23456', t: 'x', o: ['a', 'a', 'b'] }))).toBeNull();
  });

  it('丢弃不合法的票：下标越界、单选投多个、昵称过长、非整数', () => {
    const p = decodeLinkPoll(b64url({
      v: 1, i: 'Abc23456', t: 'x', o: ['a', 'b'],
      b: [['ok', 1, 5], ['越界', 2, 5], ['多选', [0, 1], 5], ['名'.repeat(13), 0, 5], ['小数', 0.5, 5], ['串', '0', 5], 'junk', [123, 0, 5]],
    }));
    expect(p.votes).toEqual([{ name: 'ok', choices: [1], at: 5 }]);
  });

  it('昵称中的控制字符、双向文本控制符被清理；文本保持原样（由前端 textContent 渲染）', () => {
    const p = decodeLinkPoll(b64url({ v: 1, i: 'Abc23456', t: '<img src=x onerror=alert(1)>', o: ['<b>a</b>', 'b'], b: [['‮小红‬', 0, 1]] }));
    expect(p.title).toBe('<img src=x onerror=alert(1)>');
    expect(p.votes[0].name).toBe('小红');
    expect(cleanText('a\u0000b')).toBe('a b');
  });

  it('同一昵称出现多次只保留时间最新的一票', () => {
    const p = decodeLinkPoll(b64url({ v: 1, i: 'Abc23456', t: 'x', o: ['a', 'b'], b: [['小明', 0, 5], ['小明', 1, 9], ['小明', 0, 7]] }));
    expect(p.votes).toEqual([{ name: '小明', choices: [1], at: 9 }]);
  });
});

describe('链接投票：投票、合并、统计', () => {
  it('投票与改票（同一昵称覆盖，不区分大小写）', () => {
    let p = castLinkVote(base(), '小明', [0], 1);
    p = castLinkVote(p, 'Amy', [1], 2);
    p = castLinkVote(p, 'amy', [2], 3);
    expect(p.votes.map((v) => [v.name, v.choices])).toEqual([['小明', [0]], ['amy', [2]]]);
    expect(tallyLinkPoll(p)).toEqual({ counts: [1, 0, 1], voters: [['小明'], [], ['amy']], totalVoters: 2 });
  });

  it('不修改原对象', () => {
    const p0 = base();
    castLinkVote(p0, '小明', [0], 1);
    expect(p0.votes).toEqual([]);
  });

  it('单选只取一个；多选去重排序；校验昵称和选项', () => {
    const multi = newLinkPoll({ title: 'x', options: ['a', 'b', 'c'], multi: true }, 'Abc23456');
    expect(castLinkVote(multi, 'a', [2, 0, 0], 1).votes[0].choices).toEqual([0, 2]);
    expect(() => castLinkVote(base(), '', [0])).toThrow('昵称');
    expect(() => castLinkVote(base(), '名'.repeat(13), [0])).toThrow('昵称');
    expect(() => castLinkVote(base(), 'a', [])).toThrow('至少');
    expect(() => castLinkVote(base(), 'a', [5])).toThrow();
  });

  it('人数上限', () => {
    let p = base();
    for (let i = 0; i < LINK_LIMITS.voters; i++) p = castLinkVote(p, `p${i}`, [0], i + 1);
    expect(() => castLinkVote(p, '新来的', [0])).toThrow('最多');
    expect(castLinkVote(p, 'p0', [1], 999).votes).toHaveLength(LINK_LIMITS.voters); // 老人改票可以
  });

  it('接力：每个人在上一条链接的基础上投，最后一条链接包含所有人的票', () => {
    let payload = encodeLinkPoll(base());
    for (const [name, c] of [['小明', 0], ['小红', 1], ['小刚', 0]]) {
      payload = encodeLinkPoll(castLinkVote(decodeLinkPoll(payload), name, [c]));
    }
    expect(tallyLinkPoll(decodeLinkPoll(payload)).counts).toEqual([2, 1, 0]);
  });

  it('两人同时从同一条链接投票，合并后两票都在；同一人保留较新的票', () => {
    const p0 = castLinkVote(base(), '小明', [0], 10);
    const a = castLinkVote(p0, '小红', [1], 20);
    const b = castLinkVote(castLinkVote(p0, '小刚', [2], 21), '小明', [2], 30);
    const { poll, added } = mergeLinkPolls(a, b);
    expect(added).toBe(2);
    expect(poll.votes.map((v) => `${v.name}:${v.choices}`)).toEqual(['小红:1', '小刚:2', '小明:2']);
    // 反方向合并结果一样
    expect(tallyLinkPoll(mergeLinkPolls(b, a).poll)).toEqual(tallyLinkPoll(poll));
    // 重复合并没有变化
    expect(mergeLinkPolls(poll, a).added).toBe(0);
  });

  it('不是同一个投票不合并', () => {
    const a = castLinkVote(base(), '小明', [0], 1);
    const other = castLinkVote(newLinkPoll({ title: 'x', options: ['火锅', '烧烤', '日料'] }, 'Zzz23456'), '小红', [1], 2);
    expect(mergeLinkPolls(a, other)).toEqual({ poll: a, added: 0 });
    const sameIdDiffOptions = castLinkVote(newLinkPoll({ title: 'x', options: ['火锅', '烧烤'] }, 'Abc23456'), '小红', [1], 2);
    expect(mergeLinkPolls(a, sameIdDiffOptions).added).toBe(0);
  });

  it('从粘贴的群消息里找出所有链接', () => {
    const p1 = encodeLinkPoll(castLinkVote(base(), '小明', [0], 1));
    const p2 = encodeLinkPoll(castLinkVote(base(), '小红', [1], 2));
    const text = `【今天吃啥·链接投票】今晚吃啥？\n小明 投了「火锅」👉 https://example.github.io/chisha/#/l/${p1}\n\n小红：https://example.github.io/chisha/#/l/${p2} 收到\n别的链接 https://x.example/#/p/abc`;
    expect(findLinkPayloads(text)).toEqual([p1, p2]);
    expect(findLinkPayloads('')).toEqual([]);
  });
});
