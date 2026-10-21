// 模式二：群投票
import { h, clear, toast, copyText } from './dom.js';
import { api, ApiError, OFFLINE_MSG, API_CONFIGURED } from './api.js';
import { README_DEPLOY_URL } from './config.js';
import { getVoterId, load, save, getRecentPolls, rememberPoll } from './storage.js';
import { optionRows } from './optionRows.js';
import { resultBars } from './bars.js';
import { renderLinkPollForm } from './linkPollView.js';

const POLL_INTERVAL = 3000;
const LIMITS = { title: 60, option: 30, options: 30, name: 20 };
const DEADLINES = [
  { label: '不限时间', min: 0 },
  { label: '10 分钟后', min: 10 },
  { label: '30 分钟后', min: 30 },
  { label: '1 小时后', min: 60 },
  { label: '3 小时后', min: 180 },
  { label: '1 天后', min: 1440 },
];

export const POLL_ID_RE = /^[23456789a-zA-Z]{8,12}$/;

function offlineBanner(msg = OFFLINE_MSG) {
  return h('div', { class: 'banner warn', role: 'alert', id: 'api-offline' },
    h('div', null, msg),
    h('a', { class: 'btn small', href: '#/' }, '去转盘'),
  );
}

/** 没有配置后端（比如只部署了 GitHub Pages）时的友好提示 */
export function notConfiguredBanner() {
  return h('div', { class: 'banner info', role: 'note', id: 'api-not-configured' },
    h('div', null,
      h('strong', null, '实时群投票需要部署后端'),
      h('div', { class: 'small' },
        '这个站点还没有连接投票服务（Cloudflare Worker），部署方法见 ',
        h('a', { href: README_DEPLOY_URL, target: '_blank', rel: 'noopener' }, 'README'),
        '。现在可以先用下面的「链接投票」，不需要服务器。'),
    ),
  );
}

function modeSwitch(mode, onSwitch) {
  const mk = (m, label) => h('button', {
    type: 'button', class: 'seg-btn' + (mode === m ? ' active' : ''), 'aria-pressed': mode === m ? 'true' : 'false',
    id: `mode-${m}`, onclick: () => mode !== m && onSwitch(m),
  }, label);
  return h('div', { class: 'seg', role: 'group', 'aria-label': '投票方式' }, mk('live', '实时投票'), mk('link', '链接投票'));
}

function shareUrl(id) {
  const u = new URL(location.href);
  u.hash = `#/p/${id}`;
  u.search = '';
  return u.toString();
}

function fmtTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return (sameDay ? '今天 ' : `${d.getMonth() + 1}月${d.getDate()}日 `) + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtLeft(ms) {
  if (ms <= 0) return '已截止';
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `还剩 ${m} 分钟`;
  const hh = Math.floor(m / 60);
  if (hh < 24) return `还剩 ${hh} 小时 ${m % 60} 分`;
  return `还剩 ${Math.floor(hh / 24)} 天`;
}

