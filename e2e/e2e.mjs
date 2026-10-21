// 端到端测试：启动本地 Worker（wrangler dev --local）和静态站（vite preview），
// 用 Playwright 驱动多个手机尺寸的浏览器：转盘（权重 / 淘汰 / 历史 / 分享图）、自定义转盘、离线、建投票、两人投票、
// 实时刷新、XSS、API 不可用降级；另外模拟 GitHub Pages：不配置 VITE_API_BASE 构建、用普通静态服务器挂在 /chisha/ 子路径，
// 检查投票页的友好提示、没有任何 API 请求和控制台错误，并跑通"链接投票"（接力 + 自动合并 + 粘贴合并）。
// 用法：npm run e2e   （需要已安装 Playwright 的 Chromium；可用 PLAYWRIGHT_BROWSERS_PATH 指定位置）
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'screenshots');
const API_PORT = Number(process.env.E2E_API_PORT || 18787);
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 14787);
const PAGES_PORT = Number(process.env.E2E_PAGES_PORT || 14788);
const API = `http://127.0.0.1:${API_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const PAGES = `http://127.0.0.1:${PAGES_PORT}/chisha/`;
mkdirSync(SHOTS, { recursive: true });

const procs = [];
function start(cmd, args, env = {}) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  p.stdout.on('data', (d) => (log += d));
  p.stderr.on('data', (d) => (log += d));
  p.getLog = () => log;
  procs.push(p);
  return p;
}
function stopAll() {
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}
process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(130); });

async function waitFor(url, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`等待超时：${url}`);
}

let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error('断言失败：' + msg);
  passed++;
  console.log('  ✓ ' + msg);
}

async function assertFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
  } catch {
    return;
  }
  throw new Error(`端口 ${port} 已被占用，请用 E2E_API_PORT / E2E_WEB_PORT 换一个`);
}
await assertFree(API_PORT);
await assertFree(WEB_PORT);
await assertFree(PAGES_PORT);

const persistDir = mkdtempSync(join(tmpdir(), 'chisha-kv-'));
const pagesDir = mkdtempSync(join(tmpdir(), 'chisha-pages-'));
console.log('构建 GitHub Pages 版（VITE_API_BASE 留空）…');
execSync(`npx vite build --outDir ${JSON.stringify(join(pagesDir, 'chisha'))} --emptyOutDir`, { cwd: ROOT, env: { ...process.env, VITE_API_BASE: '' }, stdio: 'ignore' });
console.log('构建静态站（连本地 Worker）…');
execSync('npx vite build', { cwd: ROOT, env: { ...process.env, VITE_API_BASE: API }, stdio: 'ignore' });
console.log('启动 wrangler dev（本地模式）、vite preview 和一个普通静态服务器…');
// CORS 白名单只放行 e2e 的静态站来源（验证白名单真的生效）
const worker = start('npx', ['wrangler', 'dev', '--config', 'worker/wrangler.toml', '--local', '--ip', '127.0.0.1', '--port', String(API_PORT), '--persist-to', persistDir,
  '--var', `ALLOWED_ORIGINS:${WEB}`], {
  WRANGLER_SEND_METRICS: 'false', CI: '1',
});

// 和 GitHub Pages 一样"笨"的静态服务器：只按路径返回文件，找不到就 404，没有 /api
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const pagesServer = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(pagesDir, path));
  if (!file.startsWith(pagesDir)) return res.writeHead(403).end();
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }).end('<h1>404</h1>');
  }
});
await new Promise((r) => pagesServer.listen(PAGES_PORT, '127.0.0.1', r));
start('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort']);

const phone = { ...devices['iPhone 13'], defaultBrowserType: undefined };
delete phone.defaultBrowserType;
let browser;
const consoleErrors = [];

