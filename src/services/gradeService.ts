/**
 * 评阅编排服务（主链路）。
 *
 *   评分细则 + 材料
 *        ↓  逐评分点（**并发**）
 *   证据抽取（观察层）      —— evidenceService
 *        ↓
 *   等级匹配               —— levelMatchService
 *        ↓
 *   确定性算分             —— scoringService（纯函数，模型不参与）
 *        ↓
 *   教师确认与校准          —— M5
 *
 * ── 三条编排层面的硬规则 ──────────────────────────────────
 *
 *   1. **单个评分点失败不中断整批。**
 *      某评分点抽取失败（模型超时、结构不合法、材料缺失）时，只把**该项**
 *      转为待人工，其余评分点照常评完。理由是：一份报告里有一条评分点
 *      评不出来，不该导致整份报告评不了分 —— 那样教师连部分结果都拿不到。
 *
 *   2. **judgment 类型不进入自动流程，但必须被显式记录。**
 *      它们不是「被忽略了」，而是「被判定不该自动评」。dispositions 里
 *      会明确写出原因，否则教师会以为系统漏评了。
 *
 *   3. **评分点之间并发，不串行。**
 *      实测：单评分点端到端约 100 秒（抽取 + 匹配各一次模型调用），
 *      4 个评分点串行需 6 分钟以上，客户端在 174 秒处就断连了。
 *      必须澄清的是 —— **HTTP 触发的 Worker 没有 wall time 上限**（官方明确
 *      "No limit"，免费版同样），断开的是客户端一侧的网络层。
 *      并发后总时长约等于最慢的那一个评分点。
 *
 *      并发上限：Workers 对单个请求的出站连接上限是 6。每个阶段最多
 *      同时发出 targets.length 个请求（当前示例是 4 个），留有余量。
 *      注意等待网络不计入 CPU 时间，所以并发不会增加 CPU 开销。
 *
 * 本期不落库：inline 场景里没有 submission 记录，而 grade 表对 submission
 * 有外键。落库留给 M5（复核页需要按 submission 读取）。这是有意的取舍，
 * 不是遗漏 —— 见 docs/开发交接.md §2.1。
 */
import type { EnvConfig } from '../config';
import type { Logger } from '../logger';
import type {
  Criterion,
  EvidenceExtraction,
  FinalGrade,
  LevelMatch,
  Rubric,
} from '../schema';
import { extractEvidence } from './evidenceService';
import { matchLevel } from './levelMatchService';
import {
  applyHumanityRules,
  computeGrade,
  toFinalGrade,
  type LevelCode,
  type OverrideInput,
} from './scoringService';

/** 单个评分点的处置结果，用于向教师解释「这一项为什么没有分」。 */
export interface Disposition {
  criterionId: string;
  criterionName: string;
  /** auto：已自动定级；pending：待人工 */
  status: 'auto' | 'pending';
  level: LevelCode | null;
  reasons: string[];
  /** 程序干预记录（档位被压低、引用被丢弃等） */
  adjustments: string[];
  detail?: string;
}

export interface GradeArgs {
  config: EnvConfig;
  logger: Logger;
  rubric: Rubric;
  materialId: string;
  materialText: string;
  /** 教师改档，用于复核场景 */
  overrides?: OverrideInput[];
  /** 教师签名，传入即视为已确认 */
  confirmedBy?: string | null;
  /** 只跑指定评分点，便于调试 */
  criterionIds?: string[];
  now?: string;
}

export interface GradeResult {
  grade: FinalGrade;
  matches: LevelMatch[];
  evidence: EvidenceExtraction[];
  dispositions: Disposition[];
  /** 逐分解释：每个评分点的分是怎么来的，前端直接渲染 */
  explain: ScoreExplain[];
  stats: {
    criteriaCount: number;
    autoCount: number;
    pendingCount: number;
    quoteKept: number;
    quoteDropped: number;
    durationMs: number;
  };
}

export interface ScoreExplain {
  criterionId: string;
  criterionName: string;
  criterionType: string;
  weight: number;
  level: LevelCode | null;
  levelDescriptor: string | null;
  scoreRatio: number | null;
  rawScore: number;
  /** 该项在总分里的贡献（按归一化后的百分制） */
  normalizedContribution: number | null;
  source: 'auto' | 'human' | 'pending';
  isOverridden: boolean;
  /** 教师复核时可直接看到的程序干预说明 */
  adjustments: string[];
}

/** 单个评分点的完整产出。用返回值而不是回调汇总，避免并发写共享数组。 */
interface CriterionOutcome {
  disposition: Disposition;
  evidence: EvidenceExtraction | null;
  match: LevelMatch | null;
  /** 被引文回查丢弃的摘录数。用 extractEvidence 的原始计数，不从 parse_failures 反推 */
  quotesDropped: number;
}

