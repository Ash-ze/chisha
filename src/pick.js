// 转盘的纯逻辑（不依赖 DOM，便于单元测试）
// 约定：指针固定在正上方；转盘顺时针旋转 rotation 弧度；
// 扇区从正上方顺时针依次排列。每个扇区的大小与它的权重成正比（默认权重都是 1，即等分）。

export const TAU = Math.PI * 2;

export function mod(a, n) {
  return ((a % n) + n) % n;
}

/** 去掉被排除的选项（保持原顺序） */
export function activeOptions(options, excluded = []) {
  const ex = new Set(excluded);
  return options.filter((o) => !ex.has(o));
}

/** 均匀随机选一个下标 */
export function pickIndex(n, rand = Math.random) {
  if (!Number.isInteger(n) || n <= 0) throw new Error('没有可选的选项');
  const i = Math.floor(rand() * n);
  return Math.min(i, n - 1);
}

/** 把"选项个数"或"权重数组"统一成合法的权重数组（非正数、非数字一律按 1 处理） */
export function normWeights(nOrWeights) {
  if (Array.isArray(nOrWeights)) {
    return nOrWeights.map((w) => (Number.isFinite(w) && w > 0 ? w : 1));
  }
  if (!Number.isInteger(nOrWeights) || nOrWeights <= 0) throw new Error('没有可选的选项');
  return Array(nOrWeights).fill(1);
}

/** 各扇区在转盘自身坐标系里的起始角和大小（弧度，从正上方顺时针量起） */
export function segments(nOrWeights) {
  const w = normWeights(nOrWeights);
  const total = w.reduce((a, b) => a + b, 0);
  const starts = [];
  const sizes = [];
  let acc = 0;
  for (const x of w) {
    starts.push((acc / total) * TAU);
    sizes.push((x / total) * TAU);
    acc += x;
  }
  return { starts, sizes };
}

/** 按权重随机选一个下标（概率 = 权重 / 总权重 = 扇区面积占比） */
export function pickWeighted(weights, rand = Math.random) {
  const w = normWeights(weights);
  const total = w.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < w.length; i++) {
    if (r < w[i]) return i;
    r -= w[i];
  }
  return w.length - 1;
}

/** 当前旋转角下，指针指向哪个扇区 */
export function indexAtRotation(rotation, nOrWeights) {
  const a = mod(-rotation, TAU);
  if (!Array.isArray(nOrWeights)) {
    const n = nOrWeights;
    return Math.min(n - 1, Math.floor(a / (TAU / n)));
  }
  const { starts } = segments(nOrWeights);
  let i = starts.length - 1;
  while (i > 0 && starts[i] > a) i--;
  return i;
}

/**
 * 计算让第 index 个扇区停在指针下的最终角度。
 * 落点在扇区内部 15%~85% 的位置，避免停在分界线上引起争议。
 */
export function targetRotation(current, index, nOrWeights, { rand = Math.random, minSpins = 5, maxSpins = 7 } = {}) {
  const { starts, sizes } = segments(nOrWeights);
  const f = 0.15 + rand() * 0.7;
  const a = starts[index] + f * sizes[index]; // 期望停在指针下的转盘内角度
  const spins = minSpins + Math.floor(rand() * (maxSpins - minSpins + 1));
  const delta = mod(-a - current, TAU);
  return current + spins * TAU + delta;
}

/** 缓动：先快后慢，末尾有很长的"拖尾"，转盘停下的感觉更真实 */
export function easeOutQuint(t) {
  return 1 - Math.pow(1 - t, 5);
}

/** 转盘使用的缓动（限定在 [0,1]） */
export function wheelEase(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return easeOutQuint(t);
}

/**
 * 一次完整的抽取：返回 { index, option, target }
 * weights 可选：与 options 等长的权重数组；不传则等概率。
 */
export function spin(options, current = 0, rand = Math.random, { weights = null, minSpins, maxSpins } = {}) {
  const n = options.length;
  const w = weights && weights.length === n ? normWeights(weights) : null;
  const index = w ? pickWeighted(w, rand) : pickIndex(n, rand);
  const spinOpts = { rand };
  if (minSpins !== undefined) spinOpts.minSpins = minSpins;
  if (maxSpins !== undefined) spinOpts.maxSpins = maxSpins;
  const target = targetRotation(current, index, w || n, spinOpts);
  return { index, option: options[index], target };
}

/** 喜欢的选项权重 ×2 */
export const FAVORITE_WEIGHT = 2;
export function weightsFor(options, favorites = []) {
  const fav = new Set(favorites);
  return options.map((o) => (fav.has(o) ? FAVORITE_WEIGHT : 1));
}

/**
 * 淘汰模式的一步：把转到的选项从剩余列表中去掉。
 * 返回 { remaining, winner }：只剩一个时 winner 就是它，否则为 null。
 */
export function eliminationStep(remaining, picked) {
  const next = remaining.filter((o) => o !== picked);
  return { remaining: next, winner: next.length === 1 ? next[0] : null };
}
