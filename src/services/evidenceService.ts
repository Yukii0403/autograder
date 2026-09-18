/**
 * 证据抽取服务（观察层的产出者）。
 *
 * 这一段是主链路的第一个「有模型参与」的环节，因此所有防线都在这里串起来：
 *
 *   1. 章节索引由程序生成（纯函数），不调模型
 *   2. 模型只负责「找引用、报缺失、报冲突」
 *   3. 输出经 Zod 校验
 *   4. **引文回查** —— 对不上的摘录直接丢弃
 *   5. **禁用词扫描** —— 出现定性判断即拒收并重生成
 *   6. **6_sufficiency 由程序按证据需求逐条比对得出**，不让模型自由判断
 *
 * 第 5、6 条是这套系统可信度的来源：少了任何一条，
 * 观察层就可能混入判断，或退化成「这份报告够不够好」的主观结论。
 */
import type { EnvConfig } from '../config';
import type { Logger } from '../logger';
import { JudgementLeakError, LlmError } from '../errors';
import {
  EvidenceModelOutputSchema,
  type Criterion,
  type EvidenceExtraction,
  type Sufficiency,
} from '../schema';
import { chat } from '../llm/client';
import { parseModelJson } from '../llm/jsonGuard';
import {
  EVIDENCE_PROMPT_VERSION,
  MATERIAL_BUDGET_CHARS,
  buildEvidenceSystemPrompt,
  buildEvidenceUserPrompt,
} from '../llm/prompts';
import { assertNoJudgement } from '../util/judgementScan';
import { toParseFailures, verifyQuotes } from '../util/quoteVerify';
import { buildSectionIndex, renderSectionIndex, selectRelevantSections } from '../util/sectionIndex';

/** 定性词命中后最多重生成几次。 */
const MAX_LEAK_RETRIES = 2;

export interface ExtractEvidenceArgs {
  config: EnvConfig;
  logger: Logger;
  submissionId: string;
  criterion: Criterion;
  materialId: string;
  materialText: string;
  now?: string;
}

export interface ExtractEvidenceResult {
  evidence: EvidenceExtraction;
  /** 引文统计，便于直接观察幻觉率 */
  quotes: { kept: number; dropped: number };
  /** 实际用的 prompt 版本 */
  promptVersion: string;
}

