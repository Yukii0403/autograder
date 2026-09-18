/**
 * 章节索引提取（纯函数）。
 *
 * 原设计里这一步要调一次模型。实际上 markdown 的标题结构用正则就能可靠解析，
 * 而程序化解析有三个好处：
 *   1. 确定性 —— 同一份文档永远得到同一份索引
 *   2. 零 token 成本、零延迟
 *   3. 章节位置直接来自解析器，比模型"目测"的位置准
 *
 * 索引的用途：让「未找到」这个结论有全局依据。没有它，分块抽取时
 * 「在别处但没看到」会被误报成「不存在」。
 */

export interface SectionEntry {
  /** 标题原文，不含 # 号 */
  title: string;
  /** 标题层级：1 表示 #，2 表示 ## */
  level: number;
  /** 该章节在原文中的起始偏移（指向标题行首） */
  start: number;
  /** 该章节的结束偏移（下一个同级或更高级标题的行首；末章为文本末尾） */
  end: number;
  /** 章节正文字符数（不含标题行） */
  charCount: number;
  /**
   * 是否为叶子章节（没有下级标题）。
   *
   * 切片时只用叶子章节 —— 父章节的范围包含子章节，若两者都参与挑选，
   * 内容会被重复送入模型，既浪费上下文又可能让同一条证据被报两次。
   */
  isLeaf: boolean;
}

