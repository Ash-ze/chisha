// 把转盘结果画成一张分享图（3:4 竖图，适合发微信 / 朋友圈）
import { TAU } from './pick.js';
import { COLORS } from './wheel.js';

const FONT = 'system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
export const CARD_W = 900;
export const CARD_H = 1200;

const TAGLINES = ['就它了，不许反悔！', '转盘说了算 ✌️', '选择困难症，已治愈', '今天的快乐有着落了', '别纠结了，冲！'];

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** 在给定宽度内放下文字：先缩字号，最小字号还放不下就省略 */
function fitFont(c, text, weight, maxPx, minPx, maxW) {
  let px = maxPx;
  for (; px > minPx; px -= 4) {
    c.font = `${weight} ${px}px ${FONT}`;
    if (c.measureText(text).width <= maxW) return text;
  }
  c.font = `${weight} ${minPx}px ${FONT}`;
  const chars = [...text];
  while (chars.length > 1 && c.measureText(chars.join('') + '…').width > maxW) chars.pop();
  return chars.length < [...text].length ? chars.join('') + '…' : text;
}

function fmtDate(d) {
  const week = '日一二三四五六'[d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 · 星期${week}`;
}

/**
 * @param {object} o
 * @param {string} o.result      结果
 * @param {string} o.label       结果上方的引导语（今天就吃 / 最后剩下的是 …）
 * @param {string} o.setName     转盘名
 * @param {number} o.count       转盘上一共有几个选项
 * @param {string} o.site        页脚显示的网址
 * @param {Date}   [o.date]
 * @returns {HTMLCanvasElement}
 */
export function drawShareCard({ result, label, setName, count, site, date = new Date(), tagline }) {
  const cv = document.createElement('canvas');
  cv.width = CARD_W;
  cv.height = CARD_H;
  const c = cv.getContext('2d');
  const W = CARD_W;

  // 背景
  const bg = c.createLinearGradient(0, 0, W, CARD_H);
  bg.addColorStop(0, '#fff3e8');
  bg.addColorStop(1, '#ffe2c7');
  c.fillStyle = bg;
  c.fillRect(0, 0, W, CARD_H);

  // 背景上的大转盘（右上角，半露）
  const cx = W - 120;
  const cy = 150;
  const R = 300;
  const n = 12;
  c.save();
  c.globalAlpha = 0.9;
  c.beginPath();
  c.arc(cx, cy, R + 14, 0, TAU);
  c.fillStyle = '#3a2618';
  c.fill();
  for (let i = 0; i < n; i++) {
    c.beginPath();
    c.moveTo(cx, cy);
    c.arc(cx, cy, R, (i / n) * TAU, ((i + 1) / n) * TAU);
    c.closePath();
    c.fillStyle = COLORS[i % COLORS.length];
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.9)';
    c.lineWidth = 4;
    c.stroke();
  }
  c.beginPath();
  c.arc(cx, cy, 46, 0, TAU);
  c.fillStyle = '#fff';
  c.fill();
  c.beginPath();
  c.arc(cx, cy, 22, 0, TAU);
  c.fillStyle = '#ff4d4f';
  c.fill();
  c.restore();

  // 标题
  c.textBaseline = 'alphabetic';
  c.textAlign = 'left';
  c.fillStyle = '#2b1a0e';
  c.font = `800 72px ${FONT}`;
  c.fillText('今天吃啥', 64, 130);
  c.fillStyle = '#8c7262';
  c.font = `500 32px ${FONT}`;
  c.fillText(fmtDate(date), 66, 186);

  // 结果卡片
  const cardX = 56;
  const cardY = 400;
  const cardW = W - 112;
  const cardH = 500;
  c.save();
  c.shadowColor = 'rgba(160, 80, 30, 0.18)';
  c.shadowBlur = 40;
  c.shadowOffsetY = 12;
  roundRect(c, cardX, cardY, cardW, cardH, 40);
  c.fillStyle = '#ffffff';
  c.fill();
  c.restore();
  roundRect(c, cardX, cardY, cardW, cardH, 40);
  c.lineWidth = 6;
  c.strokeStyle = '#ffc53d';
  c.stroke();

  // 指针（指向结果）
  c.beginPath();
  c.moveTo(W / 2 - 34, cardY - 6);
  c.lineTo(W / 2 + 34, cardY - 6);
  c.lineTo(W / 2, cardY + 54);
  c.closePath();
  c.fillStyle = '#ff4d4f';
  c.fill();
  c.lineWidth = 6;
  c.strokeStyle = '#fff';
  c.stroke();

  c.textAlign = 'center';
  c.fillStyle = '#8c7262';
  c.font = `600 40px ${FONT}`;
  c.fillText(label, W / 2, cardY + 150);

  c.fillStyle = '#e8592a';
  const shown = fitFont(c, result, 900, 150, 64, cardW - 80);
  c.fillText(shown, W / 2, cardY + 330);

  // 小标签：转盘名 · N 选 1
  const chip = `${setName} · ${count} 选 1`;
  c.font = `600 32px ${FONT}`;
  const chipText = fitFont(c, chip, 600, 32, 24, cardW - 140);
  const cw = c.measureText(chipText).width + 56;
  roundRect(c, W / 2 - cw / 2, cardY + 400, cw, 60, 30);
  c.fillStyle = '#fff1e6';
  c.fill();
  c.fillStyle = '#e8592a';
  c.fillText(chipText, W / 2, cardY + 441);

  c.fillStyle = '#2b1a0e';
  c.font = `700 40px ${FONT}`;
  c.fillText(tagline || TAGLINES[Math.floor(Math.random() * TAGLINES.length)], W / 2, cardY + cardH + 110);

  // 页脚
  c.fillStyle = '#8c7262';
  c.font = `500 28px ${FONT}`;
  const foot = fitFont(c, `你也来转一个 → ${site}`, 500, 28, 20, W - 120);
  c.fillText(foot, W / 2, CARD_H - 56);
  return cv;
}

/** canvas → Blob（PNG） */
export function canvasToBlob(cv) {
  return new Promise((resolve) => cv.toBlob((b) => resolve(b), 'image/png'));
}
