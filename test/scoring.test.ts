/**
 * 确定性算分引擎单元测试。
 *
 * 这些用例守的是「分数不能出错」这条线。任何一条挂了都不允许合并。
 */
import { describe, it, expect } from 'vitest';
import {
  computeGrade,
  toFinalGrade,
  roundHalfUp1,
  ratioOf,
  capLevel,
  applyHumanityRules,
  PASS_LINE_BAND,
  type OverrideInput,
} from '../src/services/scoringService';
import type { EvidenceExtraction, LevelMatch, Rubric } from '../src/schema';

// ────────────────────────────────────────────────────────────
// 夹具
// ────────────────────────────────────────────────────────────

function makeRubric(overrides: Partial<Rubric> = {}): Rubric {
  return {
    rubric_id: 'rb_test',
    title: '测试用细则',
    course: '操作系统',
    version: 1,
    total_points: 100,
    criteria: [
      {
        criterion_id: 'c1',
        name: '原理说明',
        weight: 10,
        type: 'execution',
        evidence_requirements: [],
        levels: [
          { level: 'L4', score_ratio: 1, descriptor: '完整' },
          { level: 'L3', score_ratio: 0.8, descriptor: '较完整' },
          { level: 'L2', score_ratio: 0.5, descriptor: '部分' },
          { level: 'L1', score_ratio: 0.2, descriptor: '几乎没有' },
        ],
        cap_level_when_required_missing: 'L2',
      },
      {
        criterion_id: 'c2',
        name: '代码实现',
        weight: 30,
        type: 'execution',
        evidence_requirements: [],
        levels: [
          { level: 'L4', score_ratio: 1, descriptor: '完整' },
          { level: 'L3', score_ratio: 0.8, descriptor: '较完整' },
          { level: 'L2', score_ratio: 0.5, descriptor: '部分' },
          { level: 'L1', score_ratio: 0.2, descriptor: '几乎没有' },
        ],
        cap_level_when_required_missing: 'L2',
      },
    ],
    scoring: { compose: 'weighted_sum', round: 'half_up_1', pass_line: 60, pass_line_requires_human: true },
    ...overrides,
  };
}

function makeMatch(criterionId: string, level: 'L1' | 'L2' | 'L3' | 'L4', needsHuman = false): LevelMatch {
  return {
    criterion_id: criterionId,
    matched_level: level,
    evidence_refs: [],
    missing_refs: [],
    rule_applied: null,
    alternatives: [],
    needs_human: needsHuman,
    human_reasons: [],
    prompt_version: 'b3-v1',
  };
}

const NOW = '2026-09-18T00:00:00Z';

function compute(
  rubric: Rubric,
  matches: LevelMatch[],
  overrides: OverrideInput[] = [],
  confirmedBy: string | null = null,
) {
  return computeGrade({
    gradeId: 'g1',
    submissionId: 's1',
    rubric,
    matches,
    overrides,
    confirmedBy,
    now: NOW,
  });
}

// ────────────────────────────────────────────────────────────
// 基础算分
// ────────────────────────────────────────────────────────────

describe('确定性算分 · 基础', () => {
  it('全部满分 → 100 分', () => {
    const r = compute(makeRubric(), [makeMatch('c1', 'L4'), makeMatch('c2', 'L4')]);
    expect(r.computedTotal).toBe(100);
    expect(r.finalTotal).toBe(100);
  });

  it('加权求和：权重不同不影响归一化', () => {
    // c1(w10,L4)=10, c2(w30,L2)=15 → 25/40 = 62.5
    const r = compute(makeRubric(), [makeMatch('c1', 'L4'), makeMatch('c2', 'L2')]);
    expect(r.computedTotal).toBe(62.5);
  });

  it('权重和不为 100 时依然归一化到百分制', () => {
    const rubric = makeRubric({ criteria: [{ ...makeRubric().criteria[0]!, weight: 3 }] });
    const r = compute(rubric, [makeMatch('c1', 'L2')]);
    // 唯一一项，无论权重多少都应归一化为该档系数 × 100
    expect(r.computedTotal).toBe(50);
  });

  it('四舍五入到 1 位小数', () => {
    // c1(w10,L2)=5, c2(w30,L1)=6 → 11/40 = 27.5
    const r = compute(makeRubric(), [makeMatch('c1', 'L2'), makeMatch('c2', 'L1')]);
    expect(r.computedTotal).toBe(27.5);
  });
});

