// 生成 Open Graph 分享图 public/og.png（1200×630），只在修改设计时需要运行：node scripts/gen-og.mjs
import { chromium } from 'playwright';

const COLORS = ['#ff9c6e', '#ffd666', '#ff7875', '#95de64', '#69c0ff', '#b37feb', '#ff85c0', '#5cdbd3', '#ffc069', '#d3f261'];
const LABELS = ['火锅', '烧烤', '麻辣烫', '饺子', '寿司', '螺蛳粉', '烤鱼', '拉面', '炸鸡', '煲仔饭'];
const n = LABELS.length;
const R = 250;
const seg = (Math.PI * 2) / n;
let paths = '';
for (let i = 0; i < n; i++) {
  const a0 = -Math.PI / 2 + i * seg;
  const a1 = a0 + seg;
  const mid = (a0 + a1) / 2;
  const x0 = R * Math.cos(a0);
  const y0 = R * Math.sin(a0);
  const x1 = R * Math.cos(a1);
  const y1 = R * Math.sin(a1);
  paths += `<path d="M0 0 L${x0} ${y0} A${R} ${R} 0 0 1 ${x1} ${y1} Z" fill="${COLORS[i]}" stroke="#fff" stroke-width="3"/>`;
  const deg = (mid * 180) / Math.PI;
  const left = Math.cos(mid) < -1e-9;
  paths += left
    ? `<text transform="rotate(${deg + 180})" x="${-R * 0.88}" y="0" text-anchor="start">${LABELS[i]}</text>`
    : `<text transform="rotate(${deg})" x="${R * 0.88}" y="0" text-anchor="end">${LABELS[i]}</text>`;
}
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;width:1200px;height:630px;overflow:hidden;font-family:system-ui,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;
    background:linear-gradient(135deg,#fff3e8,#ffe2c7);color:#2b1a0e;display:flex;align-items:center}
  .txt{padding-left:84px;width:560px}
  h1{font-size:104px;margin:0 0 18px;letter-spacing:4px;font-weight:800}
  p{font-size:38px;margin:0 0 12px;color:#8c7262;font-weight:600}
  .pill{display:inline-block;margin-top:26px;background:#ff7a45;color:#fff;font-size:34px;font-weight:700;padding:14px 34px;border-radius:999px}
  svg text{font-size:26px;font-weight:700;fill:#2b1a0e;dominant-baseline:middle}
</style></head><body>
  <div class="txt"><h1>今天吃啥</h1><p>转个转盘 · 发个群投票</p><p>一秒决定今天吃什么</p><span class="pill">开始转！</span></div>
  <svg width="620" height="630" viewBox="-310 -315 620 630">
    <circle r="${R + 16}" fill="#3a2618"/>${paths}
    <circle r="40" fill="#fff"/><circle r="20" fill="#ff4d4f"/>
    <path d="M-26 ${-R - 22} L26 ${-R - 22} L0 ${-R + 34} Z" fill="#ff4d4f" stroke="#fff" stroke-width="5"/>
  </svg>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await page.screenshot({ path: new URL('../public/og.png', import.meta.url).pathname });
await browser.close();
console.log('og.png generated');
