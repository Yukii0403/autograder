/**
 * 等级匹配服务（阶段 C）。
 *
 * 职责：把「已核验的事实」（观察层）映射到「该评分点的档位」。
 *
 * 四条不可动摇的约束 —— 这四条决定了这个产品是「助手」还是「责任主体」：
 *
 *   1. **模型只提档位建议，程序掌握最终裁量权。**
 *      模型给高了会被程序强制压到封顶档，并且**留痕**（adjustments）。
 *      这与「分数由程序算」是同一条原则的延伸：模型可以判断，但不能裁决。
 *
 *   2. **needs_human 是并集，不是交集。**
 *      程序规则判定需要人工的，模型说不需要也没用；反之亦然。
 *      任一方的「需要人工」都成立 —— 因为让错误漏出去的成本远高于多送一次人工。
 *
 *   3. **引用必须真实存在。**
 *      模型给的 evidence_refs / missing_refs 必须命中该评分点已核验的
 *      quote_id / expectation_id，否则丢弃。这与引文回查是同一个思路：
 *      让「没有依据的判断」在结构上不成立。
 *
 *   4. **模型永远不输出总分。**
 *      这里只产出单点档位；总分由 scoringService 按显式权重确定性算出。
 *
 * 参见 docs/技术方案.md 第 6 章与 docs/开发交接.md §3.4。
 */
import type { EnvConfig } from '../config';
import type { Logger } from '../logger';
import { LlmError } from '../errors';
import {
  HumanReasonSchema,
  LevelMatchModelOutputSchema,
  type Criterion,
  type EvidenceExtraction,
  type HumanReason,
  type LevelMatch,
} from '../schema';
import { chat } from '../llm/client';
import { parseModelJson, stripNulls } from '../llm/jsonGuard';
import {
  LEVEL_MATCH_PROMPT_VERSION,
  buildLevelMatchSystemPrompt,
  buildLevelMatchUserPrompt,
} from '../llm/prompts';
import {
  applyHumanityRules,
  capLevel,
  hasMaterialLevelFailure,
  type HumanityRuleResult,
  type LevelCode,
} from './scoringService';

const MAX_ATTEMPTS = 3;

const ALL_LEVELS: readonly LevelCode[] = ['L1', 'L2', 'L3', 'L4'];

// ────────────────────────────────────────────────────────────
// 纯函数部分：程序裁量（可单测，不碰模型）
// ────────────────────────────────────────────────────────────

export interface ReconcileArgs {
  criterion: Criterion;
  evidence: EvidenceExtraction;
  /** applyHumanityRules 的结果，在调用模型前就已算好 */
  rules: HumanityRuleResult;
  model: {
    matched_level: LevelCode;
    evidence_refs: string[];
    missing_refs: string[];
    rule_applied: string | null;
    alternatives: Array<{ level: LevelCode; blocked_by: string }>;
    needs_human: boolean;
    /** 任意字符串：合法取值由这里过滤，不由 schema 拒收（见 schema 里的说明） */
    human_reasons: string[];
  };
}

export interface ReconcileResult {
  match: LevelMatch;
  /** 程序对模型建议做过的每一次干预。空数组表示原样采纳。 */
  adjustments: string[];
}

/**
 * 把模型建议收敛成一个可进入算分的判定。
 *
 * 这是「程序裁量权」的落点。模型说的话在这里被逐条核对：
 * 档位是否越界、引用是否真实、是否够格自动定级。
 */
