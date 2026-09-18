/**
 * DeepSeek 客户端。
 *
 * 三件事必须在这里做对，否则上游全乱：
 *   1. **超时** —— 用 AbortSignal.timeout，绝不无限等
 *   2. **重试** —— 只对 429 与 5xx 重试；4xx（含参数错误、鉴权失败）重试没有意义
 *   3. **空内容视为可重试失败** —— DeepSeek 的 JSON Output 模式已知会偶发返回空 content，
 *      这不是格式错误，而是"这次没生成出来"，重试通常就好了
 *
 * 时间由调用方注入不现实（fetch 需要真实超时控制），因此这里是唯一使用真实计时器的地方。
 */
import type { EnvConfig } from '../config';
import type { Logger } from '../logger';
import { LlmError, LlmTimeoutError } from '../errors';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  messages: ChatMessage[];
  maxTokens: number;
  /** 评分场景固定为 0，保证可复现 */
  temperature?: number;
  /** 开启 JSON Output 模式 */
  jsonMode?: boolean;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  content: string;
  usage: ChatUsage;
  model: string;
  attempts: number;
}

/** 指数退避的可重试状态码。 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const BACKOFF_MS = [500, 2000, 8000];

/**
 * 输出长度的上限天花板。
 *
 * DeepSeek 的 max output 通常为 8192，设得更高会被上游拒绝或静默截断，
 * 所以放大时不越过这个值。
 */
const MAX_OUTPUT_TOKENS = 8192;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DeepSeekChoice {
  message?: { content?: string | null };
  finish_reason?: string;
}

interface DeepSeekResponse {
  id?: string;
  model?: string;
  choices?: DeepSeekChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

function buildBody(
  config: EnvConfig,
  opts: ChatOptions,
  maxTokens: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.DEEPSEEK_MODEL,
    messages: opts.messages,
    max_tokens: maxTokens,
    temperature: opts.temperature ?? 0,
    stream: false,
  };
  if (opts.jsonMode) {
    body.response_format = { type: 'json_object' };
  }
  return body;
}

/**
 * 调用 chat completions。
 *
 * @throws LlmTimeoutError 超时
 * @throws LlmError        重试耗尽、响应结构异常、或返回空内容
 */
export async function chat(
  config: EnvConfig,
  opts: ChatOptions,
  logger: Logger,
): Promise<ChatResult> {
  const url = `${config.DEEPSEEK_BASE_URL.replace(/\/+$/, '')}/chat/completions`;

  const maxAttempts = config.DEEPSEEK_MAX_RETRIES + 1;
  let lastError: unknown = null;

  /**
   * 自适应的输出上限。
   *
   * 推理型模型（带思考链的版本）会先把 token 花在内部推理上，固定上限不可靠。
   * 实测：`max_tokens: 1500` 时推理吃光全部配额，content 返回空、
   * finish_reason 为 "length"，重试 3 次全是空 —— 因为**同样的参数重试
   * 遇到的是同样的上限**，原地重试毫无意义。
   *
   * 检测到 length 截断就把上限翻倍，最多到 MAX_OUTPUT_TOKENS。
   */
  let maxTokens = opts.maxTokens;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    const body = buildBody(config, opts, maxTokens);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.DEEPSEEK_TIMEOUT_MS),
      });
    } catch (err) {
      // AbortSignal.timeout 触发时抛的是 TimeoutError
      const isTimeout = (err as Error)?.name === 'TimeoutError';
      lastError = err;
      logger.warn('llm.fetch_failed', {
        attempt,
        isTimeout,
        // 不记录 err.message 全文，避免把请求细节带进日志
        errName: (err as Error)?.name,
      });
      if (attempt < maxAttempts) {
        await sleep(BACKOFF_MS[attempt - 1] ?? 8000);
        continue;
      }
      throw isTimeout
        ? new LlmTimeoutError('模型响应超时，请稍后重试', { attempts: attempt })
        : new LlmError('无法连接模型服务，请稍后重试', { attempts: attempt });
    }

    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const text = await safeText(response);
      logger.warn('llm.http_error', { attempt, status: response.status, durationMs });

      if (RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts) {
        await sleep(BACKOFF_MS[attempt - 1] ?? 8000);
        continue;
      }

      // 4xx 不重试；错误信息只保留状态码，不透传上游原文
      throw new LlmError(`模型服务返回 ${response.status}`, {
        status: response.status,
        bodyPreview: text.slice(0, 300),
      });
    }

    const payload = (await response.json().catch(() => null)) as DeepSeekResponse | null;
    if (!payload) {
      lastError = new Error('invalid json from upstream');
      if (attempt < maxAttempts) continue;
      throw new LlmError('模型服务返回了无法解析的响应', { attempts: attempt });
    }

    const choice = payload.choices?.[0];
    const content = choice?.message?.content ?? '';
    const trimmed = content.trim();
    const finishReason = choice?.finish_reason;

    // 空内容：两种情况都按可重试处理，但原因不同
    if (!trimmed) {
      const truncated = finishReason === 'length';
      if (truncated) {
        // 已知原因就是上限不够 —— 放大上限再试，而不是原地重复
        maxTokens = Math.min(maxTokens * 2, MAX_OUTPUT_TOKENS);
      }
      lastError = new Error(truncated ? 'output truncated' : 'empty content');
      logger.warn('llm.empty_content', {
        attempt,
        finishReason,
        truncated,
        nextMaxTokens: truncated ? maxTokens : undefined,
        durationMs,
      });
      if (attempt < maxAttempts) {
        await sleep(BACKOFF_MS[attempt - 1] ?? 8000);
        continue;
      }
      throw new LlmError(
        truncated
          ? `模型输出被长度上限截断（max_tokens=${maxTokens}），已重试仍无内容`
          : '模型未返回内容，已重试仍为空',
        { attempts: attempt, finishReason },
      );
    }

    const usage: ChatUsage = {
      promptTokens: payload.usage?.prompt_tokens ?? 0,
      completionTokens: payload.usage?.completion_tokens ?? 0,
      totalTokens: payload.usage?.total_tokens ?? 0,
    };

    logger.info('llm.completed', {
      attempt,
      durationMs,
      model: payload.model ?? config.DEEPSEEK_MODEL,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      // 记下截断信号：正常完成是 "stop"，"length" 说明输出可能不完整
      finishReason,
      maxTokens,
      // 只记长度不记内容 —— 报告原文与模型输出都不进日志
      contentChars: trimmed.length,
    });

    return {
      content: trimmed,
      usage,
      model: payload.model ?? config.DEEPSEEK_MODEL,
      attempts: attempt,
    };
  }

  throw new LlmError('模型调用失败', { attempts: maxAttempts, lastError: String(lastError) });
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
