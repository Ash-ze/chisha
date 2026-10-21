// 投票表单里"一行一个选项"的输入框组（实时投票和链接投票共用）
import { h, toast } from './dom.js';

export function optionRows({ max, maxLen, initial = [], id }) {
  const box = h('div', { class: 'opt-rows', id });

  function renumber() {
    [...box.querySelectorAll('input')].forEach((el, i) => (el.placeholder = `选项 ${i + 1}`));
  }

  function add(value = '') {
    if (box.children.length >= max) {
      toast(`最多 ${max} 个选项`);
      return null;
    }
    const input = h('input', {
      class: 'input', maxlength: maxLen, placeholder: `选项 ${box.children.length + 1}`, value,
    });
    const row = h('div', { class: 'opt-row' },
      input,
      h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': '删除这个选项',
        onclick: () => { row.remove(); renumber(); },
      }, '×'),
    );
    box.append(row);
    return input;
  }

  const init = initial.slice(0, max);
  if (init.length) init.forEach((o) => add([...o].slice(0, maxLen).join('')));
  else ['', '', ''].forEach(() => add());

  return {
    el: box,
    add,
    values: () => [...box.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean),
  };
}
