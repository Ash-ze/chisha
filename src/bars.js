// 投票结果的横条图（实时投票和链接投票共用）
import { h } from './dom.js';

/**
 * @param {object} o
 * @param {string[]} o.options
 * @param {number[]} o.counts
 * @param {string[][]} o.voters
 * @param {number[]} [o.mine]   我投的选项下标
 * @param {boolean} [o.closed]  已截止时领先者显示"胜出"
 */
export function resultBars({ options, counts, voters, mine = [], closed = false }) {
  const max = Math.max(0, ...counts);
  const sumVotes = counts.reduce((a, b) => a + b, 0);
  const order = options.map((_, i) => i).sort((a, b) => counts[b] - counts[a] || a - b);
  const list = h('ol', { class: 'bars' });
  for (const i of order) {
    const pct = sumVotes ? Math.round((counts[i] / sumVotes) * 100) : 0;
    const lead = max > 0 && counts[i] === max;
    list.append(
      h('li', { class: 'bar' + (lead ? ' lead' : ''), dataset: { option: String(i) } },
        h('div', { class: 'bar-top' },
          h('span', { class: 'bar-name' }, options[i], lead ? h('span', { class: 'badge' }, closed ? '胜出' : '领先') : null,
            mine.includes(i) ? h('span', { class: 'badge mine' }, '我投的') : null),
          h('span', { class: 'bar-count' }, `${counts[i]} 票 · ${pct}%`),
        ),
        h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: `${pct}%` } })),
        voters[i].length ? h('div', { class: 'bar-voters muted small' }, voters[i].join('、')) : null,
      ),
    );
  }
  return list;
}
