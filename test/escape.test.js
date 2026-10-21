import { describe, it, expect } from 'vitest';
import { esc } from '../src/dom.js';
import { parseOptions } from '../src/storage.js';

describe('前端工具', () => {
  it('esc 转义 HTML 特殊字符', () => {
    expect(esc('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(esc("a&b'`")).toBe('a&amp;b&#39;&#96;');
    expect(esc(null)).toBe('');
  });
  it('parseOptions 按行/逗号拆分、去重、截断', () => {
    expect(parseOptions('火锅\n烧烤，面条、火锅\n\n  ')).toEqual(['火锅', '烧烤', '面条']);
    expect(parseOptions('一二三四五六', 3)).toEqual(['一二三']);
    expect(parseOptions(Array.from({ length: 100 }, (_, i) => `x${i}`).join('\n'), 20, 60)).toHaveLength(60);
  });
});