export async function gradeSubmission(args: GradeArgs): Promise<GradeResult> {
  const { config, logger, rubric, materialId, materialText } = args;
  const now = args.now ?? new Date().toISOString();
  const startedAt = Date.now();

  const targets = rubric.criteria.filter((c) => {
    if (args.criterionIds && !args.criterionIds.includes(c.criterion_id)) return false;
    return true;
  });

  // 并发，但 Promise.all 保持数组顺序 —— 结果顺序仍与 rubric.criteria 一致
  const outcomes = await Promise.all(
    targets.map(async (criterion) => {
      try {
        return await evaluateCriterion({ config, logger, criterion, materialId, materialText, now });
      } catch (err) {
        // 兜底：evaluateCriterion 内部已分别处理了抽取与匹配的失败，
        // 这里防的是意料之外的异常（例如将来新增步骤忘了 try）。
        // 「单项失败不中断整批」是硬规则，多一道保险不亏。
        const msg = errorBrief(err);
        logger.error('grade.criterion_crashed', { criterionId: criterion.criterion_id, ...msg });
        return {
          disposition: {
            criterionId: criterion.criterion_id,
            criterionName: criterion.name,
            status: 'pending' as const,
            level: null,
            reasons: ['no_evidence'],
            adjustments: [],
            detail: `处理该评分点时发生未预期错误：${msg.message}`,
          },
          evidence: null,
          match: null,
          quotesDropped: 0,
        };
      }
    }),
  );

  const evidence: EvidenceExtraction[] = [];
  const matches: LevelMatch[] = [];
  const dispositions: Disposition[] = [];
  const adjustmentsByCriterion = new Map<string, string[]>();
  let quoteKept = 0;
  let quoteDropped = 0;

  for (const outcome of outcomes) {
    dispositions.push(outcome.disposition);
    adjustmentsByCriterion.set(outcome.disposition.criterionId, outcome.disposition.adjustments);
    if (outcome.evidence) {
      evidence.push(outcome.evidence);
      quoteKept += outcome.evidence['2_found_quotes'].length;
    }
    quoteDropped += outcome.quotesDropped;
    if (outcome.match) matches.push(outcome.match);
  }

  const gradeId = `gr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const submissionId = `inline_${materialId}`;
  const computeArgs = {
    gradeId,
    submissionId,
    rubric,
    matches,
    overrides: args.overrides ?? [],
    confirmedBy: args.confirmedBy ?? null,
    now,
  };

  const computed = computeGrade(computeArgs);
  const grade = toFinalGrade(computeArgs, computed);

  const explain = buildExplain(rubric, grade, dispositions, adjustmentsByCriterion);

  const summary = {
    criteriaCount: targets.length,
    autoCount: dispositions.filter((d) => d.status === 'auto').length,
    pendingCount: dispositions.filter((d) => d.status === 'pending').length,
    quoteKept,
    quoteDropped,
    durationMs: Date.now() - startedAt,
  };

  logger.info('grade.done', {
    rubricId: rubric.rubric_id,
    ...summary,
    computedTotal: grade.computed_total,
    finalTotal: grade.final_total,
    state: grade.state,
    borderline: computed.borderline,
  });

  return { grade, matches, evidence, dispositions, explain, stats: summary };
}

// ────────────────────────────────────────────────────────────
// 单评分点处理
// ────────────────────────────────────────────────────────────

interface EvaluateCriterionArgs {
  config: EnvConfig;
  logger: Logger;
  criterion: Criterion;
  materialId: string;
  materialText: string;
  now: string;
}

async function evaluateCriterion(args: EvaluateCriterionArgs): Promise<CriterionOutcome> {
  const { config, logger, criterion, materialId, materialText, now } = args;
  const startedAt = Date.now();

  const base: Disposition = {
    criterionId: criterion.criterion_id,
    criterionName: criterion.name,
    status: 'pending',
    level: null,
    reasons: [],
    adjustments: [],
  };

  // ── ① judgment 类型：没有可判定的依据，明确记录为「不该自动评」 ──
  if (criterion.type === 'judgment') {
    return {
      disposition: {
        ...base,
        reasons: ['criterion_is_judgment'],
        detail: '该评分点属于定性判断，系统不提供自动判定，请人工评阅',
      },
      evidence: null,
      match: null,
      quotesDropped: 0,
    };
  }

  // ── ② 证据抽取 ──────────────────────────────────────────
  let evidence: EvidenceExtraction;
  let quotesDropped = 0;
  try {
    const extracted = await extractEvidence({
      config,
      logger,
      submissionId: `inline_${materialId}`,
      criterion,
      materialId,
      materialText,
      now,
    });
    evidence = extracted.evidence;
    quotesDropped = extracted.quotes.dropped;
  } catch (err) {
    // 单项失败不中断整批 —— 见文件头「硬规则 1」
    const msg = errorBrief(err);
    logger.warn('grade.evidence_failed', { criterionId: criterion.criterion_id, ...msg });
    return {
      disposition: {
        ...base,
        reasons: ['no_evidence'],
        detail: `证据抽取失败：${msg.message}`,
      },
      evidence: null,
      match: null,
      quotesDropped: 0,
    };
  }

  // ── ③ 等级匹配 ──────────────────────────────────────────
  try {
    const matched = await matchLevel({ config, logger, criterion, evidence });
    logger.info('grade.criterion_done', {
      criterionId: criterion.criterion_id,
      ms: Date.now() - startedAt,
      level: matched.match.matched_level,
      needsHuman: matched.match.needs_human,
    });
    return {
      disposition: {
        ...base,
        status: matched.match.needs_human ? 'pending' : 'auto',
        level: matched.match.matched_level,
        reasons: matched.match.human_reasons,
        adjustments: matched.adjustments,
      },
      evidence,
      match: matched.match,
      quotesDropped,
    };
  } catch (err) {
    // 匹配失败时证据仍然有效，只是这一项定不了档 → 转人工。
    // detail 里带上具体原因：这一层最需要诊断信息，笼统写「失败」等于没写。
    const msg = errorBrief(err);
    logger.warn('grade.match_failed', { criterionId: criterion.criterion_id, ...msg });
    return {
      disposition: {
        ...base,
        reasons: ['no_evidence'],
        detail: `等级判定失败：${msg.message}（证据已保留，该项转人工）`,
        adjustments: buildRuleAdjustments(criterion, evidence),
      },
      evidence,
      match: null,
      quotesDropped,
    };
  }
}

/** 把异常压成可读的一行 —— 名字 + 消息，避免把整个 stack 塞进响应。 */
function errorBrief(err: unknown): { name: string; message: string } {
  const e = err as { name?: string; message?: string };
  return {
    name: e?.name ?? 'UnknownError',
    message: e?.message ?? String(err),
  };
}

/** 匹配阶段失败时，仍把程序规则的干预结论留给教师。 */
function buildRuleAdjustments(criterion: Criterion, evidence: EvidenceExtraction): string[] {
  const rules = applyHumanityRules(criterion, evidence);
  return rules.missingRequired.length > 0
    ? [`required 证据 ${rules.missingRequired.join('、')} 未满足，封顶至 ${criterion.cap_level_when_required_missing}`]
    : [];
}

// ────────────────────────────────────────────────────────────
// 逐分解释
// ────────────────────────────────────────────────────────────

/**
 * 把「这一分是怎么来的」拼成前端可直接渲染的结构。
 *
 * 这是产品的核心承诺之一：**教师能看到每一分的依据**，
 * 而不是一个来路不明的总分。缺少这一层，产品在申诉场景里站不住。
 */
function buildExplain(
  rubric: Rubric,
  grade: FinalGrade,
  dispositions: Disposition[],
  adjustmentsByCriterion: Map<string, string[]>,
): ScoreExplain[] {
  const dispositionById = new Map(dispositions.map((d) => [d.criterionId, d]));

  // 可自动判定的权重之和，用于把 raw_score 换算成百分制贡献
  const autoWeightSum = grade.items
    .filter((i) => i.source !== 'pending')
    .reduce((sum, i) => sum + i.weight, 0);

  return rubric.criteria.map((criterion) => {
    const item = grade.items.find((i) => i.criterion_id === criterion.criterion_id);
    const disposition = dispositionById.get(criterion.criterion_id);
    const levelDescriptor = item?.level
      ? (criterion.levels.find((l) => l.level === item.level)?.descriptor ?? null)
      : null;

    const rawScore = item?.raw_score ?? 0;

    return {
      criterionId: criterion.criterion_id,
      criterionName: criterion.name,
      criterionType: criterion.type,
      weight: criterion.weight,
      level: item?.level ?? null,
      levelDescriptor,
      scoreRatio: item?.score_ratio ?? null,
      rawScore,
      normalizedContribution:
        autoWeightSum > 0 && item?.source !== 'pending'
          ? Math.round(((100 * rawScore) / autoWeightSum) * 10) / 10
          : null,
      source: item?.source ?? 'pending',
      isOverridden: item?.is_overridden ?? false,
      adjustments: adjustmentsByCriterion.get(criterion.criterion_id) ?? disposition?.adjustments ?? [],
    };
  });
}
