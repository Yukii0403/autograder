/**
 * 观察层去定性化 —— 三层防线的第三层（程序后置扫描）。
 *
 * Prompt 里的禁令只是口头约束，Zod 只能约束枚举字段。真正把「不准写评价」
 * 变成机器约束的是这个扫描：命中即拒收并重生成。
 *
 * ⚠️ 关键设计：**只扫描模型自己撰写的字段，不扫描逐字摘录。**
 *
 *   2_found_quotes[].text 是学生报告里的原文逐字摘录。学生完全可能在报告里
 *   写「本次实验完成得很好」，如果扫这一段，就会把学生的用词误判成模型的定性。
 *
 *   分工是清楚的：
 *     - 摘录是否可信   → 由 quoteVerify 负责（不是逐字原文就丢弃）
 *     - 模型是否在下判断 → 由本模块负责（只扫模型撰写字段）
 *
 *   因此调用顺序必须是：先 verifyQuotes，再 scanJudgement。
 */
import type { EvidenceModelOutput } from '../schema';
import { JudgementLeakError } from '../errors';

/**
 * 硬禁用词。
 *
 * 每一项都是「评价」而不是「观察」。判据：删掉它，读者还能不能按位置去原文核对？
 *
 * 刻意不收录的词（它们是合法观察用语）：
 *   未找到、未出现、不一致、无对应、不存在、未提供、为空
 */
export const BANNED_TERMS: readonly string[] = [
  // 优劣类
  '优秀', '良好', '合格', '不合格', '及格', '不及格', '好', '差', '糟糕', '出色', '平庸',
  // 态度类（对作者的动机或态度的推断）
  '敷衍', '认真', '仔细', '草率', '粗糙', '用心',
  // 完备性评价
  '完整', '完备', '缺失', '遗漏', '偏少', '丰富', '单薄',
  // 创新与合理性评价
  '创新', '新颖', '合理', '不合理', '充分', '不足', '深入', '浅显',
  // 规范性评价
  '规范', '不规范', '清晰', '含糊', '混乱', '整洁',
  // 学术诚信（红线中的红线）
  '抄袭', '剽窃', '雷同', '作弊', '造假', '疑似', '涉嫌',
  // 主观断言
  '显然', '应该', '值得', '建议', '缺陷',
  // ── 刻意不收单字词「错误」「问题」──────────────────────────────
  // 它们在技术语境里有大量合法用法，收进来会造成误烧：
  //   「无对应的错误处理分支」——描述代码结构，是观察
  //   「错误码」「错误日志」——同上
  //   「问题分析与改进」——这是实验报告的常见章节标题
  // 误报的代价很高：整个观察层被拒收并触发重生成，既费钱又可能反复失败。
  // 所以只收它们**构成评价**的复合形式：
  '有问题', '存在问题', '逻辑错误', '明显错误', '严重错误', '存在错误', '是错误的',
];

/** 长词优先匹配，便于报告时给出更精确的命中词。 */
const BANNED_RE = new RegExp(
  [...BANNED_TERMS].sort((a, b) => b.length - a.length).join('|'),
  'g',
);

export interface JudgementHit {
  /** 命中的禁用词 */
  term: string;
  /** 命中的字段路径，便于定位 */
  field: string;
  /** 命中处的上下文片段 */
  excerpt: string;
}

/**
 * 扫描模型撰写的字段。
 *
 * 扫描范围是刻意收窄的 —— 见文件头注释：
 *   - 1_searched_materials[].query   模型写的检索词，属于模型产出
 *   - 4_not_found[].expected         模型写的「本应有什么」，属于模型产出
 *   - 5_surface_conflicts[].claim    模型写的「哪个事实」
 *   - 5_surface_conflicts[].observed 模型写的「哪个事实与之不符」
 *
 * 不在范围内：2_found_quotes[].text（学生原文）、3_locations_index（结构信息）
 */
export function scanJudgement(evidence: EvidenceModelOutput): JudgementHit[] {
  const hits: JudgementHit[] = [];

  const scan = (text: string | undefined, field: string): void => {
    if (!text) return;
    BANNED_RE.lastIndex = 0;
    const match = BANNED_RE.exec(text);
    if (match) {
      const start = Math.max(0, match.index - 12);
      hits.push({
        term: match[0],
        field,
        excerpt: text.slice(start, match.index + match[0].length + 12),
      });
    }
  };

  evidence['1_searched_materials'].forEach((m, i) => {
    scan(m.query, `1_searched_materials[${i}].query`);
  });

  evidence['4_not_found'].forEach((n, i) => {
    scan(n.expected, `4_not_found[${i}].expected`);
  });

  evidence['5_surface_conflicts'].forEach((c, i) => {
    scan(c.claim, `5_surface_conflicts[${i}].claim`);
    scan(c.observed, `5_surface_conflicts[${i}].observed`);
  });

  return hits;
}

/** 命中任一禁用词即抛 JudgementLeakError。调用方据此拒收并重生成。 */
export function assertNoJudgement(evidence: EvidenceModelOutput): void {
  const hits = scanJudgement(evidence);
  const first = hits[0];
  if (first) {
    throw new JudgementLeakError(first.term, first.field, { hits });
  }
}

/** 供测试与自检使用：列出命中的全部位置。 */
export function listJudgementHits(evidence: EvidenceModelOutput): string[] {
  return scanJudgement(evidence).map((h) => `${h.field}: 「${h.term}」 … ${h.excerpt}`);
}