// ---------------- 创建投票 ----------------
export function renderPollHome(root, prefill, mode = 'live') {
  clear(root);
  if (!API_CONFIGURED) {
    // 只有静态站：直接提供链接投票，不发任何 API 请求
    root.append(notConfiguredBanner());
    renderLinkPollForm(root, prefill);
    return;
  }
  const switchTo = (m) => {
    history.replaceState(null, '', m === 'link' ? '#/vote/link' : '#/vote');
    renderPollHome(root, prefill, m);
  };
  root.append(modeSwitch(mode, switchTo));
  if (mode === 'link') {
    renderLinkPollForm(root, prefill);
    return;
  }
  const titleIn = h('input', {
    class: 'input', id: 'poll-title', maxlength: LIMITS.title, placeholder: '比如：今晚吃啥？',
    value: prefill?.title ? `${prefill.title}，吃哪个？` : '',
  });
  const rows = optionRows({ max: LIMITS.options, maxLen: LIMITS.option, initial: prefill?.options || [], id: 'poll-options' });
  const multiIn = h('input', { type: 'checkbox', id: 'poll-multi' });
  const deadlineSel = h('select', { class: 'input', id: 'poll-deadline' },
    DEADLINES.map((d, i) => h('option', { value: String(d.min), selected: i === 0 }, d.label)));
  const err = h('div', { class: 'error', role: 'alert', id: 'poll-error' });
  const submit = h('button', { class: 'btn primary big', type: 'submit', id: 'poll-create' }, '创建投票');
  const statusBox = h('div');

  const form = h('form', { class: 'card', id: 'poll-form', novalidate: true },
    h('h2', null, '发起群投票'),
    h('p', { class: 'muted small' }, '建好后把链接发到群里，大家填个昵称就能投，结果实时刷新。'),
    h('label', { class: 'field' }, h('span', null, '投票标题'), titleIn),
    h('div', { class: 'field' }, h('span', null, '选项'), rows.el,
      h('button', { class: 'link-btn', type: 'button', id: 'poll-add-option', onclick: () => rows.add()?.focus() }, '＋ 添加选项')),
    h('label', { class: 'check' }, multiIn, h('span', null, '允许多选')),
    h('label', { class: 'field' }, h('span', null, '截止时间'), deadlineSel),
    err,
    submit,
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const title = titleIn.value.trim();
    const options = rows.values();
    if (!title) return (err.textContent = '先写个标题吧');
    if (new Set(options).size < 2) return (err.textContent = '至少需要 2 个不同的选项');
    const min = Number(deadlineSel.value);
    submit.disabled = true;
    submit.textContent = '创建中…';
    try {
      const data = await api.createPoll({
        title, options, multi: multiIn.checked, deadline: min ? Date.now() + min * 60000 : null,
      });
      rememberPoll(data.poll, 'created');
      sessionStorageSet('justCreated', data.poll.id);
      location.hash = `#/p/${data.poll.id}`;
    } catch (ex) {
      if (ex instanceof ApiError && ex.offline) {
        clear(statusBox).append(offlineBanner());
        err.textContent = '创建失败：连不上投票服务';
      } else {
        err.textContent = ex.message || '创建失败';
      }
    } finally {
      submit.disabled = false;
      submit.textContent = '创建投票';
    }
  });

  const recent = getRecentPolls();
  root.append(
    statusBox,
    form,
    recent.length
      ? h('section', { class: 'card' },
        h('h2', null, '最近的投票'),
        h('ul', { class: 'recent' },
          recent.map((p) => h('li', null,
            h('a', { href: `#/p/${encodeURIComponent(p.id)}` }, p.title),
            h('span', { class: 'muted small' }, p.role === 'created' ? ' 我发起的' : ' 我参与的'),
          )),
        ),
      )
      : '', // 原生 append(null) 会插入文字 "null"，这里用空字符串
  );

  // 提前探测一下服务是否可用，不可用就给出提示（表单仍保留，网络恢复后可直接提交）
  api.health().catch(() => {
    if (!statusBox.firstChild) statusBox.append(offlineBanner());
  });
}

function sessionStorageSet(k, v) {
  try { sessionStorage.setItem('chisha.' + k, v); } catch { /* ignore */ }
}
function sessionStorageTake(k) {
  try {
    const v = sessionStorage.getItem('chisha.' + k);
    sessionStorage.removeItem('chisha.' + k);
    return v;
  } catch {
    return null;
  }
}

