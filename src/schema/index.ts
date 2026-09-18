/**
 * 数据契约（Zod）。
 *
 * 字段以 docs/附录-数据契约与Prompt.md 的 A 节为准。本文件是代码侧的唯一真相源。
 *
 * 三条硬性约束（写在类型里，不靠人记）：
 *   1. 观察层不含任何定性字段 —— 没有 score / level / quality / comment
 *   2. 5_surface_conflicts.nature 是枚举闭集，不含任何学术诚信类词汇
 *   3. 6_sufficiency 与 7_parse_failures 由程序产出，不由模型产出
 */
import { z } from 'zod';

// ────────────────────────────────────────────────────────────
// A.1 Rubric（评分细则）
// ────────────────────────────────────────────────────────────

/** 证据需求的匹配方式。 */
export const EvidenceRequirementSchema = z.object({
  req_id: z.string().min(1),
  kind: z.enum(['section', 'code_symbol', 'figure']),
  /** section 用章节标题；code_symbol 用正则；figure 用图表编号 */
  target: z.string().min(1),
  /** 仅 section 生效：最小字符数 */
  min_chars: z.number().int().nonnegative().optional(),
  required: z.boolean(),
});

export const LevelSchema = z.object({
  level: z.enum(['L1', 'L2', 'L3', 'L4']),
  score_ratio: z.number().min(0).max(1),
  descriptor: z.string().min(1),
});

export const CriterionSchema = z.object({
  criterion_id: z.string().min(1),
  name: z.string().min(1),
  weight: z.number().positive(),
  /**
   * execution：可机械化核查，进入自动流程
   * judgment：必须人工，直接转人工，不进入自动流程
   */
  type: z.enum(['execution', 'judgment']),
  evidence_requirements: z.array(EvidenceRequirementSchema),
  levels: z.array(LevelSchema).min(2),
  /** required 证据未满足时的档位上限，默认 L2 */
  cap_level_when_required_missing: z.enum(['L1', 'L2', 'L3', 'L4']).default('L2'),
});

/**
 * 评分合成规则。
 *
 * 注意：这里把子 schema 单独抽出来，是因为 zod v4 的 `.default()` 要求传入
 * **完整的输出类型**，而不是 `{}`。写成 `.default({})` 会因为缺少字段而报
 * 「No overload matches this call」。所以下面给的是一个完整对象。
 */
export const ScoringSchema = z.object({
  compose: z.literal('weighted_sum').default('weighted_sum'),
  round: z.literal('half_up_1').default('half_up_1'),
  pass_line: z.number().min(0).max(100).default(60),
  /** 恒为 true —— 程序永远不输出及格/不及格结论 */
  pass_line_requires_human: z.literal(true).default(true),
});

/** 与 ScoringSchema 的输出类型一致的完整默认值。 */
export const DEFAULT_SCORING: z.infer<typeof ScoringSchema> = {
  compose: 'weighted_sum',
  round: 'half_up_1',
  pass_line: 60,
  pass_line_requires_human: true,
};

export const RubricSchema = z.object({
  rubric_id: z.string().min(1),
  title: z.string().min(1),
  course: z.string().min(1),
  version: z.number().int().positive(),
  total_points: z.number().positive().default(100),
  criteria: z.array(CriterionSchema).min(1).max(50),
  scoring: ScoringSchema.default(DEFAULT_SCORING),
});

export type Rubric = z.infer<typeof RubricSchema>;
export type Criterion = z.infer<typeof CriterionSchema>;
export type EvidenceRequirement = z.infer<typeof EvidenceRequirementSchema>;
export type Level = z.infer<typeof LevelSchema>;

// ────────────────────────────────────────────────────────────
// A.2 EvidenceExtraction（观察层）
// ────────────────────────────────────────────────────────────

export const QuoteLocationSchema = z.object({
  page: z.number().int().positive().optional(),
  anchor: z.string().min(1),
  char_start: z.number().int().nonnegative().optional(),
  char_end: z.number().int().nonnegative().optional(),
});

