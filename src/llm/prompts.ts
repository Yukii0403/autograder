/**
 * Prompt 模板（证据抽取，阶段 B）。
 *
 * ⚠️ **唯一真相源约定**：本文件与 `skills/autograder-evidence-extract/SKILL.md`
 * 描述的是同一套约束。修改任一处必须同步另一处，否则线上行为会和 Skill 演示不一致 ——
 * 这是这类项目最常见的隐性故障。
 *
 * 版本号与 EvidenceExtraction.prompt_version 对应。改 prompt 必须升版本号，
 * 否则历史结果无法归因到具体是哪个版本的 prompt 产出的。
 */

export const EVIDENCE_PROMPT_VERSION = 'b2-v1';

/** 上下文预算：超出则只送相关切片。 */
export const MATERIAL_BUDGET_CHARS = 24_000;

export interface EvidencePromptInput {
  criterionId: string;
  criterionName: string;
  /** 该评分点的证据需求清单，已序列化 */
  evidenceRequirementsJson: string;
  /** 全篇章节索引（人读格式） */
  sectionIndexText: string;
  /** 材料正文或其相关切片 */
  material: string;
  /** 材料是否被裁剪过，用于在 prompt 里如实声明 */
  truncated: boolean;
}

export function buildEvidenceSystemPrompt(): string {
  return [
    '你是证据抽取员。你的唯一职责是记录「原文里有什么、在哪里、缺什么」。',
    '你不是评分员，不得给出任何评价。',
    '',
    '【绝对禁止】输出以下类型词汇及其近义词：',
    '好、差、优秀、良好、不合格、敷衍、认真、完整、缺失、创新、合理、充分、不足、',
    '抄袭、疑似、显然、应该是、建议、值得、问题。',
    '',
    '【自检规则】',
    '写完每一条之后问自己：如果把这句删掉，读者还能按位置去原文核对吗？',
    '如果不能，说明这句是判断而非观察，必须删除。',
    '',
    '【允许的句式模板】',
    '- 「在 <位置> 找到原文：<逐字摘录>」',
    '- 「在 <范围> 内检索 <关键词>，未找到匹配」',
    '- 「正文 <位置A> 陈述 X；代码 <位置B> 为 Y；两者不一致」',
    '- 「该评分点要求的 <req_id> 未获得匹配」',
    '',
    '【位置规范】',
    '每一条 found_quotes 必须给出 material_id 与 anchor。',
    'anchor 用「章节标题 或 代码块标识」描述，例如「2.1 原理说明 第2段」「代码块 list.1 行 12-30」。',
    '无法给出位置的内容一律不要输出。',
    '',
    '【冲突处理】',
    '只描述「哪个事实与哪个事实不一致」，不解释原因、不推测动机。',
    'nature 字段只能取以下三个值之一：',
    'factual_mismatch | numeric_mismatch | internal_inconsistency',
    '',
    '【逐字摘录要求】',
    'found_quotes[].text 必须是原文的逐字拷贝，不得改写、概括、润色或补全标点。',
    '系统会把每条摘录拿回原文做匹配校验，对不上的会被直接丢弃。',
  ].join('\n');
}

export function buildEvidenceUserPrompt(input: EvidencePromptInput): string {
  const { criterionId, criterionName, evidenceRequirementsJson, sectionIndexText, material, truncated } = input;

  return [
    '【任务】为下面这一个评分点抽取可核验证据，输出 JSON。',
    '',
    '【评分点】',
    `- criterion_id: ${criterionId}`,
    `- 名称: ${criterionName}`,
    `- 所需证据清单: ${evidenceRequirementsJson}`,
    '',
    '【全篇章节索引】（用于确定检索范围；判断「未找到」时必须以此为依据）',
    sectionIndexText,
    '',
    truncated
      ? '【材料】⚠️ 以下为相关切片，非全文。凡是切片中未出现的内容，一律不得断言「未找到」，只能写入 searched_scope 说明检索范围。'
      : '【材料】以下为全文。',
    '',
    material,
    '',
    '【输出】请以 json 输出，字段与下面示例严格一致：',
    '```json',
    JSON.stringify(
      {
        '1_searched_materials': [
          { material_id: 'm1', source_type: 'report_text', range: 'p.3-4', query: '原理说明' },
        ],
        '2_found_quotes': [
          {
            quote_id: 'q1',
            material_id: 'm1',
            text: '……逐字摘录……',
            location: { page: 3, anchor: '§2.1 第2段' },
          },
        ],
        '3_locations_index': [{ material_id: 'm1', page: 3, anchor: '§2.1' }],
        '4_not_found': [
          {
            expectation_id: 'r2',
            expected: '对 waitpid 返回值的处理说明',
            searched_scope: ['report_text', 'appendix'],
            status: 'not_found',
          },
        ],
        '5_surface_conflicts': [
          {
            conflict_id: 'x1',
            nature: 'factual_mismatch',
            claim: '……',
            claim_location: { page: 2, anchor: '§2.3' },
            observed: '……',
            observed_location: { page: 6, anchor: 'list.1 L12-20' },
          },
        ],
      },
      null,
      2,
    ),
    '```',
    '',
    '注意：不要输出 6_sufficiency 与 7_parse_failures，这两个字段由程序生成。',
  ].join('\n');
}

// ────────────────────────────────────────────────────────────
// 等级匹配（阶段 C）
// ────────────────────────────────────────────────────────────

export const LEVEL_MATCH_PROMPT_VERSION = 'b3-v1';

export interface LevelMatchPromptInput {
  criterionName: string;
  levelsJson: string;
  capRule: string;
  evidenceJson: string;
}

export function buildLevelMatchSystemPrompt(): string {
  return [
    '你是评分档位匹配员。你拿到的是一组已核验的事实（证据 JSON），以及该评分点的档位描述。',
    '你的任务是把这个评分点归入某一档。',
    '',
    '【你必须遵守】',
    '1. 只能基于输入中已有的事实做判断，不得引入任何外部知识，不得推测学生"本来应该"怎么做。',
    '2. 若证据中标明某个 required 要求未满足，最高只能给到 cap 规则指定的档位。',
    '3. 若证据中存在未解决的 surface_conflicts，把 needs_human 设为 true，并说明是哪一条冲突导致的。',
    '4. 你只输出**单个评分点**的档位，绝不输出总分。',
    '5. evidence_refs 只能引用输入里真实存在的 quote_id。',
  ].join('\n');
}

export function buildLevelMatchUserPrompt(input: LevelMatchPromptInput): string {
  return [
    `【评分点】${input.criterionName}`,
    '',
    `【档位描述】${input.levelsJson}`,
    '',
    `【封顶规则】${input.capRule}`,
    '',
    '【证据 JSON】',
    input.evidenceJson,
    '',
    '【输出】请以 json 输出：',
    '```json',
    JSON.stringify(
      {
        matched_level: 'L2',
        evidence_refs: ['q1'],
        missing_refs: ['r2'],
        rule_applied: 'cap_level_when_required_missing',
        alternatives: [{ level: 'L3', blocked_by: 'r2 未满足' }],
        needs_human: true,
        human_reasons: ['required_evidence_missing'],
      },
      null,
      2,
    ),
    '```',
  ].join('\n');
}
