// 投票 API 客户端。API 地址在构建时通过 VITE_API_BASE 配置。
import { resolveApiBase } from './config.js';

const { configured, base: BASE } = resolveApiBase(import.meta.env.VITE_API_BASE, import.meta.env.DEV);

/** 是否配置了实时投票后端。没配置时（比如只部署到 GitHub Pages）完全不发 API 请求。 */
export const API_CONFIGURED = configured;

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'network', offline = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.offline = offline;
  }
}

export const OFFLINE_MSG = '投票服务暂时连不上（可能是网络问题，或服务还没部署）。转盘不受影响，照常可用。';

export const NOT_CONFIGURED_MSG = '实时群投票需要部署后端（Cloudflare Worker），见 README。';

async function request(path, { method = 'GET', body, timeout = 8000 } = {}) {
  if (!API_CONFIGURED) throw new ApiError(NOT_CONFIGURED_MSG, { code: 'not_configured', offline: true });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(OFFLINE_MSG, { offline: true });
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // 不是 JSON：多半是静态站没有接 API（比如返回了 index.html 或 404 页面）
    throw new ApiError(OFFLINE_MSG, { status: res.status, offline: true });
  }
  if (!res.ok) {
    throw new ApiError(data?.error || `请求失败（${res.status}）`, { status: res.status, code: data?.code || 'error' });
  }
  return data;
}

export const api = {
  health: () => request('/api/health', { timeout: 5000 }),
  createPoll: (input) => request('/api/polls', { method: 'POST', body: input }),
  getPoll: (id, voterId) => request(`/api/polls/${encodeURIComponent(id)}?voter=${encodeURIComponent(voterId)}`),
  vote: (id, payload) => request(`/api/polls/${encodeURIComponent(id)}/vote`, { method: 'POST', body: payload }),
};
