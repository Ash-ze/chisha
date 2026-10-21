// 模式一：转盘（完全离线可用）
import { h, clear, toast } from './dom.js';
import { BUILTIN_SETS, findBuiltin, resultLabel } from './data.js';
import { activeOptions, spin, weightsFor, eliminationStep } from './pick.js';
import { Wheel, tickSound, winSound } from './wheel.js';
import { drawShareCard, canvasToBlob } from './shareCard.js';
import {
  load, save, getCustomLists, saveCustomLists, parseOptions, newListId,
  getExcluded, setExcluded, getFavorites, setFavorites, getHistory, pushHistory, clearHistory,
  LIST_MAX_OPTIONS, LIST_NAME_MAX_LEN, LIST_OPTION_MAX_LEN,
} from './storage.js';

let wheel = null;

function allSets() {
  return [...BUILTIN_SETS.map((s) => ({ ...s, builtin: true })), ...getCustomLists().map((s) => ({ ...s, builtin: false }))];
}

function currentSet() {
  const id = load('currentSet', 'lunch');
  return allSets().find((s) => s.id === id) || { ...findBuiltin('lunch'), builtin: true };
}

function fmtClock(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const today = new Date().toDateString() === d.toDateString();
  return (today ? '' : `${d.getMonth() + 1}/${d.getDate()} `) + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function siteLabel() {
  const u = new URL(location.href);
  return (u.host + u.pathname).replace(/index\.html$/, '').replace(/\/$/, '');
}

export function renderWheelView(root, { goVoteWith }) {
  wheel?.destroy();
  clear(root);
  const state = {
    set: currentSet(),
    sound: load('sound', true),
    elim: null, // 淘汰模式：{ removed: [], winner: null }
    favOpen: false,
  };

  const chips = h('div', { class: 'chips', role: 'tablist', 'aria-label': '选择转盘' });
  const canvas = h('canvas', { class: 'wheel-canvas', 'aria-label': '转盘，点一下开始转', role: 'img' });
  const spinBtn = h('button', { class: 'btn primary big', id: 'spin-btn', type: 'button' }, '开始转！');
  const soundBtn = h('button', { class: 'icon-btn', type: 'button', title: '声音开关', 'aria-label': '声音开关' });
  const countLine = h('div', { class: 'muted small', id: 'count-line' });
  const elimBtn = h('button', { class: 'pill', type: 'button', id: 'elim-toggle', 'aria-pressed': 'false' }, '淘汰模式');
  const favBtn = h('button', { class: 'pill', type: 'button', id: 'fav-toggle', 'aria-expanded': 'false' });
  const elimInfo = h('div', { class: 'elim-info small', id: 'elim-info', hidden: true, 'aria-live': 'polite' });
  const resultBox = h('div', { class: 'result', id: 'result', hidden: true, 'aria-live': 'polite' });
  const favBox = h('div', { class: 'fav-wrap' });
  const excludedBox = h('div', { class: 'excluded' });
  const historyBox = h('div');
  const editorBox = h('div', { class: 'editor-wrap' });

  root.append(
    h('section', { class: 'card' },
      chips,
      h('div', { class: 'row between' }, countLine, soundBtn),
      h('div', { class: 'modes' }, elimBtn, favBtn),
    ),
    favBox,
    h('section', { class: 'wheel-wrap' }, canvas),
    h('div', { class: 'center' }, spinBtn),
    elimInfo,
    resultBox,
    excludedBox,
    historyBox,
    editorBox,
  );

  wheel = new Wheel(canvas, {
    onTick: (strength) => {
      if (state.sound) tickSound(strength);
    },
  });

  function options() {
    return activeOptions(state.set.options, [...getExcluded(state.set.id), ...(state.elim?.removed || [])]);
  }
  function favorites() {
    return getFavorites(state.set.id).filter((o) => state.set.options.includes(o));
  }

  function renderSound() {
    soundBtn.textContent = state.sound ? '🔊' : '🔇';
  }

  function renderChips() {
    clear(chips);
    for (const s of allSets()) {
      chips.append(
        h('button', {
          type: 'button',
          role: 'tab',
          class: 'chip' + (s.id === state.set.id ? ' active' : '') + (s.builtin ? '' : ' custom'),
          'aria-selected': s.id === state.set.id ? 'true' : 'false',
          onclick: () => selectSet(s.id),
        }, s.name),
      );
    }
    chips.append(h('button', { type: 'button', class: 'chip add', onclick: () => openEditor(null) }, '＋ 自定义'));
    // 只在横向滚动选项条，让选中的转盘露出来（不能用 scrollIntoView，它会把整页也滚上去）
    const act = chips.querySelector('.chip.active');
    if (act) {
      const box = chips.getBoundingClientRect();
      const r = act.getBoundingClientRect();
      if (r.left < box.left || r.right > box.right) chips.scrollLeft += r.left - box.left - 16;
    }
  }

  function renderModes() {
    elimBtn.classList.toggle('on', !!state.elim);
    elimBtn.setAttribute('aria-pressed', state.elim ? 'true' : 'false');
    const nFav = favorites().length;
    favBtn.textContent = nFav ? `♥ 喜欢的 ×2（${nFav}）` : '♡ 喜欢的 ×2';
    favBtn.classList.toggle('on', nFav > 0);
    favBtn.setAttribute('aria-expanded', state.favOpen ? 'true' : 'false');
  }

  function renderElimInfo() {
    if (!state.elim) {
      elimInfo.hidden = true;
      return;
    }
    const left = options().length;
    clear(elimInfo).append(
      h('div', null, state.elim.winner
        ? '淘汰完成！'
        : `淘汰模式：转到谁就淘汰谁，剩最后一个就是它（还剩 ${left} 个）`),
      state.elim.removed.length
        ? h('div', { class: 'muted' }, '已淘汰：', state.elim.removed.join('、'), ' ',
          h('button', { class: 'link-btn', type: 'button', id: 'elim-restart', onclick: restartElim }, '重新开始'))
        : '',
    );
    elimInfo.hidden = false;
  }

  function renderFavPanel() {
    clear(favBox);
    if (!state.favOpen) return;
    const fav = new Set(favorites());
    favBox.append(
      h('section', { class: 'card fav-panel', id: 'fav-panel' },
        h('div', { class: 'row between' },
          h('h3', null, '点选更喜欢的'),
          h('button', { class: 'link-btn', type: 'button', onclick: () => { state.favOpen = false; renderFavPanel(); renderModes(); } }, '完成'),
        ),
        h('p', { class: 'muted small' }, '标了 ♥ 的在转盘上占两格宽，被转到的概率也是两倍。'),
        h('div', { class: 'tags' },
          state.set.options.map((o) => h('button', {
            type: 'button',
            class: 'fav-tag' + (fav.has(o) ? ' on' : ''),
            'aria-pressed': fav.has(o) ? 'true' : 'false',
            onclick: () => {
              const cur = getFavorites(state.set.id);
              setFavorites(state.set.id, cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o]);
              refresh({ animate: true });
            },
          }, fav.has(o) ? '♥ ' : '', o)),
        ),
        fav.size
          ? h('button', { class: 'link-btn', type: 'button', onclick: () => { setFavorites(state.set.id, []); refresh({ animate: true }); } }, '全部取消')
          : null,
      ),
    );
  }

  function renderExcluded() {
    clear(excludedBox);
    const ex = getExcluded(state.set.id).filter((o) => state.set.options.includes(o));
    if (!ex.length) return;
    excludedBox.append(
      h('div', { class: 'row between' },
        h('span', { class: 'muted small' }, `已排除 ${ex.length} 项（点一下恢复）`),
        h('button', { class: 'link-btn', type: 'button', onclick: () => { setExcluded(state.set.id, []); refresh({ animate: true }); } }, '全部恢复'),
      ),
      h('div', { class: 'tags' },
        ex.map((o) => h('button', {
          type: 'button',
          class: 'tag',
          title: '恢复这个选项',
          onclick: () => { setExcluded(state.set.id, getExcluded(state.set.id).filter((x) => x !== o)); refresh({ animate: true }); },
        }, o, h('span', { 'aria-hidden': 'true' }, ' ×'))),
      ),
    );
  }

  function renderHistory() {
    clear(historyBox);
    const list = getHistory();
    if (!list.length) return;
    historyBox.append(
      h('section', { class: 'card history', id: 'history' },
        h('div', { class: 'row between' },
          h('h3', null, '最近结果'),
          h('button', { class: 'link-btn', type: 'button', id: 'history-clear', onclick: () => { clearHistory(); renderHistory(); } }, '清空'),
        ),
        h('ol', { class: 'history-list' },
          list.map((e) => h('li', null,
            h('span', { class: 'history-name' }, e.e ? '🏆 ' : '', e.o),
            h('span', { class: 'muted small' }, `${e.s || ''} · ${fmtClock(e.t)}`),
          )),
        ),
      ),
    );
  }

  function refresh({ animate = false } = {}) {
    const opts = options();
    wheel.setOptions(opts, weightsFor(opts, favorites()), { animate });
    clear(countLine);
    countLine.append(`「${state.set.name}」共 ${opts.length} 个选项 `);
    if (!state.set.builtin) {
      countLine.append(h('button', { class: 'link-btn', type: 'button', onclick: () => openEditor(state.set) }, '编辑'));
    }
    countLine.append(' ', h('button', {
      class: 'link-btn',
      type: 'button',
      id: 'to-vote',
      onclick: () => goVoteWith(state.set.name, opts),
    }, '拿去群投票'));
    if (state.elim?.winner) {
      spinBtn.disabled = true;
      spinBtn.textContent = `决出来了：${state.elim.winner}`;
    } else {
      spinBtn.disabled = opts.length < 2;
      spinBtn.textContent = opts.length < 2 ? '选项太少，先恢复几个吧' : state.elim ? '转！淘汰一个' : '开始转！';
    }
    renderModes();
    renderElimInfo();
    renderFavPanel();
    renderExcluded();
    renderChips();
  }

  function selectSet(id) {
    if (wheel.spinning) return;
    state.set = allSets().find((s) => s.id === id) || { ...findBuiltin('lunch'), builtin: true };
    save('currentSet', state.set.id);
    resultBox.hidden = true;
    if (state.elim) state.elim = { removed: [], winner: null };
    refresh();
  }

  function restartElim() {
    if (wheel.spinning) return;
    state.elim = { removed: [], winner: null };
    resultBox.hidden = true;
    refresh({ animate: true });
  }

  async function doSpin() {
    const opts = options();
    if (wheel.spinning || opts.length < 2 || state.elim?.winner) return;
    // 盘面还没更新（比如刚淘汰完马上又点了），先同步，保证指针停的格子和结果一致
    if (wheel.options.join('\n') !== opts.join('\n')) refresh();
    resultBox.hidden = true;
    spinBtn.disabled = true;
    spinBtn.textContent = '转呀转…';
    const elim = !!state.elim;
    const weights = weightsFor(opts, favorites());
    // 淘汰模式要转很多次，每次转得短一点
    const r = spin(opts, wheel.rotation, Math.random, elim ? { weights, minSpins: 3, maxSpins: 4 } : { weights });
    await wheel.spinTo(r.target, elim ? 2600 : 4600);
    navigator.vibrate?.(30);
    if (elim) {
      const step = eliminationStep(opts, r.option);
      state.elim.removed.push(r.option);
      if (step.winner) {
        state.elim.winner = step.winner;
        if (state.sound) winSound();
        pushHistory({ o: step.winner, s: `${state.set.name}·淘汰`, t: Date.now(), e: 1 });
        renderHistory();
        showResult(step.winner, { final: true });
      } else {
        showResult(r.option, { eliminated: true, left: step.remaining.length });
      }
      // 稍等一下再把被淘汰的那格拿掉，让人先看清指针停在哪
      setTimeout(() => { if (!wheel.spinning) refresh({ animate: true }); }, 700);
      if (!step.winner) {
        spinBtn.disabled = false;
        spinBtn.textContent = '转！淘汰一个';
      }
      return;
    }
    if (state.sound) winSound();
    pushHistory({ o: r.option, s: state.set.name, t: Date.now() });
    renderHistory();
    showResult(r.option);
    spinBtn.disabled = false;
    spinBtn.textContent = '开始转！';
  }

  function showResult(option, { eliminated = false, final = false, left = 0 } = {}) {
    clear(resultBox);
    resultBox.hidden = false;
    resultBox.classList.toggle('out', eliminated);
    let label = resultLabel(state.set);
    if (eliminated) label = `淘汰！还剩 ${left} 个`;
    if (final) label = `淘汰到最后，${label}`;
    const actions = [];
    let extra = '';
    if (eliminated) {
      actions.push(h('button', { class: 'btn primary', type: 'button', id: 'again-btn', onclick: doSpin }, '继续淘汰'));
    } else if (final) {
      actions.push(
        h('button', { class: 'btn primary', type: 'button', id: 'share-btn', onclick: () => shareResult(option, label) }, '分享图片'),
        h('button', { class: 'btn', type: 'button', id: 'again-btn', onclick: restartElim }, '再来一轮'),
      );
    } else {
      actions.push(
        h('button', { class: 'btn primary', type: 'button', id: 'again-btn', onclick: doSpin }, '再转一次'),
        h('button', { class: 'btn', type: 'button', id: 'share-btn', onclick: () => shareResult(option, label) }, '分享图片'),
      );
      extra = h('button', {
        class: 'link-btn exclude',
        type: 'button',
        id: 'exclude-btn',
        title: '把它从转盘上拿掉（随时可以恢复）',
        onclick: () => {
          const ex = getExcluded(state.set.id);
          if (!ex.includes(option)) setExcluded(state.set.id, [...ex, option]);
          resultBox.hidden = true;
          toast(`已排除「${option}」，下面可以随时恢复`);
          refresh({ animate: true });
        },
      }, '这个昨天吃过，先排除');
    }
    resultBox.append(
      h('div', { class: 'result-label' }, label),
      h('div', { class: 'result-value', id: 'result-value' }, option),
      h('div', { class: 'result-actions' }, actions),
      extra,
    );
    // 手机上结果卡片在转盘下面，滚到能看见（在缩放动画开始前量尺寸，否则会少滚一截）
    resultBox.classList.remove('pop');
    const rect = resultBox.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 8) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      window.scrollBy({ top: rect.bottom - window.innerHeight + 16, behavior: reduce ? 'auto' : 'smooth' });
    }
    void resultBox.offsetWidth;
    resultBox.classList.add('pop');
  }

  async function shareResult(option, label) {
    const cv = drawShareCard({
      result: option,
      label,
      setName: state.set.name,
      count: state.set.options.length - getExcluded(state.set.id).filter((o) => state.set.options.includes(o)).length,
      site: siteLabel(),
    });
    const blob = await canvasToBlob(cv);
    openImageModal({ dataUrl: cv.toDataURL('image/png'), blob, filename: `今天吃啥-${option}.png`, title: option });
  }

  function openEditor(list) {
    clear(editorBox);
    const isNew = !list;
    const nameInput = h('input', {
      class: 'input', id: 'list-name', maxlength: LIST_NAME_MAX_LEN, placeholder: '比如：公司附近', value: list?.name || '',
    });
    const ta = h('textarea', {
      class: 'input', id: 'list-options', rows: 8,
      placeholder: '每行一个选项，比如：\n楼下面馆\n食堂二楼\n轻食沙拉',
    });
    ta.value = list ? list.options.join('\n') : '';
    const err = h('div', { class: 'error', role: 'alert' });
    const close = () => clear(editorBox);
    const onSave = () => {
      const name = [...nameInput.value.trim()].slice(0, LIST_NAME_MAX_LEN).join('');
      const opts = parseOptions(ta.value);
      if (!name) return (err.textContent = '给转盘起个名字吧');
      if (opts.length < 2) return (err.textContent = '至少要 2 个不同的选项');
      const lists = getCustomLists();
      let id = list?.id;
      if (isNew) {
        id = newListId();
        lists.push({ id, name, options: opts });
      } else {
        const i = lists.findIndex((l) => l.id === id);
        if (i >= 0) lists[i] = { id, name, options: opts };
      }
      if (!saveCustomLists(lists)) return (err.textContent = '保存失败：浏览器不允许本地存储');
      close();
      toast('已保存');
      selectSet(id);
    };
    const onDelete = () => {
      if (!confirm(`删除转盘「${list.name}」？`)) return;
      saveCustomLists(getCustomLists().filter((l) => l.id !== list.id));
      setExcluded(list.id, []);
      setFavorites(list.id, []);
      close();
      selectSet('lunch');
    };
    editorBox.append(
      h('section', { class: 'card editor' },
        h('h2', null, isNew ? '新建自定义转盘' : '编辑转盘'),
        h('label', { class: 'field' }, h('span', null, '名字'), nameInput),
        h('label', { class: 'field' },
          h('span', null, `选项（每行一个，最多 ${LIST_MAX_OPTIONS} 个，每个不超过 ${LIST_OPTION_MAX_LEN} 字）`), ta),
        err,
        h('div', { class: 'row gap' },
          h('button', { class: 'btn primary', type: 'button', id: 'list-save', onclick: onSave }, '保存'),
          h('button', { class: 'btn', type: 'button', onclick: close }, '取消'),
          isNew ? null : h('button', { class: 'btn danger', type: 'button', onclick: onDelete }, '删除'),
        ),
        h('p', { class: 'muted small' }, '自定义转盘只保存在这台设备的浏览器里。'),
      ),
    );
    nameInput.focus();
    editorBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  spinBtn.addEventListener('click', doSpin);
  canvas.addEventListener('click', doSpin);
  soundBtn.addEventListener('click', () => {
    state.sound = !state.sound;
    save('sound', state.sound);
    renderSound();
  });
  elimBtn.addEventListener('click', () => {
    if (wheel.spinning) return;
    state.elim = state.elim ? null : { removed: [], winner: null };
    resultBox.hidden = true;
    if (state.elim) toast('淘汰模式：转到谁淘汰谁，剩最后一个就是它');
    refresh({ animate: true });
  });
  favBtn.addEventListener('click', () => {
    state.favOpen = !state.favOpen;
    renderFavPanel();
    renderModes();
  });
  renderSound();
  refresh();
  renderHistory();
}

