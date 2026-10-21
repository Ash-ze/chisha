import { defineConfig, loadEnv } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// 零依赖的 PWA：构建结束时生成 sw.js，预缓存所有产物（相对路径，兼容子目录部署）
function serviceWorkerPlugin() {
  return {
    name: 'chisha-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const publicFiles = ['index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
      const precache = ['./', ...[...new Set([...files, ...publicFiles])].map((f) => './' + f)];
      const version = createHash('sha256').update(precache.join('|')).digest('hex').slice(0, 10);
      const src = readFileSync(new URL('./src/sw.js', import.meta.url), 'utf8')
        .replace('const VERSION = __VERSION__;', `const VERSION = ${JSON.stringify(version)};`)
        .replace('const PRECACHE = __PRECACHE__;', `const PRECACHE = ${JSON.stringify(precache)};`);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

/** API 地址的 origin（用于 CSP 的 connect-src）；留空或 "/" 表示同源 */
function apiOrigin(apiBase) {
  try {
    return apiBase && apiBase.trim() !== '/' ? new URL(apiBase.trim()).origin : '';
  } catch {
    return '';
  }
}

// 页面元信息：
// - Open Graph 链接需要绝对地址，用 VITE_SITE_URL 配置（默认 GitHub Pages 地址）
// - 构建时注入 Content-Security-Policy（GitHub Pages 不能设置响应头，只能用 <meta>）
function htmlMetaPlugin(env, isBuild) {
  const site = (env.VITE_SITE_URL || 'https://ash-ze.github.io/chisha/').replace(/\/*$/, '/');
  const connect = ["'self'", apiOrigin(env.VITE_API_BASE)].filter(Boolean).join(' ');
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `connect-src ${connect}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  return {
    name: 'chisha-html-meta',
    transformIndexHtml(html) {
      return html
        .replaceAll('%CHISHA_SITE_URL%', site)
        .replace('<!--chisha:csp-->', isBuild ? `<meta http-equiv="Content-Security-Policy" content="${csp}" />` : '');
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    base: './',
    plugins: [serviceWorkerPlugin(), htmlMetaPlugin(env, command === 'build')],
    server: {
      // 本地开发时把 /api 转发给 `npm run dev:worker` 启动的 Worker
      proxy: { '/api': 'http://127.0.0.1:8787' },
    },
    test: {
      include: ['test/**/*.test.js'],
    },
  };
});