export function reconcileLevelMatch(args: ReconcileArgs): ReconcileResult {
  const { criterion, evidence, rules, model } = args;
  const adjustments: string[] = [];

  const definedLevels = new Set(criterion.levels.map((l) => l.level));

  // ── ① 引用核对：只保留真实存在的 ──────────────────────
  const validQuoteIds = new Set(evidence['2_found_quotes'].map((q) => q.quote_id));
  const validExpectationIds = new Set(evidence['4_not_found'].map((n) => n.expectation_id));

  const evidenceRefs = model.evidence_refs.filter((id) => validQuoteIds.has(id));
  const missingRefs = model.missing_refs.filter((id) => validExpectationIds.has(id));

  const droppedQuotes = model.evidence_refs.filter((id) => !validQuoteIds.has(id));
  const droppedMissing = model.missing_refs.filter((id) => !validExpectationIds.has(id));

  if (droppedQuotes.length > 0) {
    adjustments.push(`丢弃 ${droppedQuotes.length} 条不存在的引文引用：${droppedQuotes.join('、')}`);
  }
  if (droppedMissing.length > 0) {
    adjustments.push(`丢弃 ${droppedMissing.length} 条不存在的缺失引用：${droppedMissing.join('、')}`);
  }

  // ── ② 转人工理由的过滤 ────────────────────────────────
  // 模型给的理由标签先过滤 —— 闭集之外的取值只是"用词不同"，不是内容错误。
  // 因为一个标签拒收整份判定，会丢掉本来可用的档位（实测踩过）。
  const validReasons = new Set<string>(HumanReasonSchema.options);
  const materialFailed = hasMaterialLevelFailure(evidence);

  const acceptedReasons: HumanReason[] = [];
  const rejectedReasons: string[] = [];

  for (const reason of model.human_reasons) {
    if (!validReasons.has(reason)) {
      rejectedReasons.push(reason);
      continue;
    }
    // parse_failure 不接受模型自报：材料到底有没有问题，只有写这个字段的程序知道。
    // 模型能看到 7_parse_failures，于是会推断"解析失败"，但那个字段里混着
    // 「引文回查丢弃」这类模型侧问题 —— 已被程序排除在判据之外。
    if (reason === 'parse_failure' && !materialFailed) {
      rejectedReasons.push(reason);
      continue;
    }
    acceptedReasons.push(reason as HumanReason);
  }

  if (rejectedReasons.length > 0) {
    adjustments.push(
      `忽略了 ${rejectedReasons.length} 个程序不予采信的转人工理由：${rejectedReasons.join('、')}`,
    );
  }

  const reasons: HumanReason[] = [...rules.reasons, ...acceptedReasons];
  let needsHuman = rules.needsHuman || model.needs_human;

  if (!definedLevels.has(model.matched_level)) {
    reasons.push('level_undefined');
    needsHuman = true;
    adjustments.push(
      `模型给出的档位 ${model.matched_level} 在该评分点的档位定义中不存在（已定义：${[...definedLevels].join('、')}）`,
    );
  }

  // ── ③ 封顶：程序强制施加，模型说不需要也照压 ──────────
  let level: LevelCode = model.matched_level;
  let ruleApplied = model.rule_applied;

  if (rules.cappedAt !== null) {
    const capped = capLevel(level, rules.cappedAt);
    if (capped !== level) {
      adjustments.push(
        `档位由 ${level} 压至 ${capped}：required 证据 ${rules.missingRequired.join('、')} 未满足`,
      );
      level = capped;
    }
    // 只要封顶规则存在，rule_applied 就记成封顶规则 —— 便于事后归因
    ruleApplied = 'cap_level_when_required_missing';
  }

  // ── ④ 无依据不予采信 ──────────────────────────────────
  // 既没有引文支撑、也没有报出缺失，等于这个档位没有任何可核对的基础。
  // 这类判断必须转人工：留着它，就等于让模型凭空定档。
  const hasBasis = evidenceRefs.length > 0 || missingRefs.length > 0;
  if (!hasBasis && !needsHuman) {
    needsHuman = true;
    reasons.push('no_evidence');
    adjustments.push('该档位既无引文支撑也未报出缺失，判定为依据不足，转人工');
  }

  // ── ⑤ 组装备选集 ──────────────────────────────────────
  const alternatives: Array<{ level: LevelCode; blocked_by: string }> = model.alternatives
    .filter((a) => ALL_LEVELS.includes(a.level))
    .map((a) => ({ level: a.level, blocked_by: a.blocked_by }));

  // 若程序压低了档位，把模型的原始建议留档 —— 教师复核时能看到「AI 本来想给 L4」
  if (rules.cappedAt !== null && level !== model.matched_level) {
    alternatives.unshift({
      level: model.matched_level,
      blocked_by: 'required 证据未满足，由程序封顶',
    });
  }

  return {
    match: {
      criterion_id: criterion.criterion_id,
      matched_level: level,
      evidence_refs: evidenceRefs,
      missing_refs: missingRefs,
      rule_applied: ruleApplied,
      alternatives,
      needs_human: needsHuman,
      human_reasons: [...new Set(reasons)],
      prompt_version: LEVEL_MATCH_PROMPT_VERSION,
    },
    adjustments,
  };
}

