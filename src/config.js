// 构建期配置（纯函数，便于测试）

/** 项目主页，用于"见 README"之类的链接 */
export const REPO_URL = 'https://github.com/ash-ze/chisha';
export const README_DEPLOY_URL = `${REPO_URL}#部署投票后端可选`;

/**
 * 解析 VITE_API_BASE：
 * - 填完整地址（https://xxx.workers.dev）：跨域调用这个 Worker
 * - 填 "/"：同源的 /api（Worker 和静态站挂在同一域名下）
 * - 留空：生产构建视为"没有后端"（例如 GitHub Pages），投票页显示部署提示且不发任何请求；
 *         开发模式（npm run dev）下仍走同源 /api，由 Vite 代理到本地 Worker
 */
export function resolveApiBase(raw, dev = false) {
  const v = String(raw ?? '').trim();
  if (!v) return dev ? { configured: true, base: '' } : { configured: false, base: '' };
  if (v === '/') return { configured: true, base: '' };
  return { configured: true, base: v.replace(/\/+$/, '') };
}
