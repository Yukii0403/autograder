/**
 * 等级匹配的「程序裁量权」测试。
 *
 * 这里只测纯函数 reconcileLevelMatch —— 它是模型建议与最终判定之间的那道闸门。
 * 不测模型调用（那需要真实 API，属于集成测试）。
 *
 * 重点锁住四件事：
 *   ① 引用不存在时被丢弃
 *   ② 封顶由程序强制施加，模型说不需要也照压
 *   ③ needs_human 是并集，模型不能单方面把需要人工的项变成自动
 *   ④ 无依据的档位不予采信
 */
import { describe, it, expect } from 'vitest';
import type { Criterion, EvidenceExtraction, FoundQuote } from '../src/schema';
import { reconcileLevelMatch, buildCapRuleText } from '../src/services/levelMatchService';
import { applyHumanityRules } from '../src/services/scoringService';

// ── 夹具 ────────────────────────────────────────────────────

const CRITERION: Criterion = {
  criterion_id: 'c2',
  name: '代码实现与功能正确性',
  weight: 35,
  type: 'execution',
  evidence_requirements: [
    { req_id: 'r3', kind: 'code_symbol', target: 'wait|waitpid', required: true },
    { req_id: 'r4', kind: 'code_symbol', target: 'signal|sigaction', required: false },
  ],
  levels: [
    { level: 'L1', score_ratio: 0.2, descriptor: '无法完成基本功能' },
    { level: 'L2', score_ratio: 0.5, descriptor: '核心功能可用，存在明确缺陷' },
    { level: 'L3', score_ratio: 0.8, descriptor: '主流程正确，个别边界未覆盖' },
    { level: 'L4', score_ratio: 1, descriptor: '全部功能实现正确' },
  ],
  cap_level_when_required_missing: 'L2',
};

function quote(id: string): FoundQuote {
  return {
    quote_id: id,
    material_id: 'm1',
    text: '父进程会回收全部子进程',
    location: { anchor: '§3 第2段' },
    verified: 'exact',
  };
}