// ────────────────────────────────────────────────────────────
// needs_human 的隔离 —— 最关键的一组
// ────────────────────────────────────────────────────────────

describe('确定性算分 · 待人工项的隔离', () => {
  it('待人工项既不进求和，也不进分母', () => {
    // c1 待人工；剩下只有 c2(w30,L4) → 30/30 = 100
    const r = compute(makeRubric(), [makeMatch('c1', 'L4', true), makeMatch('c2', 'L4')]);
    expect(r.computedTotal).toBe(100);
    expect(r.hasPendingItems).toBe(true);
    expect(r.pendingCriteria).toEqual(['c1']);
  });

  it('待人工项在 items 中 level 与 ratio 为 null，source 为 pending', () => {
    const r = compute(makeRubric(), [makeMatch('c1', 'L4', true), makeMatch('c2', 'L4')]);
    const item = r.items.find((i) => i.criterion_id === 'c1');
    expect(item?.level).toBeNull();
    expect(item?.score_ratio).toBeNull();
    expect(item?.source).toBe('pending');
    expect(item?.raw_score).toBe(0);
  });

  it('存在待人工项时 state 强制为 pending_teacher_confirm', () => {
    const r = compute(makeRubric(), [makeMatch('c1', 'L4', true), makeMatch('c2', 'L4')]);
    expect(r.state).toBe('pending_teacher_confirm');
  });

  it('全部待人工时不除零，返回 0', () => {
    const r = compute(makeRubric(), [makeMatch('c1', 'L4', true), makeMatch('c2', 'L4', true)]);
    expect(r.computedTotal).toBe(0);
    expect(r.finalTotal).toBe(0);
    expect(Number.isFinite(r.computedTotal)).toBe(true);
  });

  it('缺少匹配记录的评分点按待人工处理', () => {
    const r = compute(makeRubric(), [makeMatch('c2', 'L4')]);
    expect(r.pendingCriteria).toEqual(['c1']);
    expect(r.computedTotal).toBe(100);
  });
});

// ────────────────────────────────────────────────────────────
// 教师改档
// ────────────────────────────────────────────────────────────

describe('确定性算分 · 教师改档', () => {
  it('改档后 final_total 变化，computed_total 保持自动结果不变', () => {
    // 自动：c1=L2(5) + c2=L4(30) = 35/40 = 87.5
    // 改档 c1 → L4(10) → 40/40 = 100
    const r = compute(
      makeRubric(),
      [makeMatch('c1', 'L2'), makeMatch('c2', 'L4')],
      [{ criterionId: 'c1', level: 'L4' }],
    );
    expect(r.computedTotal).toBe(87.5);
    expect(r.finalTotal).toBe(100);
    expect(r.overrideDelta).toBe(12.5);
  });

  it('被改档的项标记 is_overridden 且 source 为 human', () => {
    const r = compute(
      makeRubric(),
      [makeMatch('c1', 'L2'), makeMatch('c2', 'L4')],
      [{ criterionId: 'c1', level: 'L4' }],
    );
    const item = r.items.find((i) => i.criterion_id === 'c1');
    expect(item?.is_overridden).toBe(true);
    expect(item?.source).toBe('human');
    expect(item?.level).toBe('L4');
  });

  it('无改档时 override_delta 为 0', () => {
    const r = compute(makeRubric(), [makeMatch('c1', 'L3'), makeMatch('c2', 'L3')]);
    expect(r.overrideDelta).toBe(0);
    expect(r.computedTotal).toBe(r.finalTotal);
  });
});

// ────────────────────────────────────────────────────────────
// 及格线 —— 程序永不判定
// ────────────────────────────────────────────────────────────