export interface SectionIndex {
  sections: SectionEntry[];
  /** 代码块位置 */
  codeBlocks: Array<{ index: number; start: number; end: number; lang: string; lines: number }>;
  /** 全文去掉空白后的字符数，用于粗略判断材料是否单薄 */
  totalChars: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_RE = /^\s*```(\w*)\s*$/;

/**
 * 从 markdown 文本提取章节索引与代码块位置。
 *
 * 行首偏移用「累计换行」计算，而不是查找标题文本 —— 后者在标题重复时会取错位置。
 */
export function buildSectionIndex(text: string): SectionIndex {
  const lines = splitLines(text);

  interface Heading {
    title: string;
    level: number;
    start: number;
    lineIndex: number;
  }

  const headings: Heading[] = [];
  const codeBlocks: SectionIndex['codeBlocks'] = [];

  let offset = 0;
  let inFence = false;
  let fenceStart = 0;
  let fenceLang = '';
  let fenceStartLine = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;

    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceStart = offset;
        fenceLang = fence[1] ?? '';
        fenceStartLine = i;
      } else {
        inFence = false;
        codeBlocks.push({
          index: codeBlocks.length + 1,
          start: fenceStart,
          end: offset + line.length,
          lang: fenceLang,
          lines: i - fenceStartLine - 1,
        });
      }
      offset += line.length + 1;
      continue;
    }

    if (!inFence) {
      const heading = HEADING_RE.exec(line);
      if (heading) {
        headings.push({
          title: heading[2] ?? '',
          level: (heading[1] ?? '#').length,
          start: offset,
          lineIndex: i,
        });
      }
    }

    offset += line.length + 1;
  }

  // 未闭合的围栏：补一个到文末，避免代码块整段丢失
  if (inFence) {
    codeBlocks.push({
      index: codeBlocks.length + 1,
      start: fenceStart,
      end: text.length,
      lang: fenceLang,
      lines: lines.length - fenceStartLine - 1,
    });
  }

  const sections: SectionEntry[] = headings.map((h, i) => {
    // 结束位置 = 下一个「同级或更高级」标题的行首
    let end = text.length;
    for (let j = i + 1; j < headings.length; j += 1) {
      const next = headings[j] as Heading;
      if (next.level <= h.level) {
        end = next.start;
        break;
      }
    }
    const bodyStart = text.indexOf('\n', h.start);
    const bodyFrom = bodyStart >= 0 ? bodyStart + 1 : h.start;
    return {
      title: h.title,
      level: h.level,
      start: h.start,
      end,
      charCount: Math.max(0, end - bodyFrom),
      // 紧邻的下一个标题层级更深 → 说明本标题有子章节 → 不是叶子
      isLeaf: i + 1 >= headings.length || (headings[i + 1] as Heading).level <= h.level,
    };
  });

  return {
    sections,
    codeBlocks,
    totalChars: text.replace(/\s/g, '').length,
  };
}

/** 按换行切分，但保留行内容（不保留换行符本身，便于逐行计算偏移）。 */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** 渲染成人读的索引摘要，注入 prompt 用。控制长度，避免把上下文撑爆。 */
export function renderSectionIndex(index: SectionIndex, maxItems = 60): string {
  const lines: string[] = [];

  if (index.sections.length === 0) {
    lines.push('（该材料没有可识别的标题结构）');
  } else {
    for (const s of index.sections.slice(0, maxItems)) {
      lines.push(`${'#'.repeat(s.level)} ${s.title}　(${s.charCount} 字)`);
    }
    if (index.sections.length > maxItems) {
      lines.push(`… 另有 ${index.sections.length - maxItems} 个章节未列出`);
    }
  }

  lines.push('');
  lines.push(
    index.codeBlocks.length > 0
      ? `代码块：${index.codeBlocks.length} 个（${index.codeBlocks.map((c) => `${c.lang || 'plain'} ${c.lines} 行`).join('、')}）`
      : '代码块：无',
  );
  lines.push(`全文有效字符数：${index.totalChars}`);

  return lines.join('\n');
}

/**
 * 按评分点挑出相关切片。
 *
 * 朴素但有效：标题或正文里出现评分点关键词的章节优先，其余按长度补齐。
 * 不做向量检索 —— 在报告这种长度（几千字）下，全文塞进去往往比召回更划算。
 *
 * **只用叶子章节**：父章节的范围包含子章节，两者都参与挑选会导致内容重复，
 * 既浪费上下文，也可能让同一条证据被报两次。前言（首个标题之前的内容）单独
 * 作为一个候选，因为它常含标题、摘要这类高价值信息，却不在任何章节范围内。
 */
export function selectRelevantSections(
  text: string,
  index: SectionIndex,
  keywords: readonly string[],
  budgetChars: number,
): string {
  if (index.totalChars <= budgetChars) return text;

  interface Candidate {
    title: string;
    start: number;
    end: number;
  }

  const candidates: Candidate[] = [];

  const firstHeadingStart = index.sections.length > 0 ? (index.sections[0] as SectionEntry).start : text.length;
  if (text.slice(0, firstHeadingStart).replace(/\s/g, '').length > 0) {
    candidates.push({ title: '（前言）', start: 0, end: firstHeadingStart });
  }
  for (const s of index.sections) {
    if (s.isLeaf) candidates.push({ title: s.title, start: s.start, end: s.end });
  }

  const scored = candidates.map((c) => {
    const body = text.slice(c.start, c.end);
    let score = 0;
    for (const kw of keywords) {
      if (!kw) continue;
      if (c.title.includes(kw)) score += 3;
      score += Math.min(body.split(kw).length - 1, 5);
    }
    return { c, score, len: body.replace(/\s/g, '').length };
  });

  // 命中多、内容短的先放进来
  scored.sort((a, b) => b.score - a.score || a.c.start - b.c.start);

  const picked: Candidate[] = [];
  let used = 0;
  for (const { c, len } of scored) {
    if (used + len > budgetChars) continue;
    picked.push(c);
    used += len;
  }

  // 一个都放不下（例如单个章节就超预算）：退化为硬截断，至少不返回空
  if (picked.length === 0) return text.slice(0, budgetChars);

  picked.sort((a, b) => a.start - b.start);
  return picked
    .map((c) => `<!-- 切片：${c.title} -->\n${text.slice(c.start, c.end)}`)
    .join('\n\n');
}
