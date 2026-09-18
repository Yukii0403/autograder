/**
 * 两道护城河的单元测试：禁用词扫描 + 引文回查。
 *
 * 这两条守着系统的可信度：观察层不能掺入判断，扣分依据必须能定位到原文。
 */
import { describe, it, expect } from 'vitest';
import { scanJudgement, assertNoJudgement, listJudgementHits } from '../src/util/judgementScan';
import {
  verifyQuotes,
  locateQuote,
  diceSimilarity,
  normalizeWithMap,
  toParseFailures,
} from '../src/util/quoteVerify';
import { JudgementLeakError } from '../src/errors';
import type { EvidenceModelOutput, FoundQuote } from '../src/schema';

function makeModelOutput(overrides: Partial<EvidenceModelOutput> = {}): EvidenceModelOutput {
  return {
    '1_searched_materials': [],
    '2_found_quotes': [],
    '3_locations_index': [],
    '4_not_found': [],
    '5_surface_conflicts': [],
    ...overrides,
  };
}

function quote(overrides: Partial<FoundQuote> = {}): FoundQuote {
  return {
    quote_id: 'q1',
    material_id: 'm1',
    text: '原文内容',
    location: { anchor: '§1' },
    verified: 'unverified',
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────
// 禁用词扫描
// ────────────────────────────────────────────────────────────

describe('禁用词扫描', () => {
  it('干净的观察文本不报错', () => {
    const out = makeModelOutput({
      '1_searched_materials': [{ material_id: 'm1', source_type: 'report_text', range: 'p.3-4', query: '原理说明' }],
      '4_not_found': [
        { expectation_id: 'r2', expected: '对 waitpid 返回值的处理说明', searched_scope: ['report_text'], status: 'not_found' },
      ],
    });
    expect(scanJudgement(out)).toEqual([]);
    expect(() => assertNoJudgement(out)).not.toThrow();
  });

  it('合法的观察用语不被误伤', () => {
    // 注意：这些串必须全部落在「纯观察」一侧。
    // 「缺失」不在其中 —— 它带评价色彩（"报告缺失了 X"），
    // 描述「没有」的规范说法是「未找到 / 未提供 / 无对应」，所以它属于被拦一侧。
    const LEGAL = [
      '未找到匹配',
      '未在该范围内出现',
      '与附录代码不一致',
      '无对应的错误处理分支',
      '错误码未被捕获',
      '问题分析与改进章节的说明',
      '该项未提供',
    ];
    for (const text of LEGAL) {
      const out = makeModelOutput({
        '4_not_found': [{ expectation_id: 'r1', expected: text, searched_scope: ['report_text'], status: 'not_found' }],
      });
      expect(scanJudgement(out), `不应命中：${text}`).toEqual([]);
    }
  });

  it('「缺失」被拦下，规范说法「未找到」放行', () => {
    const banned = makeModelOutput({
      '4_not_found': [{ expectation_id: 'r1', expected: '异常处理部分缺失', searched_scope: ['report_text'], status: 'not_found' }],
    });
    expect(scanJudgement(banned).map((h) => h.term)).toContain('缺失');

    const allowed = makeModelOutput({
      '4_not_found': [{ expectation_id: 'r1', expected: '未找到异常处理相关段落', searched_scope: ['report_text'], status: 'not_found' }],
    });
    expect(scanJudgement(allowed)).toEqual([]);
  });

  it('「错误 / 问题」只收复合评价形式，不误伤技术名词', () => {
    // 这两组行为的差别很关键：误报会拒收整个观察层并触发重生成，代价远高于漏报。
    const SHOULD_HIT = ['该实现存在问题', '此处逻辑错误', '存在明显错误', '做法是错误的'];
    for (const text of SHOULD_HIT) {
      const out = makeModelOutput({
        '4_not_found': [{ expectation_id: 'r1', expected: text, searched_scope: ['report_text'], status: 'not_found' }],
      });
      expect(scanJudgement(out).length, `应命中：${text}`).toBeGreaterThan(0);
    }
  });

  it('检出 4_not_found 中的评价性用词', () => {
    const out = makeModelOutput({
      '4_not_found': [
        { expectation_id: 'r1', expected: '这部分写得很敷衍', searched_scope: ['report_text'], status: 'not_found' },
      ],
    });
    const hits = scanJudgement(out);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.field).toBe('4_not_found[0].expected');
    expect(hits[0]!.term).toBe('敷衍');
  });

  it('检出 5_surface_conflicts 中的评价性用词', () => {
    const out = makeModelOutput({
      '5_surface_conflicts': [
        {
          conflict_id: 'x1',
          nature: 'factual_mismatch',
          claim: '正文声称使用多进程，但这明显是抄袭',
          claim_location: { anchor: '§2.3' },
          observed: '代码中无 fork 调用',
          observed_location: { anchor: 'list.1' },
        },
      ],
    });
    const terms = scanJudgement(out).map((h) => h.term);
    expect(terms).toContain('抄袭');
  });

  it('❗不扫描逐字摘录 —— 学生自己在报告里写「好」不应被判为定性', () => {
    const out = makeModelOutput({
      '2_found_quotes': [
        {
          quote_id: 'q1',
          material_id: 'm1',
          text: '本次实验顺利完成，效果很好，程序运行稳定。',
          location: { anchor: '§5' },
          verified: 'exact',
        },
      ],
    });
    expect(scanJudgement(out)).toEqual([]);
  });

  it('命中时抛出 JudgementLeakError 且错误信息含命中词与字段', () => {
    const out = makeModelOutput({
      '1_searched_materials': [
        { material_id: 'm1', source_type: 'report_text', range: 'p.1', query: '检查实现是否完整' },
      ],
    });
    try {
      assertNoJudgement(out);
      throw new Error('本应抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(JudgementLeakError);
      expect((err as JudgementLeakError).message).toContain('完整');
      expect((err as JudgementLeakError).code).toBe('JUDGEMENT_LEAK');
    }
  });

  it('listJudgementHits 给出可读的定位信息', () => {
    const out = makeModelOutput({
      '5_surface_conflicts': [
        {
          conflict_id: 'x1',
          nature: 'numeric_mismatch',
          claim: '正文称耗时 3.2 秒，数据显示 5.1 秒，明显有问题',
          claim_location: { anchor: '§4' },
          observed: '数据表为 5.1 秒',
          observed_location: { anchor: 'fig.2' },
        },
      ],
    });
    const lines = listJudgementHits(out);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('5_surface_conflicts[0].claim');
  });
});

// ────────────────────────────────────────────────────────────
// 引文回查
// ────────────────────────────────────────────────────────────

describe('引文回查 · 归一化与相似度', () => {
  it('归一化去掉空白并转小写，且能映射回原文下标', () => {
    const { normalized, map } = normalizeWithMap('A B\nC');
    expect(normalized).toBe('abc');
    expect(map).toEqual([0, 2, 4]);
  });

  it('Dice 相似度：完全相同为 1，完全不同接近 0', () => {
    expect(diceSimilarity('abcdef', 'abcdef')).toBe(1);
    expect(diceSimilarity('abcdef', '完全不同的内容')).toBeLessThan(0.1);
  });

  it('一个字符之差的长文本仍高于 0.9', () => {
    const a = '本实验通过实现生产者消费者模型来验证信号量的同步机制';
    const b = '本实验通过实现生产者消费者模式来验证信号量的同步机制';
    expect(diceSimilarity(a, b)).toBeGreaterThanOrEqual(0.9);
  });
});

describe('引文回查 · locateQuote', () => {
  const TEXT = '第一章 原理说明\n本实验通过实现生产者消费者模型来验证信号量的同步机制。\n第二章 实现';

  it('精确命中返回 exact', () => {
    const r = locateQuote(TEXT, '本实验通过实现生产者消费者模型来验证信号量的同步机制。', 0.9);
    expect(r?.verified).toBe('exact');
  });

  it('忽略空白与大小写差异后仍能精确命中', () => {
    const r = locateQuote('hello world', 'HELLO   WORLD', 0.9);
    expect(r?.verified).toBe('exact');
    expect(r?.start).toBe(0);
    expect(r?.end).toBe('hello world'.length);
  });

  it('轻微错字命中为 fuzzy', () => {
    const r = locateQuote(TEXT, '本实验通过实现生产者消费者模式来验证信号量的同步机制。', 0.85);
    expect(r?.verified).toBe('fuzzy');
    expect(r?.similarity).toBeGreaterThanOrEqual(0.85);
  });

  it('编造的内容返回 null', () => {
    expect(locateQuote(TEXT, '本文使用了量子计算方法进行加速', 0.9)).toBeNull();
  });

  it('空摘录返回 null', () => {
    expect(locateQuote(TEXT, '   ', 0.9)).toBeNull();
  });

  it('返回的偏移在原文坐标系下可切出对应片段', () => {
    const r = locateQuote(TEXT, '生产者消费者模型', 0.9);
    expect(r).not.toBeNull();
    expect(TEXT.slice(r!.start, r!.end)).toContain('生产者消费者模型');
  });
});

describe('引文回查 · verifyQuotes', () => {
  const TEXT = '第一章 原理说明\n本实验通过实现生产者消费者模型来验证信号量的同步机制。';
  const MAP = new Map([['m1', TEXT]]);

  it('命中则保留并回填 verified', () => {
    const { kept, dropped } = verifyQuotes([quote({ text: '生产者消费者模型' })], MAP, 0.9);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.verified).toBe('exact');
    expect(dropped).toHaveLength(0);
  });

  it('❗位置以程序计算结果为准，覆盖模型给的 char_start/char_end', () => {
    const bad = quote({
      text: '生产者消费者模型',
      location: { anchor: '§1', char_start: 99999, char_end: 100001 },
    });
    const { kept } = verifyQuotes([bad], MAP, 0.9);
    expect(kept[0]!.location.char_start).not.toBe(99999);
    expect(kept[0]!.location.char_end).not.toBe(100001);
    expect(TEXT.slice(kept[0]!.location.char_start!, kept[0]!.location.char_end!)).toContain('生产者消费者模型');
  });

  it('无法定位的摘录被丢弃', () => {
    const { kept, dropped } = verifyQuotes([quote({ text: '这段文字在原文里不存在' })], MAP, 0.9);
    expect(kept).toHaveLength(0);
    expect(dropped[0]!.reason).toBe('not_found');
  });

  it('材料不存在时标记 material_missing', () => {
    const { dropped } = verifyQuotes([quote({ material_id: 'missing' })], MAP, 0.9);
    expect(dropped[0]!.reason).toBe('material_missing');
  });

  it('空摘录标记 empty_quote', () => {
    const { dropped } = verifyQuotes([quote({ text: '  ' })], MAP, 0.9);
    expect(dropped[0]!.reason).toBe('empty_quote');
  });

  it('混合输入：部分保留部分丢弃', () => {
    const { kept, dropped } = verifyQuotes(
      [quote({ quote_id: 'q1', text: '生产者消费者模型' }), quote({ quote_id: 'q2', text: '不存在的段落' })],
      MAP,
      0.9,
    );
    expect(kept.map((q) => q.quote_id)).toEqual(['q1']);
    expect(dropped.map((d) => d.quote_id)).toEqual(['q2']);
  });

  it('丢弃记录可转成 7_parse_failures 条目', () => {
    const { dropped } = verifyQuotes([quote({ text: '不存在' })], MAP, 0.9);
    const failures = toParseFailures(dropped);
    expect(failures[0]!.code).toBe('QUOTE_NOT_VERIFIABLE');
    expect(failures[0]!.stage).toBe('quote_verify');
  });
});
