import { describe, it, expect } from 'vitest';
import {
  TAU, mod, segments, pickWeighted, indexAtRotation, targetRotation, spin, weightsFor, eliminationStep, normWeights,
} from '../src/pick.js';
import { needsFlip, fitLabel } from '../src/labels.js';
import { addHistory, HISTORY_MAX } from '../src/storage.js';
import { BUILTIN_SETS, resultLabel } from '../src/data.js';
import { resolveApiBase } from '../src/config.js';

function seeded(seed = 42) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('权重', () => {
  it('segments 按权重分配扇区，总和为一整圈', () => {
    const { starts, sizes } = segments([1, 2, 1]);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(TAU);
    expect(sizes[1]).toBeCloseTo(sizes[0] * 2);
    expect(starts).toEqual([0, sizes[0], sizes[0] + sizes[1]]);
  });

  it('非法权重按 1 处理', () => {
    expect(normWeights([2, 0, -1, NaN, 'x'])).toEqual([2, 1, 1, 1, 1]);
    expect(normWeights(3)).toEqual([1, 1, 1]);
  });

  it('weightsFor：喜欢的 ×2', () => {
    expect(weightsFor(['a', 'b', 'c'], ['b', 'zzz'])).toEqual([1, 2, 1]);
  });

  it('pickWeighted 的分布与权重成正比', () => {
    const rand = seeded(3);
    const w = [1, 2, 1, 4];
    const counts = [0, 0, 0, 0];
    const N = 80000;
    for (let i = 0; i < N; i++) counts[pickWeighted(w, rand)]++;
    w.forEach((x, i) => expect(Math.abs(counts[i] / N - x / 8)).toBeLessThan(0.01));
    expect(pickWeighted([1, 1], () => 0.999999)).toBe(1);
  });

  it('等权重时 indexAtRotation 与按个数计算一致', () => {
    const rand = seeded(5);
    for (let k = 0; k < 500; k++) {
      const n = 2 + Math.floor(rand() * 30);
      const rot = rand() * 40 - 20;
      expect(indexAtRotation(rot, Array(n).fill(1))).toBe(indexAtRotation(rot, n));
    }
  });

  it('带权重时 targetRotation 一定停在目标扇区内部（避开分界线）', () => {
    const rand = seeded(11);
    for (let t = 0; t < 200; t++) {
      const n = 2 + Math.floor(rand() * 25);
      const w = Array.from({ length: n }, () => (rand() < 0.3 ? 2 : 1));
      const { starts, sizes } = segments(w);
      let cur = rand() * 50;
      const index = Math.floor(rand() * n);
      const target = targetRotation(cur, index, w, { rand });
      expect(indexAtRotation(target, w)).toBe(index);
      const within = (mod(-target, TAU) - starts[index]) / sizes[index];
      expect(within).toBeGreaterThan(0.1);
      expect(within).toBeLessThan(0.9);
      cur = target;
    }
  });

  it('spin 带权重：结果与停下的扇区一致；淘汰模式可以转得更少圈', () => {
    const rand = seeded(8);
    const opts = ['火锅', '烧烤', '面条', '饺子'];
    const weights = [1, 2, 1, 2];
    let rot = 0;
    for (let i = 0; i < 200; i++) {
      const r = spin(opts, rot, rand, { weights, minSpins: 3, maxSpins: 4 });
      expect(opts[indexAtRotation(r.target, weights)]).toBe(r.option);
      expect(r.target - rot).toBeGreaterThanOrEqual(3 * TAU);
      expect(r.target - rot).toBeLessThan(5 * TAU);
      rot = r.target % TAU;
    }
  });
});

describe('淘汰模式', () => {
  it('每次去掉转到的那个，剩一个时给出 winner', () => {
    let s = eliminationStep(['a', 'b', 'c'], 'b');
    expect(s).toEqual({ remaining: ['a', 'c'], winner: null });
    s = eliminationStep(s.remaining, 'a');
    expect(s).toEqual({ remaining: ['c'], winner: 'c' });
  });

  it('模拟完整一轮：n 个选项转 n-1 次一定决出唯一胜者', () => {
    const rand = seeded(21);
    let remaining = Array.from({ length: 12 }, (_, i) => `菜${i}`);
    let winner = null;
    let spins = 0;
    while (!winner) {
      const r = spin(remaining, 0, rand);
      ({ remaining, winner } = eliminationStep(remaining, r.option));
      spins++;
    }
    expect(spins).toBe(11);
    expect(remaining).toEqual([winner]);
  });
});