// ---------------- 查看 & 投票 ----------------
export function renderPollPage(root, id) {
  clear(root);
  if (!API_CONFIGURED) {
    root.append(h('div', { class: 'card', id: 'poll-not-configured' },
      h('h2', null, '这个站点没有连接投票服务'),
      h('p', null, '这是一个实时群投票链接，但当前站点只部署了静态页面，没有投票后端，所以打不开。部署方法见 ',
        h('a', { href: README_DEPLOY_URL, target: '_blank', rel: 'noopener' }, 'README'), '。'),
      h('div', { class: 'row gap' },
        h('a', { class: 'btn primary', href: '#/vote' }, '改用链接投票'),
        h('a', { class: 'btn', href: '#/' }, '去转盘')),
    ));
    return () => {};
  }
  if (!POLL_ID_RE.test(id)) {
    root.append(h('div', { class: 'card' }, h('h2', null, '链接不对'), h('p', null, '这个投票链接格式不正确。'), h('a', { class: 'btn', href: '#/vote' }, '发起新投票')));
    return () => {};
  }
  const voterId = getVoterId();
  const justCreated = sessionStorageTake('justCreated') === id;
  let data = null;
  let editing = false;
  let timer = null;
  let stopped = false;
  let failures = 0;
  let submitting = false;
  let remembered = false;

  const statusBox = h('div');
  const head = h('section', { class: 'card poll-head' });
  const shareBox = h('section', { class: 'card share' });
  const voteBox = h('section', { class: 'card', id: 'vote-box' });
  const resultsBox = h('section', { class: 'card', id: 'results' });
  const liveDot = h('span', { class: 'live', id: 'live' }, '加载中…');
  root.append(statusBox, head, shareBox, voteBox, resultsBox);

  // 投票表单的输入状态需要在每次刷新时保留，所以单独持有
  const nameIn = h('input', {
    class: 'input', id: 'vote-name', maxlength: LIMITS.name, placeholder: '你的昵称', value: load('nickname', ''),
  });
  let selected = new Set();

  function renderHead() {
    const p = data.poll;
    clear(head);
    const left = p.deadline ? p.deadline - Date.now() : null;
    head.append(
      h('h2', { class: 'poll-title', id: 'poll-view-title' }, p.title),
      h('div', { class: 'muted small' },
        p.multi ? '可多选' : '单选', ' · ',
        p.deadline ? (p.closed || left <= 0 ? `已于 ${fmtTime(p.deadline)} 截止` : `${fmtTime(p.deadline)} 截止（${fmtLeft(left)}）`) : '不限时间',
        ' · ', liveDot,
      ),
    );
  }

  function renderShare() {
    if (shareBox.firstChild) return;
    const url = shareUrl(id);
    const urlIn = h('input', { class: 'input mono', id: 'share-url', readonly: true, value: url, onfocus: (e) => e.target.select() });
    shareBox.append(
      h('div', { class: 'small' }, justCreated ? '投票建好啦！把链接发到群里：' : '邀请更多人：'),
      h('div', { class: 'row gap' },
        urlIn,
        h('button', {
          class: 'btn', type: 'button', id: 'copy-link',
          onclick: () => copyText(url, urlIn, '链接已复制'),
        }, '复制'),
        navigator.share
          ? h('button', { class: 'btn', type: 'button', onclick: () => navigator.share({ title: data.poll.title, url }).catch(() => {}) }, '分享')
          : null,
      ),
    );
  }

  function renderVote({ background = false } = {}) {
    const p = data.poll;
    const closed = p.closed || (p.deadline && p.deadline <= Date.now());
    // 后台轮询刷新时，如果用户正在填表单，就不要重建（否则会打断输入）
    if (background && editing && !closed && voteBox.querySelector('form') && voteBox.contains(document.activeElement)) return;
    clear(voteBox);
    if (closed) {
      voteBox.append(h('p', { class: 'muted' }, data.me ? '投票已截止，你的选择已计入结果。' : '投票已截止，不能再投了。'));
      return;
    }
    if (data.me && !editing) {
      voteBox.append(
        h('div', { class: 'voted' },
          h('div', null, '你（', data.me.name, '）投给了：'),
          h('div', { class: 'voted-choices', id: 'my-choices' }, data.me.choices.map((i) => p.options[i]).join('、')),
          h('button', {
            class: 'link-btn', type: 'button', id: 'change-vote',
            onclick: () => { editing = true; selected = new Set(data.me.choices); renderVote(); },
          }, '改票'),
        ),
      );
      return;
    }
    const optEls = p.options.map((o, i) => {
      const input = h('input', {
        type: p.multi ? 'checkbox' : 'radio', name: 'choice', value: String(i), checked: selected.has(i),
        onchange: (e) => {
          if (!p.multi) selected = new Set();
          if (e.target.checked) selected.add(i);
          else selected.delete(i);
        },
      });
      return h('label', { class: 'choice' }, input, h('span', null, o));
    });
    const err = h('div', { class: 'error', role: 'alert', id: 'vote-error' });
    const btn = h('button', { class: 'btn primary big', type: 'submit', id: 'vote-submit' }, data.me ? '提交修改' : '投票');
    const form = h('form', { novalidate: true },
      h('h3', null, data.me ? '修改你的选择' : (p.multi ? '投出你的选择（可多选）' : '投出你的选择')),
      h('label', { class: 'field' }, h('span', null, '昵称'), nameIn),
      h('div', { class: 'choices' }, optEls),
      err,
      h('div', { class: 'row gap' }, btn,
        data.me ? h('button', { class: 'btn', type: 'button', onclick: () => { editing = false; renderVote(); } }, '取消') : null),
    );
    form.addEventListener('focusin', () => (editing = true));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submitting) return;
      err.textContent = '';
      const name = nameIn.value.trim();
      if (!name) return (err.textContent = '先填个昵称吧');
      if (!selected.size) return (err.textContent = '请至少选一个');
      submitting = true;
      btn.disabled = true;
      btn.textContent = '提交中…';
      try {
        const res = await api.vote(id, { voterId, name, choices: [...selected] });
        save('nickname', name);
        data = res;
        editing = false;
        rememberPoll(res.poll, 'joined');
        toast('投票成功');
        renderAll();
      } catch (ex) {
        err.textContent = ex instanceof ApiError && ex.offline ? '提交失败：连不上投票服务，请稍后重试' : ex.message;
        btn.disabled = false;
        btn.textContent = data.me ? '提交修改' : '投票';
      } finally {
        submitting = false;
      }
    });
    voteBox.append(form);
  }

  function renderResults() {
    const p = data.poll;
    const { counts, voters, totalVoters } = data.results;
    clear(resultsBox);
    resultsBox.append(
      h('div', { class: 'row between' },
        h('h3', null, '实时结果'),
        h('span', { class: 'muted small', id: 'total-voters' }, `${totalVoters} 人已投`),
      ),
      resultBars({ options: p.options, counts, voters, mine: data.me?.choices || [], closed: p.closed }),
    );
    if (!totalVoters) resultsBox.append(h('p', { class: 'muted small' }, '还没有人投票，快去群里喊人！'));
  }

  function renderAll(background = false) {
    renderHead();
    renderShare();
    renderVote({ background });
    renderResults();
  }

  async function refresh() {
    if (stopped) return;
    try {
      const res = await api.getPoll(id, voterId);
      if (stopped) return;
      data = res;
      failures = 0;
      clear(statusBox);
      if (!remembered) {
        rememberPoll(res.poll, 'joined'); // 已是"我发起的"则保持不变
        remembered = true;
      }
      renderAll(true);
      liveDot.textContent = res.poll.closed ? '已截止' : '实时更新中';
      liveDot.classList.toggle('on', !res.poll.closed);
      if (res.poll.closed) return; // 截止后不再轮询
    } catch (ex) {
      if (stopped) return;
      failures++;
      if (ex instanceof ApiError && ex.status === 404) {
        clear(root).append(h('div', { class: 'card', id: 'poll-missing' },
          h('h2', null, '找不到这个投票'), h('p', null, '它可能已经过期（投票保留 7 天），或者链接有误。'),
          h('a', { class: 'btn primary', href: '#/vote' }, '发起新投票'), ' ', h('a', { class: 'btn', href: '#/' }, '去转盘')));
        stopped = true;
        return;
      }
      if (!data) {
        clear(statusBox).append(offlineBanner(ex.offline ? OFFLINE_MSG : ex.message));
      } else {
        liveDot.textContent = '连接中断，重试中…';
        liveDot.classList.remove('on');
      }
    }
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (stopped) return;
    // 失败时逐步拉长间隔；页面在后台时降频
    const backoff = Math.min(30000, POLL_INTERVAL * Math.pow(2, Math.max(0, failures - 1)));
    const delay = document.hidden ? Math.max(backoff, 15000) : backoff;
    timer = setTimeout(refresh, delay);
  }

  const onVis = () => {
    if (!document.hidden && !stopped) {
      clearTimeout(timer);
      refresh();
    }
  };
  document.addEventListener('visibilitychange', onVis);

  // 投票时选中状态与昵称在重绘间保留
  nameIn.addEventListener('input', () => (editing = true));
  refresh();

  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVis);
  };
}
