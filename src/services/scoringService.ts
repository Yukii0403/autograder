/**
 * 确定性算分引擎。
 *
 * 这是全系统里唯一不能出错的部分，因此：
 *   - 纯函数，无 IO、无模型、无时间依赖（时间由调用方传入）
 *   - 必须 100% 单测覆盖
 *
 * 规则（见 docs/技术方案.md 第 6 章）：
 *   raw_score_i    = weight_i × score_ratio(level_i)
 *   computed_total = 100 × Σ raw_score_i / Σ weight_i     仅统计 needs_human = false 的评分点
 *   final_total    = round_half_up(computed_total, 1) + Σ override_delta
 *
 * 三条不可动摇的约束：
 *   1. 模型不参与出分
 *   2. needs_human 的评分点不参与求和，其权重也不计入分母
 *   3. 程序永远不输出「及格 / 不及格」结论
 */
import type {
  Criterion,
  EvidenceExtraction,
  FinalGrade,
  GradeItem,
  GradeState,
  LevelMatch,
  Rubric,
} from '../schema';
import type { HumanReason } from '../schema';

export const LEVEL_ORDER = ['L1', 'L2', 'L3', 'L4'] as const;
export type LevelCode = (typeof LEVEL_ORDER)[number];

export const ENGINE_VERSION = 'calc-v1';

/**
 * 及格线边界带（分）。
 *
 * 落在及格线 ± 这个范围时，程序强制挂起、不输出任何及格结论 ——
 * 差 1 分及格与差 1 分不及格，对学生的意义完全不同，必须有人签字。
 */
export const PASS_LINE_BAND = 2.0;

