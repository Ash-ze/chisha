// Canvas 转盘渲染 + 动画
import { TAU, indexAtRotation, segments, wheelEase } from './pick.js';
import { needsFlip, fitLabel } from './labels.js';

// 柔和的暖色系，全部够浅，深色文字在每一格上都清楚
export const COLORS = ['#ff9c6e', '#ffd666', '#ff7875', '#95de64', '#69c0ff', '#b37feb', '#ff85c0', '#5cdbd3', '#ffc069', '#d3f261'];
const FONT_FAMILY = 'system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';

/** 第 i 格的颜色（首尾相邻的两格不同色） */
export function colorAt(i, n) {
  if (n % COLORS.length === 1 && i === n - 1) return COLORS[(i + 3) % COLORS.length];
  return COLORS[i % COLORS.length];
}

export class Wheel {
  constructor(canvas, { onTick } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = [];
    this.weights = null;
    this.rotation = 0;
    this.spinning = false;
    this.onTick = onTick;
    this.face = null;
    this.fade = null; // { face, t0 } 盘面切换时的淡入淡出
    this.size = 0;
    this.dpr = 1;
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);
    this.resize();
  }

  destroy() {
    this._ro.disconnect();
  }

  /** weights 可选：与 options 等长，权重大的扇区更宽 */
  setOptions(options, weights = null, { animate = false } = {}) {
    const old = this.face;
    this.options = options.slice();
    this.weights = weights && weights.length === options.length ? weights.slice() : null;
    this.renderFace();
    if (animate && old) this.crossfade(old);
    else this.draw();
  }

  layout() {
    return this.weights || this.options.length;
  }

  resize() {
    const cssSize = Math.round(this.canvas.getBoundingClientRect().width) || 320;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const px = Math.round(cssSize * dpr);
    if (px === this.size) return;
    this.size = px;
    this.dpr = dpr;
    this.canvas.width = px;
    this.canvas.height = px;
    this.renderFace();
    this.draw();
  }

  /**
   * 把转盘盘面画到离屏 canvas，动画时只做旋转贴图，省电又流畅。
   * 文字朝向按"当前停下的角度"决定：屏幕左半边的字翻转 180°，保证都是正着读。
   */
  renderFace() {
    const S = this.size;
    if (!S) return;
    const face = document.createElement('canvas');
    face.width = S;
    face.height = S;
    const c = face.getContext('2d');
    const r = S / 2;
    const R = r * 0.94;
    const n = this.options.length;
    c.translate(r, r);

    // 外圈
    c.beginPath();
    c.arc(0, 0, r * 0.995, 0, TAU);
    c.fillStyle = '#3a2618';
    c.fill();

    if (n === 0) {
      c.beginPath();
      c.arc(0, 0, R, 0, TAU);
      c.fillStyle = '#eee';
      c.fill();
      this.face = face;
      return;
    }

    const { starts, sizes } = segments(this.layout());
    // 第 i 个扇区从正上方（-90°）顺时针开始
    for (let i = 0; i < n; i++) {
      const a0 = -Math.PI / 2 + starts[i];
      c.beginPath();
      c.moveTo(0, 0);
      c.arc(0, 0, R, a0, a0 + sizes[i]);
      c.closePath();
      c.fillStyle = colorAt(i, n);
      c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.9)';
      c.lineWidth = Math.max(1, S / 300);
      c.stroke();
    }

    // 文字：每格单独挑字号，长的先缩小，实在放不下才省略
    const dpr = this.dpr || 1;
    const minFont = Math.min(10 * dpr, S * 0.03);
    const maxFont = Math.max(minFont, S * 0.058);
    const outerR = R * 0.9;
    const innerR = S * 0.07 * 1.3; // 中心轴半径再留点空
    const REF = 100;
    c.font = `600 ${REF}px ${FONT_FAMILY}`;
    const measure = (s) => c.measureText(s).width / REF;
    const labels = this.options.map((o, i) => fitLabel(o, measure, { maxFont, minFont, outerR, innerR, seg: sizes[i] }));
    c.textBaseline = 'middle';
    c.fillStyle = '#2b1a0e';
    for (let i = 0; i < n; i++) {
      const mid = -Math.PI / 2 + starts[i] + sizes[i] / 2;
      const { text, font } = labels[i];
      c.save();
      c.font = `600 ${font}px ${FONT_FAMILY}`;
      if (needsFlip(mid, this.rotation)) {
        c.rotate(mid + Math.PI);
        c.textAlign = 'left';
        c.fillText(text, -outerR, 0);
      } else {
        c.rotate(mid);
        c.textAlign = 'right';
        c.fillText(text, outerR, 0);
      }
      c.restore();
    }

    // 外圈小灯
    const dots = Math.min(24, Math.max(12, n));
    for (let i = 0; i < dots; i++) {
      const a = (i / dots) * TAU;
      c.beginPath();
      c.arc(Math.cos(a) * r * 0.97, Math.sin(a) * r * 0.97, S * 0.008, 0, TAU);
      c.fillStyle = i % 2 ? '#ffe7ba' : '#fff7e6';
      c.fill();
    }
    this.face = face;
  }

  /** 盘面重绘（比如停下后文字翻正、选项变化）时做一个很短的淡入，避免"跳一下" */
  crossfade(oldFace) {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return this.draw();
    this.fade = { face: oldFace, t0: performance.now() };
    const step = (now) => {
      if (!this.fade) return;
      const t = (now - this.fade.t0) / 220;
      if (t >= 1) this.fade = null;
      this.draw(t);
      if (this.fade) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  draw(fadeT = 1) {
    const S = this.size;
    if (!S || !this.face) return;
    const c = this.ctx;
    const r = S / 2;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, S, S);
    c.save();
    c.translate(r, r);
    if (this.fade && fadeT < 1) {
      c.save();
      c.rotate(this.rotation);
      c.drawImage(this.fade.face, -r, -r);
      c.restore();
      c.globalAlpha = Math.max(0, Math.min(1, fadeT));
    }
    c.rotate(this.rotation);
    c.drawImage(this.face, -r, -r);
    c.restore();
    c.globalAlpha = 1;

    // 中心轴
    c.save();
    c.translate(r, r);
    c.beginPath();
    c.arc(0, 0, S * 0.07, 0, TAU);
    c.fillStyle = '#fff';
    c.shadowColor = 'rgba(0,0,0,0.25)';
    c.shadowBlur = S * 0.02;
    c.fill();
    c.shadowBlur = 0;
    c.beginPath();
    c.arc(0, 0, S * 0.035, 0, TAU);
    c.fillStyle = '#ff4d4f';
    c.fill();
    c.restore();

    // 顶部指针（不随转盘转动）
    c.save();
    c.translate(r, 0);
    c.beginPath();
    c.moveTo(-S * 0.045, S * 0.005);
    c.lineTo(S * 0.045, S * 0.005);
    c.lineTo(0, S * 0.1);
    c.closePath();
    c.fillStyle = '#ff4d4f';
    c.strokeStyle = '#fff';
    c.lineWidth = S * 0.008;
    c.shadowColor = 'rgba(0,0,0,0.3)';
    c.shadowBlur = S * 0.015;
    c.fill();
    c.shadowBlur = 0;
    c.stroke();
    c.restore();
  }

  currentIndex() {
    return this.options.length ? indexAtRotation(this.rotation, this.layout()) : -1;
  }

  /** 转到指定角度，返回 Promise，结束时 resolve */
  spinTo(target, duration = 4600) {
    if (this.spinning) return Promise.reject(new Error('spinning'));
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) duration = 600;
    this.spinning = true;
    this.fade = null;
    const start = this.rotation;
    const dist = target - start;
    const t0 = performance.now();
    let lastIdx = this.currentIndex();
    return new Promise((resolve) => {
      const frame = (now) => {
        const t = Math.min(1, (now - t0) / duration);
        this.rotation = start + dist * wheelEase(t);
        this.draw();
        const idx = this.currentIndex();
        if (idx !== lastIdx) {
          lastIdx = idx;
          this.onTick?.(1 - t);
        }
        if (t < 1) requestAnimationFrame(frame);
        else {
          // 角度归一化，避免数值无限变大
          this.rotation = target % TAU;
          this.spinning = false;
          // 停下后按新角度重排文字朝向（左半边翻正）
          const old = this.face;
          this.renderFace();
          this.crossfade(old);
          resolve();
        }
      };
      requestAnimationFrame(frame);
    });
  }
}

// ---- 声音：用 WebAudio 合成"咔哒"声，无需音频文件 ----
let audioCtx = null;
export function tickSound(strength = 1) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(900 + 500 * strength, t);
    g.gain.setValueAtTime(0.06 + 0.06 * strength, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + 0.06);
  } catch {
    /* 不支持就算了 */
  }
}

export function winSound() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.09 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.35);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.4);
    });
  } catch {
    /* ignore */
  }
}
