// 链接投票：不需要服务器，题目和所有人的选择都在链接里（逻辑见 linkPoll.js）
import { h, clear, toast, copyText } from './dom.js';
import { load, save, getLinkPollCache, saveLinkPollCache } from './storage.js';
import { optionRows } from './optionRows.js';
import { resultBars } from './bars.js';
import {
  LINK_LIMITS, newLinkPoll, encodeLinkPoll, decodeLinkPoll, castLinkVote, mergeLinkPolls,
  tallyLinkPoll, findLinkPayloads, nameKey,
} from './linkPoll.js';

function linkUrl(payload) {
  const u = new URL(location.href);
  u.search = '';
  u.hash = `#/l/${payload}`;
  return u.toString();
}

function takeFlag(k) {
  try {
    const v = sessionStorage.getItem('chisha.' + k);
    sessionStorage.removeItem('chisha.' + k);
    return v;
  } catch {
    return null;
  }
}
function setFlag(k, v) {
  try { sessionStorage.setItem('chisha.' + k, v); } catch { /* ignore */ }
}

// ---------------- 发起 ----------------
export function renderLinkPollForm(root, prefill) {
  const titleIn = h('input', {
    class: 'input', id: 'lpoll-title', maxlength: LINK_LIMITS.title, placeholder: '比如：今晚吃啥？',
    value: prefill?.title ? `${prefill.title}，吃哪个？`.slice(0, LINK_LIMITS.title) : '',
  });
  const initial = prefill?.options || [];
  const rows = optionRows({ max: LINK_LIMITS.optionsMax, maxLen: LINK_LIMITS.option, initial, id: 'lpoll-options' });
  const multiIn = h('input', { type: 'checkbox', id: 'lpoll-multi' });
  const err = h('div', { class: 'error', role: 'alert', id: 'lpoll-error' });
  const submit = h('button', { class: 'btn primary big', type: 'submit', id: 'lpoll-create' }, '生成投票链接');
  const form = h('form', { class: 'card', id: 'lpoll-form', novalidate: true },
    h('h2', null, '链接投票'),
    h('p', { class: 'muted small' },
      '不需要服务器：题目和大家的选择都存在链接里。每个人投完，把生成的新链接发回群里——群里最新的那条链接就是最新结果。'),
    initial.length > LINK_LIMITS.optionsMax
      ? h('p', { class: 'hint small' }, `转盘有 ${initial.length} 个选项，链接投票最多 ${LINK_LIMITS.optionsMax} 个，已保留前 ${LINK_LIMITS.optionsMax} 个。选项少一点大家更好选。`)
      : null,
    h('label', { class: 'field' }, h('span', null, '投票标题'), titleIn),
    h('div', { class: 'field' }, h('span', null, `选项（最多 ${LINK_LIMITS.optionsMax} 个）`), rows.el,
      h('button', { class: 'link-btn', type: 'button', id: 'lpoll-add-option', onclick: () => rows.add()?.focus() }, '＋ 添加选项')),
    h('label', { class: 'check' }, multiIn, h('span', null, '允许多选')),
    err,
    submit,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.textContent = '';
    let poll;
    try {
      poll = newLinkPoll({ title: titleIn.value, options: rows.values(), multi: multiIn.checked });
    } catch (ex) {
      err.textContent = ex.message;
      return;
    }
    const payload = encodeLinkPoll(poll);
    saveLinkPollCache(poll.id, payload);
    setFlag('justCreatedLink', poll.id);
    location.hash = `#/l/${payload}`;
  });
  root.append(form);
}

