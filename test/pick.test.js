import { describe, it, expect } from 'vitest';
import { TAU, mod, activeOptions, pickIndex, indexAtRotation, targetRotation, spin, wheelEase } from '../src/pick.js';

function seeded(seed = 42) {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('转盘选择逻辑', () => {
  it('activeOptions 排除指定项并保持顺序', () => {
    expect(activeOptions(['a', 'b', 'c', 'd'], ['b', 'd'])).toEqual(['a', 'c']);
    expect(activeOptions(['a', 'b'], [])).toEqual(['a', 'b']);
    expect(activeOptions(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('pickIndex 边界：rand 返回 0 和接近 1', () => {
    expect(pickIndex(5, () => 0)).toBe(0);
    expect(pickIndex(5, () => 0.999999)).toBe(4);
    expect(pickIndex(5, () => 1)).toBe(4); // 防御性：即便 rand 返回 1 也不越界
    expect(() => pickIndex(0)).toThrow();
  });

  it('pickIndex 近似均匀分布', () => {
    const rand = seeded(7);
    const n = 8;
    const counts = Array(n).fill(0);
    const N = 80000;
    for (let i = 0; i < N; i++) counts[pickIndex(n, rand)]++;
    for (const c of counts) expect(Math.abs(c - N / n) / (N / n)).toBeLessThan(0.05);
  });

  it('indexAtRotation：未旋转时指针指向第 0 个扇区', () => {
    expect(indexAtRotation(0, 4)).toBe(0);
    // 顺时针转一点点，指针下变成最后一个扇区
    expect(indexAtRotation(0.01, 4)).toBe(3);
    // 逆时针转 1/4 圈多一点，指针下是第 1 个
    expect(indexAtRotation(-TAU / 4 - 0.01, 4)).toBe(1);
  });

  it('targetRotation 一定停在目标扇区内部，且至少转 minSpins 圈', () => {
    const rand = seeded(1);
    for (let n = 2; n <= 40; n++) {
      let current = rand() * 100 - 50;
      for (let index = 0; index < n; index++) {
        const t = targetRotation(current, index, n, { rand, minSpins: 5, maxSpins: 7 });
        expect(indexAtRotation(t, n)).toBe(index);
        expect(t - current).toBeGreaterThanOrEqual(5 * TAU);
        expect(t - current).toBeLessThan(8 * TAU);
        // 不落在分界线附近（距边界至少 10% 扇区宽度）
        const seg = TAU / n;
        const within = mod(-t, TAU) / seg - index;
        expect(within).toBeGreaterThan(0.1);
        expect(within).toBeLessThan(0.9);
        current = t;
      }
    }
  });

  it('spin 返回的 option 与最终停下的扇区一致', () => {
    const rand = seeded(99);
    const opts = ['火锅', '烧烤', '面条', '饺子', '寿司'];
    let rot = 0;
    for (let i = 0; i < 200; i++) {
      const r = spin(opts, rot, rand);
      expect(opts[indexAtRotation(r.target, opts.length)]).toBe(r.option);
      expect(r.option).toBe(opts[r.index]);
      rot = r.target % TAU;
    }
  });

  it('缓动函数单调递增、端点为 0 和 1', () => {
    expect(wheelEase(0)).toBe(0);
    expect(wheelEase(1)).toBe(1);
    let prev = 0;
    for (let t = 0.01; t <= 1; t += 0.01) {
      const v = wheelEase(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    // 先快后慢：前 30% 时间走完超过 80% 的路程
    expect(wheelEase(0.3)).toBeGreaterThan(0.8);
  });
});