export const FoundQuoteSchema = z.object({
  quote_id: z.string().min(1),
  material_id: z.string().min(1),
  /** 逐字摘录，不得改写 */
  text: z.string().min(1),
  location: QuoteLocationSchema,
  /** 引文回查的结果，由程序回填 */
  verified: z.enum(['exact', 'fuzzy', 'unverified']).default('unverified'),
});

/**
 * 表面冲突的性质 —— 枚举闭集。
 *
 * 刻意不含 plagiarism / cheating / dishonest / suspicious：
 * 相似度高不等于抄袭，定性需要解释规则，而规则是人定的。
 */
export const ConflictNatureSchema = z.enum([
  'factual_mismatch',
  'numeric_mismatch',
  'internal_inconsistency',
]);

export const SurfaceConflictSchema = z.object({
  conflict_id: z.string().min(1),
  nature: ConflictNatureSchema,
  claim: z.string().min(1),
  claim_location: QuoteLocationSchema,
  observed: z.string().min(1),
  observed_location: QuoteLocationSchema,
});

export const NotFoundSchema = z.object({
  expectation_id: z.string().min(1),
  expected: z.string().min(1),
  searched_scope: z.array(z.string()).min(1),
  status: z.literal('not_found'),
});

export const ParseFailureSchema = z.object({
  stage: z.string().min(1),
  code: z.string().min(1),
  material_id: z.string().optional(),
  page_range: z.string().optional(),
  recoverable: z.boolean(),
});

export const SufficiencySchema = z.object({
  status: z.enum(['sufficient', 'insufficient', 'unknown']),
  req_results: z.array(
    z.object({ req_id: z.string().min(1), met: z.boolean() }),
  ),
  matched_by: z.literal('program_rule').default('program_rule'),
  rule_version: z.string().default('suf-v1'),
});

/**
 * 模型产出的部分（阶段 B）。
 * 只含 5 个字段 —— 6_sufficiency 与 7_parse_failures 由程序补。
 */
export const EvidenceModelOutputSchema = z.object({
  '1_searched_materials': z
    .array(
      z.object({
        material_id: z.string().min(1),
        source_type: z.string().min(1),
        range: z.string().min(1),
        query: z.string().min(1),
      }),
    )
    .default([]),
  '2_found_quotes': z.array(FoundQuoteSchema).default([]),
  '3_locations_index': z
    .array(z.object({ material_id: z.string().min(1), page: z.number().int().optional(), anchor: z.string() }))
    .default([]),
  '4_not_found': z.array(NotFoundSchema).default([]),
  '5_surface_conflicts': z.array(SurfaceConflictSchema).default([]),
});

/** 完整的观察层（模型产出 + 程序补齐）。 */
export const EvidenceExtractionSchema = EvidenceModelOutputSchema.extend({
  evidence_id: z.string().min(1),
  submission_id: z.string().min(1),
  criterion_id: z.string().min(1),
  extractor_version: z.string().default('ev-v1.0'),
  prompt_version: z.string().default('b2-v1'),
  model: z.string().min(1),
  '6_sufficiency': SufficiencySchema,
  '7_parse_failures': z.array(ParseFailureSchema).default([]),
  /** 沙箱接入点，本期恒为 not_executed */
  runtime_probe: z
    .object({
      status: z.enum(['not_executed', 'passed', 'failed', 'error']),
      sandbox_ref: z.string().nullable().default(null),
    })
    .default({ status: 'not_executed', sandbox_ref: null }),
  extracted_at: z.string(),
});

export type EvidenceExtraction = z.infer<typeof EvidenceExtractionSchema>;
export type EvidenceModelOutput = z.infer<typeof EvidenceModelOutputSchema>;
export type FoundQuote = z.infer<typeof FoundQuoteSchema>;
export type SurfaceConflict = z.infer<typeof SurfaceConflictSchema>;
export type Sufficiency = z.infer<typeof SufficiencySchema>;
export type ParseFailure = z.infer<typeof ParseFailureSchema>;

// ────────────────────────────────────────────────────────────
// A.3 LevelMatch（等级匹配）
// ────────────────────────────────────────────────────────────

