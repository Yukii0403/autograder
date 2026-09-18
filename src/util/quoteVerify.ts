/**
 * 引文回查（quoteVerify）—— 另一道护城河。
 *
 * 规则：模型给出的每条摘录，必须能在解析文本中被真实找到。
 *   - 精确命中            → verified = 'exact'，回填真实偏移
 *   - 相似度 ≥ 阈值       → verified = 'fuzzy'，回填真实偏移
 *   - 都不过              → **丢弃该条摘录**，记录 QUOTE_NOT_VERIFIABLE
 *
 * 两条不可动摇的约束：
 *   1. 位置以程序计算结果为准，**不信任模型给出的 char_start / char_end**
 *   2. 宁可丢弃，也不放行一条无法定位的摘录 —— 扣分依据必须能指到原文
 *
 * 模糊匹配用 **k-gram 投票**定位候选起点，而不是拿摘录前缀当锚点。
 * 原因：前缀锚点对「错字落在开头」的情况完全失效 —— 锚点串在原文里不存在，
 * 直接返回 null。k-gram 投票只依赖片段命中率，跨过错字的片段失效，其余照常投票。
 *
 * 性能约束：Workers Free 版只有 10ms CPU。所以避开 O(n·m) 的编辑距离，
 * 用 O(n) 的 bigram Dice 相似度，并对候选项数与扫描步长设上限。
 */
import type { FoundQuote } from '../schema';

/** 模糊匹配的候选上限。防止大文档上出现候选爆炸。 */
const MAX_CANDIDATES = 25;

/** 投票时最多取多少个 k-gram（长摘录按步长抽样）。 */
const MAX_KGRAM_SAMPLES = 200;

/** 超过这个长度的摘录只做精确匹配，不做模糊匹配。 */
const MAX_FUZZY_LEN = 2000;

/** 建索引的文本长度上限。超过则跳过模糊匹配，避免 CPU 失控。 */
const MAX_INDEX_CHARS = 200_000;

export interface DroppedQuote {
  quote_id: string;
  material_id: string;
  reason: 'material_missing' | 'empty_quote' | 'not_found';
  bestSimilarity: number;
}

export interface VerifyQuotesResult {
  kept: FoundQuote[];
  dropped: DroppedQuote[];
}

interface MatchResult {
  verified: 'exact' | 'fuzzy';
  start: number;
  end: number;
  similarity: number;
}

/** 一份材料的预解析上下文。同一份材料的多条摘录共用，避免重复建索引。 */
export interface MaterialContext {
  normalized: string;
  /** 归一化下标 → 原文下标 */
  map: number[];
  kgram: Map<string, number[]>;
  k: number;
  indexable: boolean;
}

// ────────────────────────────────────────────────────────────
// 归一化
// ────────────────────────────────────────────────────────────

/** 归一化：去空白、转小写。返回归一化文本与「归一化下标 → 原文下标」的映射。 */
export function normalizeWithMap(text: string): { normalized: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (/\s/.test(ch)) continue;
    chars.push(ch.toLowerCase());
    map.push(i);
  }
  return { normalized: chars.join(''), map };
}

/** k-gram 长度按目标长度自适应：太短的目标用大 k 会一个都匹配不上。 */
function chooseK(targetLen: number): number {
  if (targetLen >= 60) return 8;
  if (targetLen >= 20) return 6;
  if (targetLen >= 8) return 4;
  return 0;
}

export function buildMaterialContext(rawText: string): MaterialContext {
  const { normalized, map } = normalizeWithMap(rawText);
  const indexable = normalized.length <= MAX_INDEX_CHARS;

  return {
    normalized,
    map,
    kgram: new Map<string, number[]>(),
    k: 0,
    indexable,
  };
}

/** 惰性建 k-gram 索引：只有真的需要模糊匹配时才建。 */
function ensureKgram(ctx: MaterialContext, k: number): Map<string, number[]> {
  if (ctx.k === k && ctx.kgram.size > 0) return ctx.kgram;

  const index = new Map<string, number[]>();
  const { normalized } = ctx;
  for (let i = 0; i + k <= normalized.length; i += 1) {
    const g = normalized.slice(i, i + k);
    const arr = index.get(g);
    if (arr) arr.push(i);
    else index.set(g, [i]);
  }

  ctx.k = k;
  ctx.kgram = index;
  return index;
}

// ────────────────────────────────────────────────────────────
// 相似度
// ────────────────────────────────────────────────────────────

/** bigram 计数。用于 Dice 相似度。 */
export function bigramCounts(s: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < s.length; i += 1) {
    const g = s.slice(i, i + 2);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return counts;
}

/**
 * Dice 相似度：2 × |A ∩ B| / (|A| + |B|)，按 multiset 计数。
 *
 * 选它而不是编辑距离的原因：O(n) 复杂度，在 Workers 的 CPU 预算内可控。
 * 对「模型是否忠实摘录」这个问题，它的判别力足够。
 */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const ca = bigramCounts(a);
  const cb = bigramCounts(b);

  let intersection = 0;
  for (const [g, n] of ca) {
    const m = cb.get(g);
    if (m) intersection += Math.min(n, m);
  }

  const total = a.length - 1 + (b.length - 1);
  return total > 0 ? (2 * intersection) / total : 0;
}

// ────────────────────────────────────────────────────────────
// 定位
// ────────────────────────────────────────────────────────────