function makeEvidence(over: Partial<EvidenceExtraction> = {}): EvidenceExtraction {
  return {
    evidence_id: 'ev_test',
    submission_id: 's1',
    criterion_id: 'c2',
    extractor_version: 'ev-v1.0',
    prompt_version: 'b2-v1',
    model: 'test-model',
    '1_searched_materials': [],
    '2_found_quotes': [],
    '3_locations_index': [],
    '4_not_found': [],
    '5_surface_conflicts': [],
    '6_sufficiency': {
      status: 'sufficient',
      req_results: [{ req_id: 'r3', met: true }],
      matched_by: 'program_rule',
      rule_version: 'suf-v1',
    },
    '7_parse_failures': [],
    runtime_probe: { status: 'not_executed', sandbox_ref: null },
    extracted_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** 模型建议的输入类型（从 reconcileLevelMatch 的签名推导，避免手写重复）。 */
type ModelInput = Parameters<typeof reconcileLevelMatch>[0]['model'];

/** 默认的模型建议：给 L4，引用真实的 q1。 */
function makeModel(over: Partial<ModelInput> = {}): ModelInput {
  return {
    matched_level: 'L4',
    evidence_refs: ['q1'],
    missing_refs: [],
    rule_applied: null,
    alternatives: [],
    needs_human: false,
    human_reasons: [],
    ...over,
  };
}

function reconcile(evidence: EvidenceExtraction, model: ModelInput) {
  return reconcileLevelMatch({
    criterion: CRITERION,
    evidence,
    rules: applyHumanityRules(CRITERION, evidence),
    model,
  });
}

// ── ① 引用核对 ──────────────────────────────────────────────

describe('引用核对', () => {
  it('引用了不存在的 quote_id 时被丢弃', () => {
    const evidence = makeEvidence({ '2_found_quotes': [quote('q1')] });
    const { match, adjustments } = reconcile(evidence, makeModel({ evidence_refs: ['q1', 'q99'] }));

    expect(match.evidence_refs).toEqual(['q1']);
    expect(adjustments.some((a) => a.includes('q99'))).toBe(true);
  });

  it('引用了不存在的 expectation_id 时同样被丢弃', () => {
    const evidence = makeEvidence({
      '2_found_quotes': [quote('q1')],
      '4_not_found': [
        { expectation_id: 'r3', expected: 'wait 调用', searched_scope: ['report'], status: 'not_found' },
      ],
    });
    const { match } = reconcile(evidence, makeModel({ missing_refs: ['r3', 'rX'] }));

    expect(match.missing_refs).toEqual(['r3']);
  });

  it('全部引用都被丢弃且未报缺失时，判定为依据不足', () => {
    const evidence = makeEvidence({ '2_found_quotes': [] });
    const { match } = reconcile(evidence, makeModel({ evidence_refs: ['ghost'] }));

    expect(match.evidence_refs).toEqual([]);
    expect(match.needs_human).toBe(true);
    expect(match.human_reasons).toContain('no_evidence');
  });
});

// ── ② 封顶由程序强制 ────────────────────────────────────────

describe('封顶规则', () => {
  const missingRequired = makeEvidence({
    '2_found_quotes': [quote('q1')],
    '6_sufficiency': {
      status: 'insufficient',
      req_results: [{ req_id: 'r3', met: false }],
      matched_by: 'program_rule',
      rule_version: 'suf-v1',
    },
  });

  it('模型给 L4 但 required 缺失时，程序强制压到封顶档', () => {
    const { match, adjustments } = reconcile(missingRequired, makeModel({ matched_level: 'L4' }));

    expect(match.matched_level).toBe('L2');
    expect(match.rule_applied).toBe('cap_level_when_required_missing');
    expect(adjustments.some((a) => a.includes('L4') && a.includes('L2'))).toBe(true);
  });

  it('模型给出的档位本来就不高于封顶档时，不产生调整记录', () => {
    const { match, adjustments } = reconcile(missingRequired, makeModel({ matched_level: 'L1' }));

    expect(match.matched_level).toBe('L1');
    expect(adjustments).toEqual([]);
  });

  it('模型声称不需要封顶也没用 —— 程序说了算', () => {
    const { match } = reconcile(
      missingRequired,
      makeModel({ matched_level: 'L4', rule_applied: 'no_cap_needed' }),
    );

    expect(match.matched_level).toBe('L2');
    expect(match.rule_applied).toBe('cap_level_when_required_missing');
  });

  it('压低档位时把模型的原始建议留在 alternatives 里', () => {
    const { match } = reconcile(missingRequired, makeModel({ matched_level: 'L4' }));

    expect(match.alternatives.some((a) => a.level === 'L4')).toBe(true);
  });

  it('required 全部满足时不下压', () => {
    const ok = makeEvidence({ '2_found_quotes': [quote('q1')] });
    const { match } = reconcile(ok, makeModel({ matched_level: 'L4' }));

    expect(match.matched_level).toBe('L4');
    expect(match.rule_applied).toBeNull();
    expect(match.needs_human).toBe(false);
  });

  it('封顶规则文本在无缺失时明确说明无限制', () => {
    const text = buildCapRuleText(CRITERION, applyHumanityRules(CRITERION, makeEvidence()));
    expect(text).toContain('无封顶限制');
  });
});

// ── ③ needs_human 是并集 ───────────────────────────────────

describe('needs_human 并集', () => {
  it('程序判定需要人工时，模型说不需要也无效', () => {
    const conflicted = makeEvidence({
      '2_found_quotes': [quote('q1')],
      '5_surface_conflicts': [
        {
          conflict_id: 'x1',
          nature: 'factual_mismatch',
          claim: '父进程回收全部子进程',
          claim_location: { anchor: '§3' },
          observed: '代码中无 wait 调用',
          observed_location: { anchor: 'list.1' },
        },
      ],
    });

    const { match } = reconcile(conflicted, makeModel({ needs_human: false }));

    expect(match.needs_human).toBe(true);
    expect(match.human_reasons).toContain('unresolved_conflict');
  });

  it('模型判定需要人工时，程序规则不反对也保留', () => {
    const ok = makeEvidence({ '2_found_quotes': [quote('q1')] });
    const { match } = reconcile(ok, makeModel({ needs_human: true, human_reasons: ['no_evidence'] }));

    expect(match.needs_human).toBe(true);
    expect(match.human_reasons).toContain('no_evidence');
  });

  it('judgment 类型的评分点必然需要人工', () => {
    const judgment: Criterion = { ...CRITERION, type: 'judgment' };
    const rules = applyHumanityRules(judgment, makeEvidence());

    expect(rules.needsHuman).toBe(true);
    expect(rules.reasons).toContain('criterion_is_judgment');
  });
});

// ── ④ 档位合法性 ───────────────────────────────────────────

describe('档位合法性', () => {
  it('模型给出细则未定义的档位时转人工', () => {
    const evidence = makeEvidence({ '2_found_quotes': [quote('q1')] });
    // 细则里没有定义 L0，模型若给出会被拦
    const { match, adjustments } = reconcile(
      evidence,
      makeModel({ matched_level: 'L0' as never }),
    );

    expect(match.needs_human).toBe(true);
    expect(match.human_reasons).toContain('level_undefined');
    expect(adjustments.some((a) => a.includes('L0'))).toBe(true);
  });
});

// ── ⑤ 原样采纳 ─────────────────────────────────────────────

describe('原样采纳', () => {
  it('模型建议合规时不产生任何调整记录', () => {
    const evidence = makeEvidence({ '2_found_quotes': [quote('q1')] });
    const { match, adjustments } = reconcile(
      evidence,
      makeModel({ matched_level: 'L3', evidence_refs: ['q1'] }),
    );

    expect(adjustments).toEqual([]);
    expect(match.matched_level).toBe('L3');
    expect(match.needs_human).toBe(false);
    expect(match.evidence_refs).toEqual(['q1']);
  });

  it('输出里带上 prompt 版本，便于历史结果归因', () => {
    const evidence = makeEvidence({ '2_found_quotes': [quote('q1')] });
    const { match } = reconcile(evidence, makeModel());

    // 只校验格式而不锁死具体版本 —— 否则每次改 prompt 都要动测试，
    // 久而久之就会有人图省事把断言删掉。
    expect(match.prompt_version).toMatch(/^b3-v\d+$/);
  });
});

// ── ⑥ human_reasons 过滤 ───────────────────────────────────

describe('human_reasons 过滤', () => {
  it('闭集内的理由被保留', () => {
    // 注意不能用 parse_failure 测这条 —— 它已归程序裁定（见下一条用例），
    // 模型自报会被过滤。这里用一条纯模型侧的理由。
    const evidence = makeEvidence({ '2_found_quotes': [quote('q1')] });
    const { match } = reconcile(
      evidence,
      makeModel({ needs_human: true, human_reasons: ['required_evidence_missing'] }),
    );

    expect(match.human_reasons).toContain('required_evidence_missing');
  });

  it('❗闭集外的理由被过滤，而不是拒收整份判定', () => {
    // 线上实测：模型给出 required_evidence_not_met，导致 3 次重试全部失败、
    // 该项整项转人工；而同一批里 needs_human=false 的评分点却正常通过
    // （空数组不校验元素）。这种「部分成功部分失败」最难排查。
    const evidence = makeEvidence({ '2_found_quotes': [quote('q1')] });
    const { match, adjustments } = reconcile(
      evidence,
      makeModel({
        matched_level: 'L3',
        needs_human: true,
        human_reasons: ['required_evidence_not_met'],
      }),
    );

    // 判定本身必须保住 —— 理由标签只是元数据，不该有否决权
    expect(match.matched_level).toBe('L3');
    expect(match.needs_human).toBe(true);
    // 无法识别的标签被丢弃并留痕
    expect(match.human_reasons).not.toContain('required_evidence_not_met');
    expect(adjustments.some((a) => a.includes('required_evidence_not_met'))).toBe(true);
  });

  it('模型给了垃圾理由时，程序侧的理由仍然保留', () => {
    const conflicted = makeEvidence({
      '2_found_quotes': [quote('q1')],
      '5_surface_conflicts': [
        {
          conflict_id: 'x1',
          nature: 'factual_mismatch',
          claim: '父进程回收全部子进程',
          claim_location: { anchor: '§3' },
          observed: '代码中无 wait 调用',
          observed_location: { anchor: 'list.1' },
        },
      ],
    });

    const { match } = reconcile(
      conflicted,
      makeModel({ needs_human: true, human_reasons: ['我自己编的理由'] }),
    );

    expect(match.human_reasons).toContain('unresolved_conflict');
    expect(match.human_reasons).not.toContain('我自己编的理由');
  });

  it('❗模型自报 parse_failure 但材料没问题时被过滤', () => {
    // 模型能看到 7_parse_failures 字段，于是会推断"材料解析失败"。
    // 但那个字段里混着「引文回查丢弃」（模型侧问题），材料本身是好的 ——
    // 材料到底有没有问题，只有写这个字段的程序知道。
    const evidence = makeEvidence({
      '2_found_quotes': [quote('q1')],
      '7_parse_failures': [
        { stage: 'quote_verify', code: 'QUOTE_NOT_VERIFIABLE', recoverable: true },
      ],
    });

    const { match, adjustments } = reconcile(
      evidence,
      makeModel({ needs_human: true, human_reasons: ['parse_failure'] }),
    );

    expect(match.human_reasons).not.toContain('parse_failure');
    expect(adjustments.some((a) => a.includes('parse_failure'))).toBe(true);
  });

  it('材料真的解析失败时，parse_failure 被采纳', () => {
    const evidence = makeEvidence({
      '2_found_quotes': [quote('q1')],
      '7_parse_failures': [{ stage: 'pdf', code: 'EMPTY_TEXT_LAYER', recoverable: true }],
    });

    const { match } = reconcile(
      evidence,
      makeModel({ needs_human: true, human_reasons: ['parse_failure'] }),
    );

    expect(match.human_reasons).toContain('parse_failure');
  });
});