export const HumanReasonSchema = z.enum([
  'required_evidence_missing',
  'unresolved_conflict',
  'parse_failure',
  'no_evidence',
  'criterion_is_judgment',
  /**
   * 模型给出的档位在该评分点的 levels 里没有定义 —— 无法换算系数。
   * 这通常意味着细则改了档位但匹配逻辑没跟上，或模型自由发挥了一个不存在的档。
   */
  'level_undefined',
]);

export const LevelMatchSchema = z.object({
  criterion_id: z.string().min(1),
  matched_level: z.enum(['L1', 'L2', 'L3', 'L4']),
  evidence_refs: z.array(z.string()).default([]),
  missing_refs: z.array(z.string()).default([]),
  rule_applied: z.string().nullable().default(null),
  alternatives: z
    .array(z.object({ level: z.enum(['L1', 'L2', 'L3', 'L4']), blocked_by: z.string() }))
    .default([]),
  /** true 时该评分点不进入总分 */
  needs_human: z.boolean().default(false),
  human_reasons: z.array(HumanReasonSchema).default([]),
  prompt_version: z.string().default('b3-v1'),
});

/**
 * 模型产出的部分（阶段 C）。
 *
 * 与完整 LevelMatch 的唯一差别：不含 criterion_id —— 这个字段由程序填入。
 * 不能让模型自己声明"我评的是哪个评分点"，否则一旦串号，错误会静默传播。
 */
export const LevelMatchModelOutputSchema = LevelMatchSchema.omit({ criterion_id: true });

export type LevelMatch = z.infer<typeof LevelMatchSchema>;
export type LevelMatchModelOutput = z.infer<typeof LevelMatchModelOutputSchema>;
export type HumanReason = z.infer<typeof HumanReasonSchema>;

// ────────────────────────────────────────────────────────────
// A.4 FinalGrade（最终评分记录）
// ────────────────────────────────────────────────────────────

export const ReasonCodeSchema = z.enum([
  'rule_too_strict',
  'rule_too_loose',
  'evidence_misread',
  'material_missing',
  'other',
]);

export const GradeItemSchema = z.object({
  criterion_id: z.string().min(1),
  weight: z.number(),
  level: z.enum(['L1', 'L2', 'L3', 'L4']).nullable(),
  score_ratio: z.number().nullable(),
  raw_score: z.number(),
  source: z.enum(['auto', 'human', 'pending']),
  is_overridden: z.boolean().default(false),
});

export const CalibrationSignalSchema = z.object({
  criterion_id: z.string().min(1),
  agent_level: z.enum(['L1', 'L2', 'L3', 'L4']),
  human_level: z.enum(['L1', 'L2', 'L3', 'L4']),
  reason_code: ReasonCodeSchema,
  teacher_note: z.string().default(''),
  created_at: z.string(),
});

export const GradeStateSchema = z.enum([
  'draft',
  'evidence_extracted',
  'level_matched',
  'scored',
  'pending_teacher_confirm',
  'teacher_confirmed',
  'archived',
]);

export const FinalGradeSchema = z.object({
  grade_id: z.string().min(1),
  submission_id: z.string().min(1),
  rubric_id: z.string().min(1),
  rubric_version: z.number().int().positive(),
  engine_version: z.string().default('calc-v1'),
  items: z.array(GradeItemSchema),
  /** 仅由 needs_human=false 的评分点加权得出 */
  computed_total: z.number(),
  final_total: z.number(),
  override_delta: z.number().default(0),
  /** true 时表示有评分点待人工，总分不是最终值 */
  has_pending_items: z.boolean(),
  /** 恒为 false —— 程序不判定及格 */
  pass_judged: z.literal(false).default(false),
  state: GradeStateSchema,
  confirmed_by: z.string().nullable().default(null),
  confirmed_at: z.string().nullable().default(null),
  calibration_signals: z.array(CalibrationSignalSchema).default([]),
});

export type FinalGrade = z.infer<typeof FinalGradeSchema>;
export type GradeItem = z.infer<typeof GradeItemSchema>;
export type CalibrationSignal = z.infer<typeof CalibrationSignalSchema>;
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;
export type GradeState = z.infer<typeof GradeStateSchema>;
