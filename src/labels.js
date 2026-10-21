// 转盘文字排版的纯逻辑（不依赖 DOM，便于单元测试）
import { TAU, mod } from './pick.js';

/**
 * 扇区中线在屏幕上落在左半边时，文字要翻转 180°，否则会倒着读。
 * faceAngle：扇区中线在转盘自身坐标系里的 canvas 角度（0 = 右，π/2 = 下）
 * rotation：转盘当前的顺时针旋转角
 */
export function needsFlip(faceAngle, rotation = 0) {
  const a = mod(faceAngle + rotation, TAU);
  // 正下方 / 正上方（cos≈0）两侧都可以，留一点容差，避免浮点误差导致来回翻
  return a > Math.PI / 2 + 1e-9 && a < (Math.PI * 3) / 2 - 1e-9;
}

/**
 * 给一个扇区的文字挑字号：放得下就用大字，放不下先缩小，缩到最小字号还放不下才加省略号。
 * 文字沿半径方向排布，外端贴在 outerR 处，向圆心延伸。
 *
 * @param {string} text
 * @param {(s: string) => number} measure  返回字号为 1px 时文字的宽度（宽度与字号成正比）
 * @param {object} o
 * @param {number} o.maxFont   最大字号
 * @param {number} o.minFont   最小字号（再小就看不清了）
 * @param {number} o.outerR    文字外端到圆心的距离
 * @param {number} o.innerR    文字不能进入的中心区域半径（中心轴）
 * @param {number} o.seg       扇区角度（弧度）
 * @returns {{ text: string, font: number }}
 */
export function fitLabel(text, measure, { maxFont, minFont, outerR, innerR, seg }) {
  const maxWidth = Math.max(0, outerR - innerR);
  // 字的"高度"不能超过文字最靠里那一端所在位置的扇区宽度（取 85% 留白）
  const c = 0.85 * 2 * Math.sin(Math.min(seg, Math.PI) / 2);
  const fontFor = (w1) => Math.min(maxFont, maxWidth / Math.max(w1, 1e-6), (c * outerR) / (1 + c * w1));
  const w1 = measure(text);
  const fs = fontFor(w1);
  if (fs >= minFont) return { text, font: fs };

  // 最小字号下允许的宽度
  const allowed = Math.min(maxWidth, outerR - minFont / c);
  if (w1 * minFont <= allowed) return { text, font: minFont };
  const chars = [...text];
  while (chars.length > 1 && measure(chars.join('') + '…') * minFont > allowed) chars.pop();
  return { text: chars.length < [...text].length ? chars.join('') + '…' : text, font: minFont };
}