/** 用 k-gram 投票找出目标在归一化文本中最可能的起点，按票数降序。 */
function voteStarts(ctx: MaterialContext, target: string, k: number): number[] {
  const index = ensureKgram(ctx, k);
  const votes = new Map<number, number>();

  const step = target.length > MAX_KGRAM_SAMPLES * k ? Math.ceil(target.length / (MAX_KGRAM_SAMPLES * k)) : 1;
  let sampled = 0;

  for (let i = 0; i + k <= target.length && sampled < MAX_KGRAM_SAMPLES; i += step) {
    sampled += 1;
    const positions = index.get(target.slice(i, i + k));
    if (!positions) continue;
    for (const p of positions) {
      const start = p - i;
      if (start < 0 || start + target.length > ctx.normalized.length + 1) continue;
      votes.set(start, (votes.get(start) ?? 0) + 1);
    }
  }

  return [...votes.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, MAX_CANDIDATES)
    .map(([start]) => start);
}

/** 把归一化坐标转回原文坐标，并切出窗口。 */
function toOriginalRange(ctx: MaterialContext, start: number, endExclusive: number): { start: number; end: number } | null {
  const clampedEnd = Math.min(endExclusive, ctx.map.length);
  if (start < 0 || start >= clampedEnd) return null;
  const s = ctx.map[start];
  const e = ctx.map[clampedEnd - 1];
  if (s === undefined || e === undefined) return null;
  return { start: s, end: e + 1 };
}

/**
 * 在预解析上下文中定位一条摘录。
 *
 * 先精确匹配（归一化后），再做 k-gram 投票 + Dice 打分。
 * 窗口长度会在目标长度上下浮动几档，以容纳插入/删除造成的长度差异。
 */
export function locateInContext(
  ctx: MaterialContext,
  rawQuote: string,
  minSimilarity: number,
): MatchResult | null {
  const quote = rawQuote.trim();
  if (!quote) return null;

  const target = normalizeWithMap(quote).normalized;
  if (!target) return null;

  const { normalized } = ctx;

  // ① 精确子串命中
  const exactIdx = normalized.indexOf(target);
  if (exactIdx >= 0) {
    const range = toOriginalRange(ctx, exactIdx, exactIdx + target.length);
    if (range) return { verified: 'exact', ...range, similarity: 1 };
  }

  // ② 模糊匹配
  if (target.length > MAX_FUZZY_LEN || !ctx.indexable) return null;

  const k = chooseK(target.length);
  if (k === 0) return null;

  const starts = voteStarts(ctx, target, k);
  if (starts.length === 0) return null;

  // 窗口长度浮动几档，容纳插入/删除
  const lengthOffsets = [0, -2, 2, -4, 4];

  let best: MatchResult | null = null;
  for (const start of starts) {
    for (const offset of lengthOffsets) {
      const len = target.length + offset;
      if (len < 2) continue;
      const window = normalized.slice(start, start + len);
      if (window.length === 0) continue;

      const sim = diceSimilarity(window, target);
      if (sim >= minSimilarity && (!best || sim > best.similarity)) {
        const range = toOriginalRange(ctx, start, start + window.length);
        if (!range) continue;
        best = { verified: 'fuzzy', ...range, similarity: sim };
      }
    }
    // 已经拿到精确级别的高分就不必再找了
    if (best && best.similarity >= 0.98) break;
  }

  return best;
}

/** 便捷入口：直接从原文文本定位（内部会建上下文，适合单条调用与测试）。 */
export function locateQuote(rawText: string, rawQuote: string, minSimilarity: number): MatchResult | null {
  return locateInContext(buildMaterialContext(rawText), rawQuote, minSimilarity);
}

// ────────────────────────────────────────────────────────────
// 批量校验
// ────────────────────────────────────────────────────────────

/**
 * 批量校验一组摘录。
 *
 * @param quotes        模型产出的摘录
 * @param textByMaterial material_id → 解析后的原文
 * @param minSimilarity 相似度阈值，来自 config.QUOTE_VERIFY_MIN_SIMILARITY
 */
export function verifyQuotes(
  quotes: readonly FoundQuote[],
  textByMaterial: ReadonlyMap<string, string>,
  minSimilarity: number,
): VerifyQuotesResult {
  const kept: FoundQuote[] = [];
  const dropped: DroppedQuote[] = [];

  // 同一份材料的多条摘录共用上下文，避免重复建 k-gram 索引
  const contexts = new Map<string, MaterialContext>();
  const contextFor = (materialId: string, text: string): MaterialContext => {
    const cached = contexts.get(materialId);
    if (cached) return cached;
    const built = buildMaterialContext(text);
    contexts.set(materialId, built);
    return built;
  };

  for (const quote of quotes) {
    const text = textByMaterial.get(quote.material_id);

    if (!text) {
      dropped.push({
        quote_id: quote.quote_id,
        material_id: quote.material_id,
        reason: 'material_missing',
        bestSimilarity: 0,
      });
      continue;
    }

    if (!quote.text.trim()) {
      dropped.push({
        quote_id: quote.quote_id,
        material_id: quote.material_id,
        reason: 'empty_quote',
        bestSimilarity: 0,
      });
      continue;
    }

    const found = locateInContext(contextFor(quote.material_id, text), quote.text, minSimilarity);
    if (!found) {
      dropped.push({
        quote_id: quote.quote_id,
        material_id: quote.material_id,
        reason: 'not_found',
        bestSimilarity: 0,
      });
      continue;
    }

    // 位置以程序计算结果为准，覆盖模型给的值
    kept.push({
      ...quote,
      location: {
        ...quote.location,
        char_start: found.start,
        char_end: found.end,
      },
      verified: found.verified,
    });
  }

  return { kept, dropped };
}

/** 把丢弃记录转成 7_parse_failures 条目，保证「丢了什么」有据可查。 */
export function toParseFailures(dropped: readonly DroppedQuote[]) {
  return dropped.map((d) => ({
    stage: 'quote_verify',
    code: 'QUOTE_NOT_VERIFIABLE',
    material_id: d.material_id,
    recoverable: d.reason !== 'material_missing',
  }));
}
