/**
 * 模型 JSON 输出的降级链。
 *
 * 模型不总是听话：会包 ```json 围栏、会在 JSON 前后加解释、会留尾随逗号、
 * 会少写一个右花括号。这些都能修，不该直接判失败。
 *
 * 但修复有边界 —— **能修就修，修不好就明确失败**，绝不猜内容。
 * 「宁可标记为需要人工，也不静默填充一个猜测值」。
 */
import { LlmError } from '../errors';

/** 从 ```json ... ``` 围栏中取出内容（也兼容没有语言标识的围栏）。 */
export function extractFence(text: string): string | null {
  const match = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(text);
  return match?.[1]?.trim() ?? null;
}

/** 从「前后有解释文字」的响应里取出最外层 JSON 对象。 */
export function extractBraced(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * 去掉尾随逗号。
 *
 * 逐字符扫描而非正则替换 —— 正则会误伤字符串里的 ",]"，例如
 * `{"text": "见附录 A, ] 部分"}`。字符串状态必须跟踪。
 */
export function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }

    if (!inString && ch === ',') {
      // 向后看第一个非空白字符，是 } 或 ] 就丢弃这个逗号
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j += 1;
      const next = text[j];
      if (next === '}' || next === ']') continue;
    }

    out += ch;
  }

  return out;
}

/** 补齐未闭合的 { 与 [（字符串内的括号不计数）。 */
export function balanceBrackets(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }

  let out = text;
  while (stack.length > 0) {
    const open = stack.pop();
    out += open === '{' ? '}' : ']';
  }
  return out;
}

/** 单次解析尝试中实际走到的步骤，便于排查「到底卡在哪一步」。 */
export interface ParseAttempt {
  step: string;
  ok: boolean;
}

export interface ParseJsonResult {
  value: unknown;
  /** 最终生效的那一步 */
  step: string;
  attempts: ParseAttempt[];
}

/**
 * 按降级链解析模型输出。
 *
 * 顺序：原样 → 去围栏 → 取最外层花括号 → 去尾随逗号 → 补括号 → 组合
 *
 * @throws LlmError 全部尝试失败
 */
export function parseModelJson(raw: string): ParseJsonResult {
  const text = raw.replace(/^\uFEFF/, '').trim();
  const attempts: ParseAttempt[] = [];

  const bases: Array<{ step: string; text: string }> = [{ step: 'raw', text }];

  const fenced = extractFence(text);
  if (fenced) bases.push({ step: 'fence', text: fenced });

  const braced = extractBraced(text);
  if (braced) bases.push({ step: 'braced', text: braced });

  for (const base of bases) {
    const variants: Array<{ step: string; text: string }> = [
      { step: base.step, text: base.text },
      { step: `${base.step}+stripComma`, text: stripTrailingCommas(base.text) },
      { step: `${base.step}+balance`, text: balanceBrackets(base.text) },
      {
        step: `${base.step}+stripComma+balance`,
        text: balanceBrackets(stripTrailingCommas(base.text)),
      },
    ];

    for (const v of variants) {
      try {
        const value = JSON.parse(v.text);
        attempts.push({ step: v.step, ok: true });
        return { value, step: v.step, attempts };
      } catch {
        attempts.push({ step: v.step, ok: false });
      }
    }
  }

  throw new LlmError('模型返回的内容无法解析为 JSON', {
    attempts,
    // 只留前 300 字符，避免把整段输出写进日志
    preview: text.slice(0, 300),
  });
}

/**
 * 判定一次解析是否「需要再试一次」。
 *
 * 空 content 是 DeepSeek JSON Output 的已知偶发行为 —— 它不是格式问题，
 * 而是这次没生成出来。这类情况重试通常就好，不该直接判失败。
 */
export function isRetryableContent(raw: string): boolean {
  return raw.trim().length === 0;
}

/**
 * 归一化模型输出：递归删除值为 null 的字段与数组元素。
 *
 * 为什么需要 —— JSON Output 模式下，模型习惯把「不知道」写成 null，
 * 而 Zod 的 `.optional()` 只接受 undefined。实测后果很重：
 *
 *   2_found_quotes[0].location.page: Invalid input: expected number, received null
 *
 * 一份完全可用的观察层会因此被判非法，触发 3 次无用重试（每次约 14 秒），
 * 一次请求白烧 43 秒，最后整项转人工。这不是模型答错了，是表示法差异。
 *
 * 为什么不直接把 schema 放宽 —— 契约的严格性拦的是**真错误**（缺必填字段、
 * 枚举越界、类型不对），那部分价值不能丢。而 null 只是同一个意思的另一种写法。
 * 在边界处做表示法归一化，比放松契约更合适，也就是「宽容输入，严格输出」。
 *
 * 对 `.nullable().default(null)` 的字段（如 `rule_applied`）无害：
 * null 被删掉后由 default 补回，语义不变。
 */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== null).map(stripNulls);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === null) continue;
      out[key] = stripNulls(item);
    }
    return out;
  }
  return value;
}