/** 四舍五入到 1 位小数。避免 -0 这种反直觉的输出。 */
export function roundHalfUp1(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** 取某档位在该评分点下的系数；档位未定义时返回 null（视为无法判定）。 */
export function ratioOf(criterion: Criterion, level: LevelCode): number | null {
  return criterion.levels.find((l) => l.level === level)?.score_ratio ?? null;
}

/** 把档位压到封顶档以下（含）。用于 required 证据缺失的封顶规则。 */
export function capLevel(level: LevelCode, cap: LevelCode): LevelCode {
  return LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(cap) ? cap : level;
}

// ────────────────────────────────────────────────────────────
// 模型之前的前置规则：判定哪些评分点必须转人工
// ────────────────────────────────────────────────────────────

export interface HumanityRuleResult {
  needsHuman: boolean;
  reasons: HumanReason[];
  /** 命中封顶规则时为封顶档，否则为 null */
  cappedAt: LevelCode | null;
  missingRequired: string[];
}

/**
 * 是否存在**材料级**的解析失败。
 *
 * 必须排除 `stage === 'quote_verify'` 的记录：那一条表示
 * **引文回查丢弃了模型编造的摘录**，是模型侧的质量问题，不是材料的问题 ——
 * 材料本身读得好好的。
 *
 * 两者混在 `7_parse_failures` 同一个字段里，会造成两个错误归因：
 *   1. 程序侧：模型编一条引文，整项就被判「材料解析失败」并转人工，
 *      于是「护城河正常工作」反而表现为「系统故障」。
 *   2. 模型侧：它能看到这个字段，于是自己推断出 parse_failure 理由 ——
 *      而材料到底有没有问题，只有写这个字段的程序知道。
 *
 * 所以判据由本函数统一提供，程序与等级匹配两侧都用它。
 */
export function hasMaterialLevelFailure(evidence: EvidenceExtraction): boolean {
  return evidence['7_parse_failures'].some((f) => f.stage !== 'quote_verify');
}

/**
 * 在调用模型之前先跑这套规则。
 *
 * 目的是把「不需要模型判断」的两种情况提前拦掉：
 *   - 该评分点根本不该自动判定（judgment 类型）
 *   - 材料不足以判定（解析失败 / 未解决冲突 / 无证据 / required 缺失）
 *
 * 模型只在剩下的、真正需要判断的部分工作，从而压缩模型犯错的空间。
 */
export function applyHumanityRules(
  criterion: Criterion,
  evidence: EvidenceExtraction | undefined,
): HumanityRuleResult {
  const reasons: HumanReason[] = [];
  let needsHuman = false;
  let cappedAt: LevelCode | null = null;
  const missingRequired: string[] = [];

  // 1) 类型是 judgment —— 没有可判定的依据，直接转人工
  if (criterion.type === 'judgment') {
    return { needsHuman: true, reasons: ['criterion_is_judgment'], cappedAt: null, missingRequired };
  }

  // 2) 没有证据
  if (!evidence) {
    return { needsHuman: true, reasons: ['no_evidence'], cappedAt: null, missingRequired };
  }

  // 3) 材料级解析失败 → 证据不完整，不足以判定
  //    判据见 hasMaterialLevelFailure —— 必须排除「引文回查丢弃」，
  //    那是模型的错，不是材料的错。
  if (hasMaterialLevelFailure(evidence)) {
    reasons.push('parse_failure');
    needsHuman = true;
  }

  // 4) 存在未解决的表面冲突 → 不自动定级
  //    本期尚无「冲突已解决」的标记位，因此只要有冲突就挂起
  if (evidence['5_surface_conflicts'].length > 0) {
    reasons.push('unresolved_conflict');
    needsHuman = true;
  }

  // 5) required 证据未满足 → 封顶（注意：封顶不等于转人工）
  const requiredIds = new Set(
    criterion.evidence_requirements.filter((r) => r.required).map((r) => r.req_id),
  );
  for (const r of evidence['6_sufficiency'].req_results) {
    if (requiredIds.has(r.req_id) && !r.met) {
      missingRequired.push(r.req_id);
    }
  }
  if (missingRequired.length > 0) {
    cappedAt = criterion.cap_level_when_required_missing;
  }

  // 6) 证据不足且没有任何引文支撑 → 无法解释，转人工
  if (evidence['6_sufficiency'].status === 'insufficient' && evidence['2_found_quotes'].length === 0) {
    if (!reasons.includes('no_evidence')) reasons.push('no_evidence');
    needsHuman = true;
  }

  return { needsHuman, reasons: dedupe(reasons), cappedAt, missingRequired };
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// ────────────────────────────────────────────────────────────
// 算分
// ────────────────────────────────────────────────────────────

export interface OverrideInput {
  criterionId: string;
  level: LevelCode;
}

export interface ComputeGradeArgs {
  gradeId: string;
  submissionId: string;
  rubric: Rubric;
  matches: LevelMatch[];
  /** 教师改档。会改变该项的档位与系数，并记为 is_overridden */
  overrides?: OverrideInput[];
  /** 教师确认签名。传入即视为已确认 */
  confirmedBy?: string | null;
  /** 由调用方注入时间，保持引擎无时间依赖 */
  now: string;
}

export interface ComputeGradeResult {
  items: GradeItem[];
  computedTotal: number;
  finalTotal: number;
  overrideDelta: number;
  hasPendingItems: boolean;
  state: GradeState;
  /** 需要人工介入的评分点 id */
  pendingCriteria: string[];
  /** 总分落在及格线附近，必须人工确认 */
  borderline: boolean;
}

export function computeGrade(args: ComputeGradeArgs): ComputeGradeResult {
  const { rubric, matches, overrides = [], confirmedBy = null, now } = args;

  const matchByCriterion = new Map(matches.map((m) => [m.criterion_id, m]));
  const overrideByCriterion = new Map(overrides.map((o) => [o.criterionId, o]));

  const items: GradeItem[] = [];
  const pendingCriteria: string[] = [];

  let weightedSumAuto = 0;
  let weightSumAuto = 0;
  let weightedSumFinal = 0;
  let weightSumFinal = 0;

  for (const criterion of rubric.criteria) {
    const match = matchByCriterion.get(criterion.criterion_id);
    const override = overrideByCriterion.get(criterion.criterion_id);

    // ── 待人工：不进任何求和，权重也不进分母 ──
    if (!match || match.needs_human) {
      pendingCriteria.push(criterion.criterion_id);
      items.push({
        criterion_id: criterion.criterion_id,
        weight: criterion.weight,
        level: null,
        score_ratio: null,
        raw_score: 0,
        source: 'pending',
        is_overridden: false,
      });
      continue;
    }

    const isOverridden = Boolean(override);
    const autoLevel = match.matched_level;
    const finalLevel = override ? override.level : autoLevel;

    const autoRatio = ratioOf(criterion, autoLevel);
    const finalRatio = ratioOf(criterion, finalLevel);

    // 档位在细则里没有定义系数 → 视为无法判定，转人工
    if (autoRatio === null || finalRatio === null) {
      pendingCriteria.push(criterion.criterion_id);
      items.push({
        criterion_id: criterion.criterion_id,
        weight: criterion.weight,
        level: null,
        score_ratio: null,
        raw_score: 0,
        source: 'pending',
        is_overridden: false,
      });
      continue;
    }

    const autoRaw = criterion.weight * autoRatio;
    const finalRaw = criterion.weight * finalRatio;

    weightedSumAuto += autoRaw;
    weightSumAuto += criterion.weight;
    weightedSumFinal += finalRaw;
    weightSumFinal += criterion.weight;

    items.push({
      criterion_id: criterion.criterion_id,
      weight: criterion.weight,
      level: finalLevel,
      score_ratio: finalRatio,
      raw_score: roundHalfUp1(finalRaw),
      source: isOverridden ? 'human' : 'auto',
      is_overridden: isOverridden,
    });
  }

  // 分母为 0 说明没有任何评分点可自动判定 —— 不能除以 0，返回 0 并全部挂起
  const computedTotal = weightSumAuto > 0 ? roundHalfUp1((100 * weightedSumAuto) / weightSumAuto) : 0;
  const finalTotalRaw = weightSumFinal > 0 ? roundHalfUp1((100 * weightedSumFinal) / weightSumFinal) : 0;

  const hasPendingItems = pendingCriteria.length > 0;
  const overrideDelta = roundHalfUp1(finalTotalRaw - computedTotal);

  const borderline = Math.abs(finalTotalRaw - rubric.scoring.pass_line) <= PASS_LINE_BAND;

  const state: GradeState = confirmedBy
    ? 'teacher_confirmed'
    : hasPendingItems || borderline
      ? 'pending_teacher_confirm'
      : 'scored';

  // 引擎不接触时间以外的外部状态；now 由调用方注入（当前仅用于签名完整性）
  void now;

  return {
    items,
    computedTotal,
    finalTotal: finalTotalRaw,
    overrideDelta,
    hasPendingItems,
    state,
    pendingCriteria,
    borderline,
  };
}

/** 把引擎结果组装成完整的 FinalGrade 记录（补上 id 与版本等元信息）。 */
export function toFinalGrade(
  args: ComputeGradeArgs,
  result: ComputeGradeResult,
): FinalGrade {
  return {
    grade_id: args.gradeId,
    submission_id: args.submissionId,
    rubric_id: args.rubric.rubric_id,
    rubric_version: args.rubric.version,
    engine_version: ENGINE_VERSION,
    items: result.items,
    computed_total: result.computedTotal,
    final_total: result.finalTotal,
    override_delta: result.overrideDelta,
    has_pending_items: result.hasPendingItems,
    // 恒为 false —— 程序永不判定及格
    pass_judged: false,
    state: result.state,
    confirmed_by: args.confirmedBy ?? null,
    confirmed_at: args.confirmedBy ? args.now : null,
    calibration_signals: [],
  };
}