export async function extractEvidence(args: ExtractEvidenceArgs): Promise<ExtractEvidenceResult> {
  const { config, logger, submissionId, criterion, materialId, materialText } = args;
  const now = args.now ?? new Date().toISOString();

  const index = buildSectionIndex(materialText);
  const keywords = buildKeywords(criterion);
  const selected = selectRelevantSections(materialText, index, keywords, MATERIAL_BUDGET_CHARS);
  const truncated = selected !== materialText;

  const systemPrompt = buildEvidenceSystemPrompt();
  const userPrompt = buildEvidenceUserPrompt({
    criterionId: criterion.criterion_id,
    criterionName: criterion.name,
    evidenceRequirementsJson: JSON.stringify(criterion.evidence_requirements, null, 2),
    sectionIndexText: renderSectionIndex(index),
    material: selected,
    truncated,
  });

  const textByMaterial = new Map<string, string>([[materialId, materialText]]);
  let lastLeak: JudgementLeakError | null = null;

  for (let attempt = 1; attempt <= MAX_LEAK_RETRIES + 1; attempt += 1) {
    const result = await chat(
      config,
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxTokens: 4000,
        temperature: 0,
        jsonMode: true,
      },
      logger,
    );

    const { value, step } = parseModelJson(result.content);

    const parsed = EvidenceModelOutputSchema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('；');
      logger.warn('evidence.schema_invalid', { attempt, jsonStep: step, issues });
      lastLeak = null;
      if (attempt <= MAX_LEAK_RETRIES) continue;
      throw new LlmError('模型返回的证据结构不合法，已重试仍失败', { issues, jsonStep: step });
    }

    const modelOutput = parsed.data;

    // ① 引文回查 —— 对不上的摘录一律丢弃，位置以程序计算为准
    const verified = verifyQuotes(modelOutput['2_found_quotes'], textByMaterial, config.QUOTE_VERIFY_MIN_SIMILARITY);

    // ② 禁用词扫描 —— 只扫模型撰写的字段，不扫学生原文
    try {
      assertNoJudgement(modelOutput);
    } catch (err) {
      if (err instanceof JudgementLeakError && attempt <= MAX_LEAK_RETRIES) {
        lastLeak = err;
        logger.warn('evidence.judgement_leak', {
          attempt,
          term: err.internal && typeof err.internal === 'object'
            ? (err.internal as { hits?: Array<{ term: string; field: string }> }).hits?.[0]?.term
            : undefined,
        });
        continue;
      }
      throw err;
    }

    // ③ 证据充分性由程序逐条比对得出，不交给模型
    const sufficiency = computeSufficiency(criterion, materialText, index);

    const evidence: EvidenceExtraction = {
      evidence_id: `ev_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      submission_id: submissionId,
      criterion_id: criterion.criterion_id,
      extractor_version: 'ev-v1.0',
      prompt_version: EVIDENCE_PROMPT_VERSION,
      model: result.model,

      '1_searched_materials': modelOutput['1_searched_materials'],
      '2_found_quotes': verified.kept,
      '3_locations_index': modelOutput['3_locations_index'],
      '4_not_found': modelOutput['4_not_found'],
      '5_surface_conflicts': modelOutput['5_surface_conflicts'],
      '6_sufficiency': sufficiency,
      '7_parse_failures': [
        ...toParseFailures(verified.dropped),
        ...(truncated
          ? [{ stage: 'material_select', code: 'TRUNCATED', recoverable: true }]
          : []),
      ],
      runtime_probe: { status: 'not_executed', sandbox_ref: null },
      extracted_at: now,
    };

    logger.info('evidence.extracted', {
      criterionId: criterion.criterion_id,
      attempt,
      quoteKept: verified.kept.length,
      quoteDropped: verified.dropped.length,
      sufficiency: sufficiency.status,
      conflicts: evidence['5_surface_conflicts'].length,
    });

    return {
      evidence,
      quotes: { kept: verified.kept.length, dropped: verified.dropped.length },
      promptVersion: EVIDENCE_PROMPT_VERSION,
    };
  }

  throw lastLeak ?? new LlmError('证据抽取失败：定性词越界且重试耗尽');
}

// ────────────────────────────────────────────────────────────
// 证据充分性：程序逐条比对
// ────────────────────────────────────────────────────────────

/**
 * 判定每个 evidence_requirement 是否被满足。
 *
 * 关键点：**不让模型回答「材料够不够」**。模型自由判断的话，
 * 这个字段会立刻退化成「这份报告写得好不好」——那就又变成定性了。
 * 程序逐条比对得出的结论是可核验的事实陈述（"r2 未满足"）。
 */
export function computeSufficiency(
  criterion: Criterion,
  materialText: string,
  index: ReturnType<typeof buildSectionIndex>,
): Sufficiency {
  const reqResults = criterion.evidence_requirements.map((req) => ({
    req_id: req.req_id,
    met: isRequirementMet(req, materialText, index),
  }));

  const requiredIds = new Set(
    criterion.evidence_requirements.filter((r) => r.required).map((r) => r.req_id),
  );
  const requiredFailed = reqResults.some((r) => requiredIds.has(r.req_id) && !r.met);

  return {
    status: requiredFailed ? 'insufficient' : 'sufficient',
    req_results: reqResults,
    matched_by: 'program_rule',
    rule_version: 'suf-v1',
  };
}

function isRequirementMet(
  req: Criterion['evidence_requirements'][number],
  materialText: string,
  index: ReturnType<typeof buildSectionIndex>,
): boolean {
  switch (req.kind) {
    case 'section': {
      const minChars = req.min_chars ?? 0;
      const hit = index.sections.find(
        (s) => s.title.includes(req.target) && s.charCount >= minChars,
      );
      if (hit) return true;
      // 没有标题结构时退化为「全文里有没有这个词」
      if (index.sections.length === 0) return materialText.includes(req.target);
      return false;
    }

    case 'code_symbol': {
      // target 是「A|B」形式的多候选正则
      const codeRanges = index.codeBlocks.length > 0
        ? index.codeBlocks
        : [{ start: 0, end: materialText.length }];

      let re: RegExp;
      try {
        re = new RegExp(req.target, 'i');
      } catch {
        // 正则写错时按字面量匹配，不让一个坏规则把整份报告判成缺失
        return materialText.toLowerCase().includes(req.target.toLowerCase());
      }

      return codeRanges.some((c) => re.test(materialText.slice(c.start, c.end)));
    }

    case 'figure': {
      // 图表编号形如「图2」「图 2」，允许中间有空格
      const escaped = req.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`${escaped}\\s*\\d+`).test(materialText);
    }

    default:
      return false;
  }
}

/** 从评分点名称与证据需求里抽关键词，用于挑选相关切片。 */
function buildKeywords(criterion: Criterion): string[] {
  const words = new Set<string>();

  // 名称按标点切分，取长度 >= 2 的片段
  for (const piece of criterion.name.split(/[\s·、,，。:：()（）/]+/)) {
    if (piece.length >= 2) words.add(piece);
  }
  for (const req of criterion.evidence_requirements) {
    if (req.kind === 'section' && req.target.length >= 2) words.add(req.target);
  }

  return [...words];
}