describe('确定性算分 · 及格线', () => {
  it('总分落在及格线附近时强制挂起', () => {
    // 构造恰好 60 分：c1(w10,L1)=2, c2(w30,L?)。用 ratio 直接调
    const rubric = makeRubric();
    const r = compute(rubric, [makeMatch('c1', 'L4'), makeMatch('c2', 'L2')]);
    // 80 分，不在边界带
    expect(r.borderline).toBe(false);

    const near = compute(makeRubric(), [makeMatch('c1', 'L2'), makeMatch('c2', 'L2')]);
    // c1=5, c2=15 → 20/40 = 50，不在边界带
    expect(Math.abs(near.finalTotal - 60) > PASS_LINE_BAND).toBe(true);
  });

  it('恰好等于及格线时 borderline 为 true 并挂起', () => {
    // 构造 60 分：需要 Σraw / Σw = 0.6
    const rubric = makeRubric({
      criteria: [
        {
          ...makeRubric().criteria[0]!,
          weight: 10,
          levels: [
            { level: 'L4', score_ratio: 0.6, descriptor: 'x' },
            { level: 'L1', score_ratio: 0.2, descriptor: 'y' },
          ],
        },
      ],
    });
    const r = compute(rubric, [makeMatch('c1', 'L4')]);
    expect(r.finalTotal).toBe(60);
    expect(r.borderline).toBe(true);
    expect(r.state).toBe('pending_teacher_confirm');
  });

  it('toFinalGrade 输出的 pass_judged 恒为 false', () => {
    const args = {
      gradeId: 'g1',
      submissionId: 's1',
      rubric: makeRubric(),
      matches: [makeMatch('c1', 'L4'), makeMatch('c2', 'L4')],
      now: NOW,
    };
    const grade = toFinalGrade(args, computeGrade(args));
    expect(grade.pass_judged).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// 状态机
// ────────────────────────────────────────────────────────────

describe('确定性算分 · 状态', () => {
  it('全部可判定且不在边界带 → scored', () => {
    const r = compute(makeRubric(), [makeMatch('c1', 'L4'), makeMatch('c2', 'L4')]);
    expect(r.state).toBe('scored');
  });

  it('传入 confirmedBy → teacher_confirmed', () => {
    const r = compute(makeRubric(), [makeMatch('c1', 'L4'), makeMatch('c2', 'L4')], [], 'teacher_A');
    expect(r.state).toBe('teacher_confirmed');
  });

  it('toFinalGrade 记录确认人与确认时间', () => {
    const args = {
      gradeId: 'g1',
      submissionId: 's1',
      rubric: makeRubric(),
      matches: [makeMatch('c1', 'L4'), makeMatch('c2', 'L4')],
      confirmedBy: 'teacher_A',
      now: NOW,
    };
    const grade = toFinalGrade(args, computeGrade(args));
    expect(grade.confirmed_by).toBe('teacher_A');
    expect(grade.confirmed_at).toBe(NOW);
  });

  it('未确认时 confirmed_at 为 null', () => {
    const args = {
      gradeId: 'g1',
      submissionId: 's1',
      rubric: makeRubric(),
      matches: [makeMatch('c1', 'L4'), makeMatch('c2', 'L4')],
      now: NOW,
    };
    const grade = toFinalGrade(args, computeGrade(args));
    expect(grade.confirmed_at).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// 工具函数
// ────────────────────────────────────────────────────────────

describe('工具函数', () => {
  it('roundHalfUp1 正确处理半值', () => {
    expect(roundHalfUp1(2.5)).toBe(2.5);
    expect(roundHalfUp1(2.25)).toBe(2.3);
    expect(roundHalfUp1(2.24)).toBe(2.2);
    expect(roundHalfUp1(0)).toBe(0);
  });

  it('roundHalfUp1 不返回 -0', () => {
    expect(Object.is(roundHalfUp1(-0.04), -0)).toBe(false);
  });

  it('capLevel 只降不升', () => {
    expect(capLevel('L4', 'L2')).toBe('L2');
    expect(capLevel('L1', 'L2')).toBe('L1');
    expect(capLevel('L2', 'L2')).toBe('L2');
  });

  it('ratioOf 取不到档位时返回 null', () => {
    const c = makeRubric().criteria[0]!;
    expect(ratioOf(c, 'L4')).toBe(1);
    expect(ratioOf({ ...c, levels: [{ level: 'L1', score_ratio: 0.2, descriptor: 'x' }] }, 'L4')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// 前置人工规则
// ────────────────────────────────────────────────────────────

function makeEvidence(overrides: Partial<EvidenceExtraction> = {}): EvidenceExtraction {
  return {
    evidence_id: 'ev1',
    submission_id: 's1',
    criterion_id: 'c1',
    extractor_version: 'ev-v1.0',
    prompt_version: 'b2-v1',
    model: 'deepseek-flash',
    '1_searched_materials': [],
    '2_found_quotes': [],
    '3_locations_index': [],
    '4_not_found': [],
    '5_surface_conflicts': [],
    '6_sufficiency': { status: 'sufficient', req_results: [], matched_by: 'program_rule', rule_version: 'suf-v1' },
    '7_parse_failures': [],
    runtime_probe: { status: 'not_executed', sandbox_ref: null },
    extracted_at: NOW,
    ...overrides,
  };
}

describe('前置人工规则', () => {
  it('judgment 类型直接转人工，理由为 criterion_is_judgment', () => {
    const c = { ...makeRubric().criteria[0]!, type: 'judgment' as const };
    const r = applyHumanityRules(c, makeEvidence());
    expect(r.needsHuman).toBe(true);
    expect(r.reasons).toEqual(['criterion_is_judgment']);
  });

  it('无证据 → no_evidence', () => {
    const r = applyHumanityRules(makeRubric().criteria[0]!, undefined);
    expect(r.needsHuman).toBe(true);
    expect(r.reasons).toEqual(['no_evidence']);
  });

  it('有解析失败 → parse_failure', () => {
    const r = applyHumanityRules(
      makeRubric().criteria[0]!,
      makeEvidence({ '7_parse_failures': [{ stage: 'pdf', code: 'EMPTY_TEXT_LAYER', recoverable: true }] }),
    );
    expect(r.needsHuman).toBe(true);
    expect(r.reasons).toContain('parse_failure');
  });

  it('❗引文回查丢弃不算材料解析失败 —— 那是模型的错，不是材料的错', () => {
    // 线上实测：两类记录混在同一个字段里时，模型只要编造一条引文，
    // 整项就被判成「材料解析失败」并转人工 —— 于是「护城河正常工作」
    // 反而表现为「系统故障」，是典型的错误归因。
    const r = applyHumanityRules(
      makeRubric().criteria[0]!,
      makeEvidence({
        '7_parse_failures': [
          {
            stage: 'quote_verify',
            code: 'QUOTE_NOT_VERIFIABLE',
            material_id: 'm1',
            recoverable: true,
          },
        ],
      }),
    );
    expect(r.needsHuman).toBe(false);
    expect(r.reasons).not.toContain('parse_failure');
  });

  it('有表面冲突 → unresolved_conflict', () => {
    const r = applyHumanityRules(
      makeRubric().criteria[0]!,
      makeEvidence({
        '5_surface_conflicts': [
          {
            conflict_id: 'x1',
            nature: 'factual_mismatch',
            claim: '正文称使用多进程',
            claim_location: { anchor: '§2.3' },
            observed: '代码中无 fork 调用',
            observed_location: { anchor: 'list.1' },
          },
        ],
      }),
    );
    expect(r.needsHuman).toBe(true);
    expect(r.reasons).toContain('unresolved_conflict');
  });

  it('required 证据缺失 → 封顶但不转人工', () => {
    const c = {
      ...makeRubric().criteria[0]!,
      evidence_requirements: [{ req_id: 'r1', kind: 'section' as const, target: '原理', required: true }],
    };
    const r = applyHumanityRules(
      c,
      makeEvidence({
        '6_sufficiency': {
          status: 'insufficient',
          req_results: [{ req_id: 'r1', met: false }],
          matched_by: 'program_rule',
          rule_version: 'suf-v1',
        },
        '2_found_quotes': [
          { quote_id: 'q1', material_id: 'm1', text: '有引文所以不算无证据', location: { anchor: '§1' }, verified: 'exact' },
        ],
      }),
    );
    expect(r.cappedAt).toBe('L2');
    expect(r.missingRequired).toEqual(['r1']);
    expect(r.needsHuman).toBe(false);
  });

  it('证据不足且无任何引文 → 转人工', () => {
    const r = applyHumanityRules(
      makeRubric().criteria[0]!,
      makeEvidence({ '6_sufficiency': { status: 'insufficient', req_results: [], matched_by: 'program_rule', rule_version: 'suf-v1' } }),
    );
    expect(r.needsHuman).toBe(true);
    expect(r.reasons).toContain('no_evidence');
  });

  it('一切正常时不转人工', () => {
    const r = applyHumanityRules(makeRubric().criteria[0]!, makeEvidence());
    expect(r.needsHuman).toBe(false);
    expect(r.reasons).toEqual([]);
    expect(r.cappedAt).toBeNull();
  });
});