// ---------------- 投票 & 结果 ----------------
export function renderLinkPollPage(root, payload) {
  clear(root);
  const fromUrl = decodeLinkPoll(payload);
  if (!fromUrl) {
    root.append(h('div', { class: 'card', id: 'lpoll-invalid' },
      h('h2', null, '链接不完整'),
      h('p', null, '这个投票链接好像不完整（可能复制时被截断了），请让发链接的人重新复制一次。'),
      h('a', { class: 'btn primary', href: '#/vote' }, '发起新投票'), ' ', h('a', { class: 'btn', href: '#/' }, '去转盘')));
    return;
  }
  // 和本机记住的结果合并：依次点开群里每个人发的链接，就能看到全部的票
  const cached = decodeLinkPoll(getLinkPollCache()[fromUrl.id]?.p);
  const merged = cached ? mergeLinkPolls(fromUrl, cached) : { poll: fromUrl, added: 0 };
  let poll = merged.poll;
  const justCreated = takeFlag('justCreatedLink') === poll.id;
  let lastAction = merged.added ? `已自动合并你之前在这台设备上看过的 ${merged.added} 票。` : '';
  let myName = load('nickname', '');
  let editing = false;
  let replyFor = null; // 刚投完：{ name, choices }

  const head = h('section', { class: 'card poll-head' });
  const shareBox = h('section', { class: 'card share', id: 'lshare' });
  const voteBox = h('section', { class: 'card', id: 'lvote-box' });
  const resultsBox = h('section', { class: 'card', id: 'lresults' });
  const mergeIn = h('textarea', {
    class: 'input', id: 'lmerge-input', rows: 3, placeholder: '把群里别人发的投票消息或链接粘贴到这里，可以一次贴好几条',
  });
  const mergeMsg = h('div', { class: 'small muted', id: 'lmerge-msg', 'aria-live': 'polite' });
  const mergeBox = h('details', { class: 'card merge', id: 'lmerge' },
    h('summary', null, '群里有好几条结果链接？合并一下'),
    h('p', { class: 'muted small' }, '两个人同时投、各自发了链接时，最新那条可能缺票。把这些消息复制粘贴进来，就能合成一份完整结果。'),
    mergeIn,
    h('div', { class: 'row gap' }, h('button', { class: 'btn', type: 'button', id: 'lmerge-btn', onclick: doMerge }, '合并'), mergeMsg),
  );
  root.append(head, shareBox, voteBox, resultsBox, mergeBox,
    h('p', { class: 'muted small note' },
      '链接投票没有服务器校验，换个昵称就能再投一次——适合熟人小范围用。人多、想防重复，可以部署实时群投票（见 README）。'));

  function persist() {
    const p = encodeLinkPoll(poll);
    saveLinkPollCache(poll.id, p);
    history.replaceState(null, '', `#/l/${p}`);
    return p;
  }

  function mine() {
    const k = nameKey(myName);
    return k ? poll.votes.find((v) => nameKey(v.name) === k) : null;
  }

  function renderHead() {
    clear(head).append(
      h('h2', { class: 'poll-title', id: 'lpoll-view-title' }, poll.title),
      h('div', { class: 'muted small' }, '链接投票 · ', poll.multi ? '可多选' : '单选', ' · ',
        h('span', { id: 'ltotal-voters' }, `${poll.votes.length} 人已投`)),
      lastAction ? h('div', { class: 'hint small', id: 'lpoll-note' }, lastAction) : '',
    );
  }

  function renderShare() {
    const url = linkUrl(encodeLinkPoll(poll));
    let lead;
    let msg;
    if (replyFor) {
      const picks = replyFor.choices.map((i) => poll.options[i]).join('、');
      lead = '投好啦！把这条回复发回群里，大家点开就能看到最新结果：';
      msg = `【今天吃啥·链接投票】${poll.title}\n${replyFor.name} 投了「${picks}」，现在 ${poll.votes.length} 人已投，点开看结果/投票👉 ${url}`;
    } else {
      lead = justCreated ? '投票链接建好啦！把这条消息发到群里：' : '把当前结果发到群里：';
      msg = `【今天吃啥·链接投票】${poll.title}\n点开投票，投完把新链接发回群里👉 ${url}`;
    }
    const ta = h('textarea', { class: 'input mono reply', id: 'lreply-text', readonly: true, rows: 4 });
    ta.value = msg;
    clear(shareBox).append(
      h('div', { class: 'small' }, lead),
      ta,
      h('div', { class: 'row gap' },
        h('button', { class: 'btn primary', type: 'button', id: 'lreply-copy', onclick: () => copyText(msg, ta, '已复制，去群里粘贴吧') }, '复制消息'),
        h('button', { class: 'btn', type: 'button', id: 'lcopy-link', onclick: () => copyText(url, null, '链接已复制') }, '只复制链接'),
        navigator.share
          ? h('button', { class: 'btn', type: 'button', onclick: () => navigator.share({ title: poll.title, text: msg }).catch(() => {}) }, '分享')
          : null,
      ),
    );
  }

  function renderVote() {
    clear(voteBox);
    const me = mine();
    if (me && !editing) {
      voteBox.append(h('div', { class: 'voted' },
        h('div', null, '你（', me.name, '）投给了：'),
        h('div', { class: 'voted-choices', id: 'lmy-choices' }, me.choices.map((i) => poll.options[i]).join('、')),
        h('button', { class: 'link-btn', type: 'button', id: 'lchange-vote', onclick: () => { editing = true; renderVote(); } }, '改票'),
      ));
      return;
    }
    let selected = new Set(me?.choices || []);
    const nameIn = h('input', {
      class: 'input', id: 'lvote-name', maxlength: LINK_LIMITS.name, placeholder: '你的昵称（群里认得出就行）', value: myName,
    });
    const optEls = poll.options.map((o, i) => h('label', { class: 'choice' },
      h('input', {
        type: poll.multi ? 'checkbox' : 'radio', name: 'lchoice', value: String(i), checked: selected.has(i),
        onchange: (e) => {
          if (!poll.multi) selected = new Set();
          if (e.target.checked) selected.add(i);
          else selected.delete(i);
        },
      }),
      h('span', null, o)));
    const err = h('div', { class: 'error', role: 'alert', id: 'lvote-error' });
    const form = h('form', { novalidate: true },
      h('h3', null, me ? '修改你的选择' : (poll.multi ? '投出你的选择（可多选）' : '投出你的选择')),
      h('label', { class: 'field' }, h('span', null, '昵称'), nameIn),
      h('div', { class: 'choices' }, optEls),
      err,
      h('div', { class: 'row gap' },
        h('button', { class: 'btn primary big', type: 'submit', id: 'lvote-submit' }, me ? '提交修改' : '投票'),
        me ? h('button', { class: 'btn', type: 'button', onclick: () => { editing = false; renderVote(); } }, '取消') : null),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      err.textContent = '';
      try {
        poll = castLinkVote(poll, nameIn.value, [...selected]);
      } catch (ex) {
        err.textContent = ex.message;
        return;
      }
      myName = nameIn.value.trim();
      save('nickname', myName);
      editing = false;
      const v = mine();
      replyFor = { name: v.name, choices: v.choices };
      lastAction = '';
      persist();
      renderAll();
      toast('投票成功，记得把消息发回群里');
      shareBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    voteBox.append(form);
  }

  function renderResults() {
    const { counts, voters, totalVoters } = tallyLinkPoll(poll);
    clear(resultsBox).append(
      h('div', { class: 'row between' }, h('h3', null, '目前结果'), h('span', { class: 'muted small' }, `${totalVoters} 人已投`)),
      resultBars({ options: poll.options, counts, voters, mine: mine()?.choices || [] }),
    );
    if (!totalVoters) resultsBox.append(h('p', { class: 'muted small' }, '还没有人投票。把链接发到群里吧！'));
  }

  function renderAll() {
    renderHead();
    renderShare();
    renderVote();
    renderResults();
  }

  function doMerge() {
    const payloads = findLinkPayloads(mergeIn.value);
    if (!payloads.length) {
      mergeMsg.textContent = '没找到投票链接，确认粘贴的内容里有 …#/l/… 这样的链接';
      return;
    }
    let added = 0;
    let other = 0;
    for (const pl of payloads) {
      const p = decodeLinkPoll(pl);
      if (!p || p.id !== poll.id) {
        other++;
        continue;
      }
      const r = mergeLinkPolls(poll, p);
      poll = r.poll;
      added += r.added;
    }
    persist();
    mergeIn.value = '';
    lastAction = '';
    mergeMsg.textContent = `合并完成：新增/更新 ${added} 票，现在共 ${poll.votes.length} 人${other ? `（${other} 条不是这个投票的链接，已忽略）` : ''}`;
    renderAll();
  }

  persist();
  renderAll();
}