/** 把封顶规则渲染成给模型看的自然语言。 */
export function buildCapRuleText(criterion: Criterion, rules: HumanityRuleResult): string {
  if (rules.missingRequired.length === 0) {
    return '该评分点的 required 证据均已满足，无封顶限制。';
  }
  return [
    `以下 required 证据未满足：${rules.missingRequired.join('、')}。`,
    `因此该评分点最高只能归入 ${criterion.cap_level_when_required_missing} 档，请勿给出更高档位。`,
  ].join('\n');
}

// ────────────────────────────────────────────────────────────
// 编排：调用模型
// ────────────────────────────────────────────────────────────

export interface MatchLevelArgs {
  config: EnvConfig;
  logger: Logger;
  criterion: Criterion;
  evidence: EvidenceExtraction;
}

export interface MatchLevelResult {
  match: LevelMatch;
  adjustments: string[];
}

/**
 * 对单个评分点做等级匹配。
 *
 * 失败策略：结构不合法时重试，重试耗尽则抛 LlmError ——
 * 由调用方决定是「整批失败」还是「该项转人工」（gradeService 选后者）。
 */
export async function matchLevel(args: MatchLevelArgs): Promise<MatchLevelResult> {
  const { config, logger, criterion, evidence } = args;
  const rules = applyHumanityRules(criterion, evidence);

  const systemPrompt = buildLevelMatchSystemPrompt();
  const userPrompt = buildLevelMatchUserPrompt({
    criterionName: criterion.name,
    levelsJson: JSON.stringify(criterion.levels, null, 2),
    capRule: buildCapRuleText(criterion, rules),
    evidenceJson: JSON.stringify(evidence, null, 2),
  });

  let lastIssues = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await chat(
      config,
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        // 4000 而不是 1500：`deepseek-flash` 是带思考链的模型，会先把 token
        // 花在内部推理上。实测 1500 时推理吃光配额、content 返回空、
        // finish_reason 为 "length"。给足配额是根治，client 侧另有自适应放大兜底。
        maxTokens: 4000,
        temperature: 0,
        jsonMode: true,
      },
      logger,
    );

    const { value, step } = parseModelJson(result.content);
    // 同 evidenceService：先做表示法归一化（null → 省略），再按契约校验
    const parsed = LevelMatchModelOutputSchema.safeParse(stripNulls(value));

    if (!parsed.success) {
      lastIssues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('；');
      logger.warn('level_match.schema_invalid', { attempt, jsonStep: step, issues: lastIssues });
      continue;
    }

    const { match, adjustments } = reconcileLevelMatch({
      criterion,
      evidence,
      rules,
      model: parsed.data,
    });

    logger.info('level_match.done', {
      criterionId: criterion.criterion_id,
      attempt,
      modelLevel: parsed.data.matched_level,
      finalLevel: match.matched_level,
      needsHuman: match.needs_human,
      adjustmentCount: adjustments.length,
    });

    return { match, adjustments };
  }

  throw new LlmError('模型返回的等级判定结构不合法，已重试仍失败', { issues: lastIssues });
}
