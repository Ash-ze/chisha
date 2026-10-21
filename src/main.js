import './style.css';
import { h, clear } from './dom.js';
import { renderWheelView } from './wheelView.js';
import { renderPollHome, renderPollPage } from './pollView.js';
import { renderLinkPollPage } from './linkPollView.js';
import { API_CONFIGURED } from './api.js';
import { REPO_URL } from './config.js';

const app = document.getElementById('app');
const view = h('main', { id: 'view' });
const tabWheel = h('a', { href: '#/', class: 'tab', id: 'tab-wheel' }, '转盘');
const tabVote = h('a', { href: '#/vote', class: 'tab', id: 'tab-vote' }, '群投票');

clear(app).append(
  h('header', { class: 'top' },
    h('h1', null, h('span', { class: 'logo', 'aria-hidden': 'true' }, '🍚'), '今天吃啥 · What to Eat'),
    h('nav', { class: 'tabs' }, tabWheel, tabVote),
  ),
  view,
  h('footer', { class: 'foot muted small' },
    h('a', { href: REPO_URL, target: '_blank', rel: 'noopener' }, '开源项目'),
    API_CONFIGURED ? ' · 转盘离线可用 · 投票保留 7 天' : ' · 转盘离线可用 · 链接投票无需服务器'),
);

let cleanup = null;
let pendingPrefill = null;

function goVoteWith(title, options) {
  pendingPrefill = { title, options: options.slice() };
  location.hash = '#/vote';
}

function route() {
  cleanup?.();
  cleanup = null;
  const hash = location.hash.replace(/^#/, '') || '/';
  const m = hash.match(/^\/p\/([^/?#]+)/);
  const lm = hash.match(/^\/l\/([^/?#]+)/);
  const isVote = hash.startsWith('/vote') || !!m || !!lm;
  tabWheel.classList.toggle('active', !isVote);
  tabVote.classList.toggle('active', isVote);
  tabWheel.setAttribute('aria-current', isVote ? 'false' : 'page');
  tabVote.setAttribute('aria-current', isVote ? 'page' : 'false');
  if (lm) {
    renderLinkPollPage(view, lm[1]);
  } else if (m) {
    let id = '';
    try { id = decodeURIComponent(m[1]); } catch { /* 保持为空，交给页面提示 */ }
    cleanup = renderPollPage(view, id);
  } else if (isVote) {
    renderPollHome(view, pendingPrefill, hash.startsWith('/vote/link') ? 'link' : 'live');
    pendingPrefill = null;
  } else {
    renderWheelView(view, { goVoteWith });
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