try {
  await waitFor(`${API}/api/health`);
  await waitFor(`${WEB}/`);
  browser = await chromium.launch();
  const mkCtx = () => browser.newContext({ ...phone, userAgent: phone.userAgent + ' chisha-e2e', locale: 'zh-CN' });
  const watch = (page, label) => page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`[${label}] ${m.text()}`);
  });

  // ---------------- 转盘 ----------------
  console.log('转盘');
  const ctxA = await mkCtx();
  const a = await ctxA.newPage();
  watch(a, 'A');
  await a.goto(WEB + '/');
  await a.waitForSelector('canvas.wheel-canvas');
  ok((await a.locator('.chip.active').textContent()) === '午饭', '默认选中「午饭」转盘');
  const count = async (pg) => Number((await pg.textContent('#count-line')).match(/共 (\d+) 个/)[1]);
  await a.screenshot({ path: join(SHOTS, '01-wheel.png') });

  const countBefore = await count(a);
  ok(countBefore >= 20 && countBefore <= 40, `午饭选项数量合理（${countBefore}）`);

  await a.click('#spin-btn');
  ok(await a.locator('#spin-btn').isDisabled(), '转动中按钮禁用');
  await a.waitForSelector('#result:not([hidden])', { timeout: 10000 });
  const r1 = (await a.textContent('#result-value')).trim();
  ok(r1.length > 0, `转盘结果：${r1}`);
  await a.waitForTimeout(500); // 等结果卡片动画
  await a.screenshot({ path: join(SHOTS, '02-wheel-result.png') });

  // 再转一次
  await a.click('#again-btn');
  await a.waitForSelector('#result:not([hidden])', { timeout: 10000 });
  const r2 = (await a.textContent('#result-value')).trim();
  ok(r2.length > 0, `再转一次结果：${r2}`);

  // 分享图
  await a.click('#share-btn');
  await a.waitForSelector('#share-img');
  const img = await a.evaluate(async () => {
    const el = document.getElementById('share-img');
    await el.decode();
    return { w: el.naturalWidth, h: el.naturalHeight, src: el.src };
  });
  ok(img.w === 900 && img.h === 1200, `分享图生成成功（${img.w}×${img.h}）`);
  writeFileSync(join(SHOTS, '12-share-card.png'), Buffer.from(img.src.split(',')[1], 'base64'));
  ok((await a.getAttribute('#img-download', 'download')).endsWith('.png'), '分享弹层有"保存图片"');
  await a.screenshot({ path: join(SHOTS, '13-share-modal.png') });
  await a.click('#img-modal-close');
  ok((await a.locator('#img-modal').count()) === 0, '关闭分享弹层');

  // 这个昨天吃过 → 排除
  await a.click('#exclude-btn');
  await a.waitForSelector('.excluded .tag');
  ok((await a.locator('.excluded .tag').first().textContent()).includes(r2), `「${r2}」被排除`);
  const countAfter = await count(a);
  ok(countAfter === countBefore - 1, '排除后选项数减 1');
  // 多转几次，被排除的不应再出现
  for (let i = 0; i < 3; i++) {
    await a.click('#spin-btn');
    await a.waitForSelector('#result:not([hidden])', { timeout: 10000 });
    const r = (await a.textContent('#result-value')).trim();
    ok(r !== r2, `第 ${i + 1} 次重转没有转到被排除的「${r2}」（得到 ${r}）`);
  }
  await a.evaluate(() => window.scrollTo(0, 0));
  await a.screenshot({ path: join(SHOTS, '03-wheel-excluded.png'), fullPage: true });
  // 刷新后排除仍在（localStorage）
  await a.reload();
  await a.waitForSelector('.excluded .tag');
  ok(true, '刷新后排除列表仍保留');

  // 切换内置转盘
  await a.click('.chip:has-text("奶茶")');
  ok((await a.locator('.chip.active').textContent()) === '奶茶', '切换到「奶茶」转盘');

  // 自定义转盘
  await a.click('.chip.add');
  await a.fill('#list-name', '公司楼下');
  await a.fill('#list-options', '面馆\n食堂\n<b>沙拉</b>\n面馆\n饺子馆');
  await a.screenshot({ path: join(SHOTS, '04-custom-editor.png') });
  await a.click('#list-save');
  ok((await a.locator('.chip.active').textContent()) === '公司楼下', '自定义转盘已保存并选中');
  ok((await a.textContent('#count-line')).includes('共 4 个'), '自定义选项去重后 4 个');
  await a.click('#spin-btn');
  await a.waitForSelector('#result:not([hidden])', { timeout: 10000 });
  const rc = (await a.textContent('#result-value')).trim();
  ok(['面馆', '食堂', '<b>沙拉</b>', '饺子馆'].includes(rc), `自定义转盘结果：${rc}`);

  // ---------------- 转盘玩法：历史、分享图、淘汰、权重、40 个选项 ----------------
  console.log('转盘玩法');
  ok((await a.locator('#history li').count()) >= 5, '「最近结果」记录了转盘结果');
  ok((await a.locator('#history li').first().textContent()).includes(rc), '最近结果最新一条是刚才的结果');

  // 淘汰模式：4 个选项，转 3 次决出唯一胜者
  await a.click('#elim-toggle');
  ok((await a.getAttribute('#elim-toggle', 'aria-pressed')) === 'true', '打开淘汰模式');
  const out = [];
  for (let i = 0; i < 3; i++) {
    await a.click('#spin-btn');
    await a.waitForSelector('#result:not([hidden])', { timeout: 10000 });
    out.push((await a.textContent('#result-value')).trim());
    await a.waitForTimeout(800); // 等被淘汰的那格从转盘上拿掉
    if (i < 2) ok((await count(a)) === 3 - i, `淘汰「${out[i]}」后剩 ${3 - i} 个`);
  }
  const all4 = ['面馆', '食堂', '<b>沙拉</b>', '饺子馆'];
  const winner = out[2];
  ok(new Set(out.slice(0, 2)).size === 2 && !out.slice(0, 2).includes(winner) && all4.includes(winner), `淘汰到最后：${winner}`);
  ok((await a.textContent('#result .result-label')).includes('淘汰到最后'), '结果卡片标明是最终胜者');
  ok(await a.locator('#spin-btn').isDisabled(), '决出胜者后转盘按钮停用');
  ok((await a.locator('#history li').first().textContent()).includes(winner), '胜者记入最近结果');
  await a.evaluate(() => window.scrollTo(0, 0));
  await a.screenshot({ path: join(SHOTS, '14-elimination.png'), fullPage: true });
  await a.click('#again-btn');
  ok((await count(a)) === 4 && !(await a.locator('#spin-btn').isDisabled()), '再来一轮：选项全部回来');
  await a.click('#elim-toggle');

  // 喜欢的 ×2
  await a.click('.chip:has-text("晚饭")');
  await a.click('#fav-toggle');
  await a.click('.fav-tag:has-text("火锅")');
  await a.click('.fav-tag:has-text("烤肉")');
  ok((await a.textContent('#fav-toggle')).includes('（2）'), '标记 2 个喜欢的');
  const favs = await a.evaluate(() => JSON.parse(localStorage.getItem('chisha.favorites.v1')).dinner);
  ok(favs.length === 2 && favs.includes('火锅'), '喜欢的保存在本机');
  await a.click('#spin-btn');
  await a.waitForSelector('#result:not([hidden])', { timeout: 10000 });
  ok(true, `带权重转盘正常出结果：${(await a.textContent('#result-value')).trim()}`);
  await a.evaluate(() => window.scrollTo(0, 0));
  await a.screenshot({ path: join(SHOTS, '15-favorites.png') });
  await a.click('#fav-toggle');

  // 40 个选项（含超长选项）
  const forty = ['黄焖鸡米饭', '兰州拉面', '麻辣烫', '沙县小吃', '猪脚饭', '烧腊饭', '盖浇饭', '煲仔饭', '螺蛳粉', '桂林米粉',
    '重庆小面', '炸酱面', '酸菜鱼', '水饺', '馄饨', '肉夹馍', '凉皮', '石锅拌饭', '日式拉面', '咖喱饭', '寿司', '轻食沙拉', '汉堡',
    '披萨', '冒菜', '麻辣香锅', '卤肉饭', '牛肉粉', '砂锅', '东北菜', '湘菜小炒', '粤式快餐', '老北京铜锅涮肉', '水煮西兰花配虾',
    '粥', '面', '泰式冬阴功火锅', '去隔壁城市一日游', '烤鸭', '一个特别特别特别长的选项名字'];
  await a.click('.chip.add');
  await a.fill('#list-name', '四十个');
  await a.fill('#list-options', forty.join('\n'));
  await a.click('#list-save');
  ok((await count(a)) === 40, '40 个选项的转盘');
  await a.click('#spin-btn');
  await a.waitForSelector('#result:not([hidden])', { timeout: 10000 });
  ok(forty.includes((await a.textContent('#result-value')).trim()), '40 个选项转盘结果合法');
  await a.waitForTimeout(400); // 停下后文字翻正的淡入
  ok(await a.evaluate(() => document.getElementById('result').getBoundingClientRect().bottom <= window.innerHeight + 1), '结果卡片自动滚到可见位置');
  await a.evaluate(() => window.scrollTo(0, 0));
  await a.screenshot({ path: join(SHOTS, '16-forty-options.png') });
  await a.click('.chip:has-text("公司楼下")');

  // ---------------- 离线（PWA） ----------------
  console.log('离线');
  await a.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await a.reload(); // 让页面受 SW 控制
  await a.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
  await ctxA.setOffline(true);
  await a.reload();
  await a.waitForSelector('canvas.wheel-canvas');
  await a.click('#spin-btn');
  await a.waitForSelector('#result:not([hidden])', { timeout: 10000 });
  ok(true, '断网后刷新页面，转盘照常可用');
  await a.click('#tab-vote');
  await a.waitForSelector('#api-offline', { timeout: 10000 });
  ok(true, '断网时群投票页提示服务不可用');
  await a.screenshot({ path: join(SHOTS, '05-offline-vote.png') });
  await ctxA.setOffline(false);

  // ---------------- 群投票 ----------------
  console.log('群投票');
  const XSS_TITLE = '<img src=x onerror="window.__xss=1">今晚吃啥';
  await a.goto(WEB + '/#/vote');
  await a.waitForSelector('#poll-form');
  await a.fill('#poll-title', XSS_TITLE);
  const optInputs = a.locator('#poll-options input');
  await optInputs.nth(0).fill('火锅');
  await optInputs.nth(1).fill('烧烤');
  await optInputs.nth(2).fill('<script>window.__xss=2</script>日料');
  await a.selectOption('#poll-deadline', '60');
  await a.screenshot({ path: join(SHOTS, '06-create-poll.png') });
  await a.click('#poll-create');
  await a.waitForSelector('#share-url', { timeout: 10000 });
  const shareUrl = await a.inputValue('#share-url');
  ok(/#\/p\/[23456789a-zA-Z]{8}$/.test(shareUrl), `生成分享链接 ${shareUrl}`);
  ok((await a.textContent('#poll-view-title')) === XSS_TITLE, '标题按纯文本显示（未被当作 HTML）');
  ok((await a.locator('#poll-view-title img').count()) === 0, '标题中没有生成 <img> 元素');
  await a.evaluate(() => window.scrollTo(0, 0));
  await a.screenshot({ path: join(SHOTS, '07-poll-created.png'), fullPage: true });

  // A 投票：火锅
  await a.fill('#vote-name', '小明');
  await a.click('.choice:has-text("火锅")');
  await a.click('#vote-submit');
  await a.waitForSelector('#my-choices');
  ok((await a.textContent('#my-choices')) === '火锅', 'A（小明）投给火锅');
  ok((await a.textContent('#total-voters')) === '1 人已投', 'A 看到 1 人已投');

  // B 打开链接投票：烧烤
  const ctxB = await mkCtx();
  const b = await ctxB.newPage();
  watch(b, 'B');
  await b.goto(shareUrl);
  await b.waitForSelector('#vote-name');
  ok((await b.textContent('#total-voters')) === '1 人已投', 'B 打开链接看到已有 1 票');
  await b.fill('#vote-name', '<i>小红</i>');
  await b.click('.choice:has-text("烧烤")');
  await b.evaluate(() => window.scrollTo(0, 0));
  await b.screenshot({ path: join(SHOTS, '08-friend-voting.png'), fullPage: true });
  await b.click('#vote-submit');
  await b.waitForSelector('#my-choices');
  ok((await b.textContent('#total-voters')) === '2 人已投', 'B 投票后看到 2 人已投');

  // A 不刷新，轮询自动更新
  await a.waitForFunction(() => document.querySelector('#total-voters')?.textContent === '2 人已投', null, { timeout: 12000 });
  ok(true, 'A 页面自动刷新出 B 的投票（无需手动刷新）');
  const voterLine = await a.locator('.bar[data-option="1"] .bar-voters').textContent();
  ok(voterLine === '<i>小红</i>', '昵称按纯文本显示');
  await a.evaluate(() => window.scrollTo(0, 0));
  await a.screenshot({ path: join(SHOTS, '09-live-results-A.png'), fullPage: true });

  // B 改票：火锅 → A 自动看到 火锅 2 票
  await b.click('#change-vote');
  await b.click('.choice:has-text("火锅")');
  await b.click('#vote-submit');
  await b.waitForFunction(() => document.querySelector('#my-choices')?.textContent === '火锅');
  ok(true, 'B 改票为火锅');
  await a.waitForFunction(() => document.querySelector('.bar[data-option="0"] .bar-count')?.textContent.startsWith('2 票'), null, { timeout: 12000 });
  ok((await a.textContent('#total-voters')) === '2 人已投', '改票不重复计人数');
  ok((await a.locator('.bar.lead .bar-name').first().textContent()).startsWith('火锅'), '火锅领先');
  await b.evaluate(() => window.scrollTo(0, 0));
  await b.screenshot({ path: join(SHOTS, '10-results-B.png'), fullPage: true });

  ok(await a.evaluate(() => window.__xss === undefined) && await b.evaluate(() => window.__xss === undefined), '没有任何注入脚本被执行');

  // 最近的投票列表
  await a.goto(WEB + '/#/vote');
  await a.waitForSelector('.recent li');
  ok((await a.locator('.recent li').first().textContent()).includes('我发起的'), '「最近的投票」记录了我发起的投票');
  await a.click('#mode-link');
  await a.waitForSelector('#lpoll-form');
  ok((await a.evaluate(() => location.hash)) === '#/vote/link', '配置了后端时也能切换到链接投票');
  await a.click('#mode-live');
  await a.waitForSelector('#poll-form');

  // 不存在的投票
  await b.goto(WEB + '/#/p/abcdefgh');
  await b.waitForSelector('#poll-missing', { timeout: 10000 });
  ok(true, '不存在的投票显示友好提示');

  // CORS 白名单：不在名单里的来源写不进去
  const evil = await fetch(`${API}/api/polls`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ title: 'x', options: ['a', 'b'] }),
  });
  ok(evil.status === 403 && !evil.headers.get('access-control-allow-origin'), 'Worker 拒绝白名单之外来源的请求（403）');

  // ---------------- API 不可达时的降级 ----------------
  console.log('API 不可达');
  const ctxC = await mkCtx();
  await ctxC.route(`${API}/**`, (route) => route.abort('connectionrefused'));
  const c = await ctxC.newPage();
  await c.goto(shareUrl);
  await c.waitForSelector('#api-offline', { timeout: 15000 });
  ok(true, 'API 不可达时投票页显示提示');
  await c.screenshot({ path: join(SHOTS, '11-api-unreachable.png') });
  await c.click('#api-offline a');
  await c.waitForSelector('#spin-btn');
  await c.click('#spin-btn');
  await c.waitForSelector('#result:not([hidden])', { timeout: 10000 });
  ok(true, 'API 不可达时转盘照常可用');

  const relevantErrors = consoleErrors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_FAILED/.test(e));
  ok(relevantErrors.length === 0, `没有意外的控制台错误${relevantErrors.length ? '：' + relevantErrors.join(' | ') : ''}`);

  // ---------------- GitHub Pages：没有后端 ----------------
  console.log('GitHub Pages（无后端）+ 链接投票');
  const pagesErrors = [];
  const apiRequests = [];
  const mkPagesCtx = async (label, opts = {}) => {
    const cx = await browser.newContext({ ...phone, userAgent: phone.userAgent + ' chisha-e2e', locale: 'zh-CN', ...opts });
    const pg = await cx.newPage();
    pg.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') pagesErrors.push(`[${label}] ${m.type()}: ${m.text()}`); });
    pg.on('pageerror', (e) => pagesErrors.push(`[${label}] ${e.message}`));
    pg.on('request', (r) => { if (/\/api\//.test(r.url())) apiRequests.push(r.url()); });
    return pg;
  };
  const d = await mkPagesCtx('D');
  await d.goto(PAGES);
  await d.waitForSelector('canvas.wheel-canvas');
  ok((await d.locator('meta[http-equiv="Content-Security-Policy"]').count()) === 1, 'Pages 版带 CSP');
  ok((await d.getAttribute('meta[property="og:image"]', 'content')).startsWith('https://'), 'Open Graph 图片是绝对地址');
  await d.click('#spin-btn');
  await d.waitForSelector('#result:not([hidden])', { timeout: 10000 });
  ok(true, 'Pages 版转盘正常');
  await d.click('#tab-vote');
  await d.waitForSelector('#api-not-configured');
  ok((await d.textContent('#api-not-configured')).includes('README'), '投票页显示"需要部署后端，见 README"');
  ok((await d.locator('#api-offline').count()) === 0, '没有显示"连不上服务"的错误提示');
  ok((await d.locator('#lpoll-form').count()) === 1, '直接提供链接投票表单');
  await d.screenshot({ path: join(SHOTS, '17-pages-no-api-vote.png'), fullPage: true });
  await d.goto(PAGES + '#/p/abcdefgh');
  await d.waitForSelector('#poll-not-configured');
  ok(true, '打开实时投票链接时给出友好说明而不是报错');

  // 发起链接投票（从转盘带选项过去）
  await d.goto(PAGES);
  await d.waitForSelector('#to-vote');
  await d.click('.chip:has-text("火锅店类型")');
  await d.click('#to-vote');
  await d.waitForSelector('#lpoll-form');
  ok((await d.locator('#lpoll-options input').count()) === 20, '转盘选项带到链接投票（最多 20 个）');
  await d.click('#tab-wheel');
  await d.click('#tab-vote'); // 重新进入，表单回到空白
  await d.waitForSelector('#lpoll-form');
  ok((await d.locator('#lpoll-options input').count()) === 3, '重新进入是空白表单');
  await d.fill('#lpoll-title', '周五聚餐吃啥？');
  const lin = d.locator('#lpoll-options input');
  await lin.nth(0).fill('火锅');
  await lin.nth(1).fill('烧烤');
  await lin.nth(2).fill('日料');
  await d.click('#lpoll-create');
  await d.waitForSelector('#lreply-text');
  ok((await d.textContent('#lpoll-view-title')) === '周五聚餐吃啥？', '链接投票页显示标题');
  const urlOf = async (pg) => (await pg.inputValue('#lreply-text')).match(/(https?:\/\/\S+#\/l\/[A-Za-z0-9_-]+)/)[1];
  await d.fill('#lvote-name', '发起人');
  await d.click('.choice:has-text("火锅")');
  await d.click('#lvote-submit');
  await d.waitForSelector('#lmy-choices');
  const u1 = await urlOf(d);
  ok(u1.startsWith(PAGES + '#/l/'), '投完生成带结果的新链接');
  ok((await d.inputValue('#lreply-text')).includes('发起人 投了「火锅」'), '回复消息里写明投了什么');
  await d.evaluate(() => window.scrollTo(0, 0));
  await d.waitForTimeout(2600); // 等提示条消失
  await d.screenshot({ path: join(SHOTS, '18-link-poll-voted.png') });

  // 两个朋友同时从同一条链接投票
  const e = await mkPagesCtx('E');
  await e.goto(u1);
  await e.waitForSelector('#lvote-name');
  ok((await e.textContent('#ltotal-voters')) === '1 人已投', '朋友打开链接看到已有 1 票');
  await e.fill('#lvote-name', '<i>小红</i>');
  await e.click('.choice:has-text("烧烤")');
  await e.evaluate(() => window.scrollTo(0, 0));
  await e.screenshot({ path: join(SHOTS, '19-link-poll-friend.png'), fullPage: true });
  await e.click('#lvote-submit');
  await e.waitForSelector('#lmy-choices');
  const u2 = await urlOf(e);
  const eMsg = await e.inputValue('#lreply-text');
  const f = await mkPagesCtx('F', { colorScheme: 'dark' });
  await f.goto(u1);
  await f.waitForSelector('#lvote-name');
  await f.fill('#lvote-name', '小刚');
  await f.click('.choice:has-text("日料")');
  await f.click('#lvote-submit');
  await f.waitForSelector('#lmy-choices');
  const u3 = await urlOf(f);
  const fMsg = await f.inputValue('#lreply-text');
  ok((await f.textContent('#ltotal-voters')) === '2 人已投', '并行投票的朋友各自看到 2 票');

  // 发起人依次点开两人发回的链接：自动和本机记住的结果合并
  await d.goto(u2);
  await d.waitForSelector('#lresults');
  ok((await d.textContent('#ltotal-voters')) === '2 人已投', '发起人打开第一条回复：2 票');
  await d.goto(u3);
  await d.waitForSelector('#lresults');
  ok((await d.textContent('#ltotal-voters')) === '3 人已投', '打开第二条回复后自动合并成 3 票');
  ok((await d.textContent('#lpoll-note')).includes('自动合并'), '提示已自动合并');
  ok((await d.locator('#lresults .bar[data-option="1"] .bar-voters').textContent()) === '<i>小红</i>', '昵称按纯文本显示');

  // 新设备：粘贴群消息合并
  const g = await mkPagesCtx('G');
  await g.goto(u2);
  await g.waitForSelector('#lresults');
  await g.click('#lmerge summary');
  await g.fill('#lmerge-input', `${eMsg}\n\n${fMsg}\n无关链接 https://x.example/#/l/notavalidpayload`);
  await g.click('#lmerge-btn');
  await g.waitForFunction(() => document.querySelector('#ltotal-voters')?.textContent === '3 人已投');
  ok((await g.textContent('#lmerge-msg')).includes('共 3 人'), '粘贴两条群消息合并出完整结果');
  ok(/#\/l\//.test(await g.evaluate(() => location.hash)) && (await g.evaluate(() => location.hash)) !== new URL(u2).hash, '合并后地址栏链接同步更新');
  await g.evaluate(() => window.scrollTo(0, 0));
  await g.screenshot({ path: join(SHOTS, '20-link-poll-merged.png'), fullPage: true });

  // 结果就在链接里，刷新不丢
  await g.reload();
  await g.waitForSelector('#lresults');
  ok((await g.textContent('#ltotal-voters')) === '3 人已投', '刷新后结果仍在（在链接里）');

  // 精心构造的恶意链接：标题、选项、昵称都是 HTML，只能当纯文本显示
  const evilPayload = Buffer.from(JSON.stringify({ v: 1, i: 'Evil2345', t: '<img src=x onerror="window.__xss=1">', o: ['<svg onload=f()>', 'b'], b: [['<b>x</b>', 0, 1]] })).toString('base64url');
  await g.goto(PAGES + '#/l/' + evilPayload);
  await g.waitForSelector('#lpoll-view-title');
  ok((await g.textContent('#lpoll-view-title')).startsWith('<img') && (await g.locator('#lpoll-view-title img, .bars svg').count()) === 0, '恶意链接里的 HTML 按纯文本显示');
  ok(await g.evaluate(() => window.__xss === undefined), '恶意链接没有执行脚本');

  // 截断的链接
  await g.goto(u3.slice(0, u3.length - 12));
  await g.waitForSelector('#lpoll-invalid');
  ok(true, '被截断的链接给出友好提示');

  // 深色模式 + 360px 宽的转盘截图
  const dark = await mkPagesCtx('dark', { viewport: { width: 360, height: 780 }, colorScheme: 'dark' });
  await dark.goto(PAGES);
  await dark.waitForSelector('canvas.wheel-canvas');
  await dark.click('#spin-btn');
  await dark.waitForSelector('#result:not([hidden])', { timeout: 10000 });
  await dark.waitForTimeout(600);
  await dark.screenshot({ path: join(SHOTS, '21-dark-360.png') });
  ok(await dark.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '360px 宽没有横向滚动');

  ok(await d.evaluate(() => window.__xss === undefined) && await e.evaluate(() => window.__xss === undefined), '链接投票中没有注入脚本被执行');
  ok(apiRequests.length === 0, `Pages 版没有发出任何 /api 请求${apiRequests.length ? '：' + apiRequests.join(' ') : ''}`);
  ok(pagesErrors.length === 0, `Pages 版没有任何控制台错误或警告${pagesErrors.length ? '：' + pagesErrors.join(' | ') : ''}`);

  console.log(`\n全部通过：${passed} 项断言。截图在 screenshots/`);
} catch (err) {
  console.error('\n失败：', err.message);
  for (const [i, pg] of (browser?.contexts() || []).flatMap((cx) => cx.pages()).entries()) {
    await pg.evaluate(() => window.scrollTo(0, 0));
    await pg.screenshot({ path: join(SHOTS, `zz-failure-${i}.png`), fullPage: true }).catch(() => {});
  }
  console.error('--- worker log (tail) ---\n' + worker.getLog().slice(-2000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  stopAll();
  pagesServer.close();
  rmSync(persistDir, { recursive: true, force: true });
  rmSync(pagesDir, { recursive: true, force: true });
}
