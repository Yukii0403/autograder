/**
 * 模型输出解析与章节索引的单元测试。
 *
 * 这些用例守的是「模型不听话时会发生什么」：降级链能修的就修，
 * 修不好的必须明确失败，绝不能猜内容。
 */
import { describe, it, expect } from 'vitest';
import {
  parseModelJson,
  extractFence,
  extractBraced,
  stripTrailingCommas,
  balanceBrackets,
  isRetryableContent,
  stripNulls,
} from '../src/llm/jsonGuard';
import { buildSectionIndex, renderSectionIndex, selectRelevantSections } from '../src/util/sectionIndex';
import { LlmError } from '../src/errors';

// ────────────────────────────────────────────────────────────
// JSON 降级链
// ────────────────────────────────────────────────────────────

describe('JSON 降级链', () => {
  it('干净 JSON 直接通过', () => {
    const r = parseModelJson('{"a":1}');
    expect(r.value).toEqual({ a: 1 });
    expect(r.step).toBe('raw');
  });

  it('取出 ```json 围栏内容', () => {
    expect(extractFence('说明\n```json\n{"a":1}\n```\n结尾')).toBe('{"a":1}');
    expect(extractFence('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractFence('没有围栏')).toBeNull();
  });

  it('取出被解释文字包裹的 JSON 对象', () => {
    expect(extractBraced('好的，结果如下：{"a":1} 以上。')).toBe('{"a":1}');
    expect(extractBraced('没有花括号')).toBeNull();
  });

  it('围栏内的 JSON 能正确解析', () => {
    const r = parseModelJson('这是结果：\n```json\n{"quotes":[]}\n```');
    expect(r.value).toEqual({ quotes: [] });
    expect(r.step).toBe('fence');
  });

  it('去掉尾随逗号', () => {
    const r = parseModelJson('{"a":1,"b":[1,2,],}');
    expect(r.value).toEqual({ a: 1, b: [1, 2] });
  });

  it('❗尾随逗号处理不能误伤字符串内的逗号', () => {
    const input = '{"note":"见附录 A, ] 部分","n":1}';
    expect(stripTrailingCommas(input)).toBe(input);
    expect(parseModelJson(input).value).toEqual({ note: '见附录 A, ] 部分', n: 1 });
  });

  it('补齐缺失的右花括号', () => {
    const r = parseModelJson('{"a":{"b":1}');
    expect(r.value).toEqual({ a: { b: 1 } });
  });

  it('补齐缺失的右方括号', () => {
    expect(balanceBrackets('{"a":[1,2')).toBe('{"a":[1,2]}');
  });

  it('字符串内的括号不参与配平', () => {
    expect(balanceBrackets('{"a":"{[("}')).toBe('{"a":"{[("}');
  });

  it('组合场景：围栏 + 尾随逗号 + 缺右括号', () => {
    const r = parseModelJson('```json\n{"items":[{"id":"q1",},],\n```');
    expect(r.value).toEqual({ items: [{ id: 'q1' }] });
  });

  it('完全无法解析时抛 LlmError，并记录走过的步骤', () => {
    try {
      parseModelJson('这不是 JSON，也没有花括号');
      throw new Error('本应抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      const internal = (err as LlmError).internal as { attempts?: unknown[]; preview?: string };
      expect(Array.isArray(internal.attempts)).toBe(true);
      expect(internal.preview).toBeTruthy();
    }
  });

  it('空内容被判定为可重试（DeepSeek JSON Output 的已知偶发行为）', () => {
    expect(isRetryableContent('')).toBe(true);
    expect(isRetryableContent('   \n ')).toBe(true);
    expect(isRetryableContent('{}')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// 章节索引
// ────────────────────────────────────────────────────────────

describe('章节索引', () => {
  const DOC = [
    '# 标题',
    '',
    '开头段落。',
    '',
    '## 1 原理',
    '',
    '原理正文，长度若干。',
    '',
    '### 1.1 子节',
    '',
    '子节正文。',
    '',
    '## 2 实现',
    '',
    '```c',
    'int main() {',
    '  return 0;',
    '}',
    '```',
    '',
    '结尾段落。',
  ].join('\n');

  it('提取全部标题及其层级', () => {
    const idx = buildSectionIndex(DOC);
    expect(idx.sections.map((s) => [s.title, s.level])).toEqual([
      ['标题', 1],
      ['1 原理', 2],
      ['1.1 子节', 3],
      ['2 实现', 2],
    ]);
  });

  it('章节范围在下一同级或更高级标题处结束', () => {
    const idx = buildSectionIndex(DOC);
    const principle = idx.sections.find((s) => s.title === '1 原理')!;
    const sub = idx.sections.find((s) => s.title === '1.1 子节')!;
    // 「1 原理」应包含子节，所以在「2 实现」处才结束
    expect(principle.end).toBeGreaterThan(sub.start);
    expect(principle.end).toBe(idx.sections.find((s) => s.title === '2 实现')!.start);
  });

  it('识别代码块及其语言与行数', () => {
    const idx = buildSectionIndex(DOC);
    expect(idx.codeBlocks).toHaveLength(1);
    expect(idx.codeBlocks[0]!.lang).toBe('c');
    expect(idx.codeBlocks[0]!.lines).toBe(3);
  });

  it('无标题结构的文档返回空章节', () => {
    const idx = buildSectionIndex('只是一段普通文字，没有任何标题。');
    expect(idx.sections).toEqual([]);
    expect(idx.totalChars).toBeGreaterThan(0);
  });

  it('未闭合的围栏也能得到一个代码块', () => {
    const idx = buildSectionIndex('## A\n\n```py\nprint(1)\n');
    expect(idx.codeBlocks).toHaveLength(1);
    expect(idx.codeBlocks[0]!.lang).toBe('py');
  });

  it('渲染结果包含章节、代码块与总字数', () => {
    const text = renderSectionIndex(buildSectionIndex(DOC));
    expect(text).toContain('1 原理');
    expect(text).toContain('代码块：1 个');
    expect(text).toContain('全文有效字符数');
  });

  it('短文档原样返回，不做切片', () => {
    const out = selectRelevantSections(DOC, buildSectionIndex(DOC), ['原理'], 100_000);
    expect(out).toBe(DOC);
  });

  it('标记叶子章节（切片时只用叶子，避免父子范围重叠导致内容重复）', () => {
    const idx = buildSectionIndex(DOC);
    const leaves = idx.sections.filter((s) => s.isLeaf).map((s) => s.title);
    // 「标题」有子章节、「1 原理」有子章节，都不是叶子
    expect(leaves).toEqual(['1.1 子节', '2 实现']);
  });

  it('超预算时只保留命中的章节，无关大段内容被丢弃', () => {
    const filler = '与关键词无关的填充内容。'.repeat(30);
    const big = `${DOC}\n\n## 9 附录\n\n${filler}`;
    const idx = buildSectionIndex(big);
    const out = selectRelevantSections(big, idx, ['实现'], 260);

    expect(out).toContain('2 实现');
    expect(out).not.toContain('与关键词无关的填充内容');
    expect(out.length).toBeLessThan(big.length);
  });

  it('切片输出带章节标记，便于回溯来源', () => {
    const filler = '无关内容。'.repeat(80);
    const big = `${DOC}\n\n## 9 附录\n\n${filler}`;
    const out = selectRelevantSections(big, buildSectionIndex(big), ['实现'], 260);
    expect(out).toContain('<!-- 切片：');
  });
});

// ────────────────────────────────────────────────────────────
// 模型输出归一化
// ────────────────────────────────────────────────────────────

describe('stripNulls（模型输出归一化）', () => {
  it('删除对象里值为 null 的字段', () => {
    expect(stripNulls({ page: null, anchor: '§2.1' })).toEqual({ anchor: '§2.1' });
  });

  it('递归处理嵌套对象', () => {
    expect(stripNulls({ location: { page: null, anchor: 'a' } })).toEqual({
      location: { anchor: 'a' },
    });
  });

  it('删除数组里的 null 元素', () => {
    expect(stripNulls({ refs: ['q1', null, 'q2'] })).toEqual({ refs: ['q1', 'q2'] });
  });

  it('保留 false、0 与空字符串 —— 它们不是「未提供」', () => {
    expect(stripNulls({ a: false, b: 0, c: '', d: null })).toEqual({ a: false, b: 0, c: '' });
  });

  it('不改动非对象输入', () => {
    expect(stripNulls('x')).toBe('x');
    expect(stripNulls(null)).toBe(null);
    expect(stripNulls(7)).toBe(7);
  });

  it('❗真实故障回归：location.page 为 null 的输出不再被判非法', () => {
    // 线上实测的失败样本形态。修复前它会让一份可用的观察层被拒收，
    // 并触发 3 次无用重试（每次约 14 秒，合计白烧 43 秒）。
    const modelOutput = {
      '2_found_quotes': [
        {
          quote_id: 'q1',
          material_id: 'm1',
          text: '父进程会回收全部子进程',
          location: { page: null, anchor: '§3 第2段' },
        },
      ],
      '3_locations_index': [{ material_id: 'm1', page: null, anchor: '§3' }],
    };

    const cleaned = stripNulls(modelOutput) as Record<string, unknown>;
    const quotes = cleaned['2_found_quotes'] as Array<{ location: Record<string, unknown> }>;
    const index = cleaned['3_locations_index'] as Array<Record<string, unknown>>;

    expect(quotes[0]?.location).toEqual({ anchor: '§3 第2段' });
    expect(quotes[0]?.location).not.toHaveProperty('page');
    expect(index[0]).not.toHaveProperty('page');
  });
});