/** 图片预览弹层：微信里长按图片即可保存 / 发送；支持系统分享的浏览器多一个"分享"按钮 */
function openImageModal({ dataUrl, blob, filename, title }) {
  document.getElementById('img-modal')?.remove();
  const prevFocus = document.activeElement;
  const close = () => {
    modal.remove();
    document.removeEventListener('keydown', onKey);
    prevFocus?.focus?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const file = blob ? new File([blob], filename, { type: 'image/png' }) : null;
  const canShareFile = !!(file && navigator.canShare?.({ files: [file] }));
  const closeBtn = h('button', { class: 'btn', type: 'button', id: 'img-modal-close', onclick: close }, '关闭');
  const modal = h('div', { class: 'modal', id: 'img-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '分享图片', onclick: (e) => { if (e.target === modal) close(); } },
    h('div', { class: 'modal-box' },
      h('img', { class: 'share-img', id: 'share-img', src: dataUrl, alt: `今天吃啥：${title}` }),
      h('p', { class: 'muted small center' }, '长按图片可以保存或直接发给朋友'),
      h('div', { class: 'row gap center-row' },
        canShareFile
          ? h('button', {
            class: 'btn primary', type: 'button',
            onclick: () => navigator.share({ files: [file], title: '今天吃啥' }).catch(() => {}),
          }, '分享…')
          : null,
        h('a', { class: 'btn' + (canShareFile ? '' : ' primary'), href: dataUrl, download: filename, id: 'img-download' }, '保存图片'),
        closeBtn,
      ),
    ),
  );
  document.body.append(modal);
  document.addEventListener('keydown', onKey);
  closeBtn.focus();
}