describe('转盘文字', () => {
  const top = -Math.PI / 2;
  it('屏幕左半边的文字需要翻转，右半边不用', () => {
    expect(needsFlip(0)).toBe(false); // 右
    expect(needsFlip(Math.PI)).toBe(true); // 左
    expect(needsFlip(Math.PI * 0.75)).toBe(true); // 左下
    expect(needsFlip(-Math.PI * 0.75)).toBe(true); // 左上
    expect(needsFlip(Math.PI * 0.25)).toBe(false); // 右下
    expect(needsFlip(top)).toBe(false); // 正上方不翻
  });

  it('翻转判断会算上转盘的旋转角', () => {
    expect(needsFlip(0, Math.PI)).toBe(true); // 右边那格转了半圈到了左边
    expect(needsFlip(Math.PI, Math.PI)).toBe(false);
    expect(needsFlip(0, 10 * TAU)).toBe(false);
  });

  // 等宽假设：每个字宽 = 1 倍字号，省略号 1 个字宽
  const measure = (s) => [...s].length;
  const geo40 = { maxFont: 22, minFont: 10, outerR: 160, innerR: 26, seg: TAU / 40 };

  it('短标签用大字号', () => {
    const r = fitLabel('粥', measure, { ...geo40, seg: TAU / 6 });
    expect(r).toEqual({ text: '粥', font: 22 });
  });

  it('长标签先缩小字号，不加省略号', () => {
    const r = fitLabel('老北京铜锅涮肉', measure, { ...geo40, seg: TAU / 8 });
    expect(r.text).toBe('老北京铜锅涮肉');
    expect(r.font).toBeLessThan(22);
    expect(r.font).toBeGreaterThanOrEqual(10);
    expect(7 * r.font).toBeLessThanOrEqual(160 - 26);
  });

  it('40 个选项时字号不小于最小字号，且字高不超过扇区宽度', () => {
    for (const text of ['面', '麻辣烫', '黄焖鸡米饭', '水煮西兰花配虾']) {
      const { text: t, font } = fitLabel(text, measure, geo40);
      expect(font).toBeGreaterThanOrEqual(10);
      const w = measure(t) * font;
      const inner = 160 - w;
      expect(inner).toBeGreaterThanOrEqual(26 - 1e-9);
      // 文字最靠里那一端的扇区宽度要容得下字高
      expect(font).toBeLessThanOrEqual(0.85 * 2 * inner * Math.sin(TAU / 80) + 1e-6);
    }
  });

  it('实在放不下才加省略号', () => {
    const long = '这是一个特别特别特别特别长的选项名字';
    const r = fitLabel(long, measure, geo40);
    expect(r.font).toBe(10);
    expect(r.text.endsWith('…')).toBe(true);
    expect(measure(r.text) * 10).toBeLessThanOrEqual(160 - 26);
  });
});

describe('历史记录与内置选项', () => {
  it('addHistory 最新的在前，只保留 10 条', () => {
    let list = [];
    for (let i = 0; i < 15; i++) list = addHistory(list, { o: `x${i}`, t: i });
    expect(list).toHaveLength(HISTORY_MAX);
    expect(list[0].o).toBe('x14');
    expect(list[9].o).toBe('x5');
    expect(addHistory(null, { o: 'a', t: 1 })).toEqual([{ o: 'a', t: 1 }]);
  });

  it('内置选项集：id 唯一、选项不重复、数量合理、长度不超过自定义上限', () => {
    const ids = new Set();
    for (const s of BUILTIN_SETS) {
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
      expect(new Set(s.options).size, s.name).toBe(s.options.length);
      expect(s.options.length, s.name).toBeGreaterThanOrEqual(16);
      expect(s.options.length, s.name).toBeLessThanOrEqual(40);
      for (const o of s.options) expect([...o].length, o).toBeLessThanOrEqual(10);
    }
    for (const id of ['weekend', 'drink', 'cook']) expect(ids.has(id)).toBe(true);
  });

  it('结果引导语跟着选项集走', () => {
    expect(resultLabel(BUILTIN_SETS.find((s) => s.id === 'lunch'))).toBe('今天就吃');
    expect(resultLabel(BUILTIN_SETS.find((s) => s.id === 'weekend'))).toBe('周末就去');
    expect(resultLabel({ builtin: false })).toBe('就决定是');
  });
});

describe('VITE_API_BASE 解析', () => {
  it('生产构建留空 = 没有后端；开发模式留空 = 同源 /api', () => {
    expect(resolveApiBase('', false)).toEqual({ configured: false, base: '' });
    expect(resolveApiBase(undefined, false)).toEqual({ configured: false, base: '' });
    expect(resolveApiBase('  ', false)).toEqual({ configured: false, base: '' });
    expect(resolveApiBase('', true)).toEqual({ configured: true, base: '' });
  });
  it('"/" = 同源；完整地址去掉末尾斜杠', () => {
    expect(resolveApiBase('/', false)).toEqual({ configured: true, base: '' });
    expect(resolveApiBase('https://api.example.workers.dev/', false)).toEqual({ configured: true, base: 'https://api.example.workers.dev' });
  });
});
