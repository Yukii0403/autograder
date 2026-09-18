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

  const body: Record<string, unknown> = {
    model: config.DEEPSEEK_MODEL,
    messages: opts.messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature ?? 0,
    stream: false,
  };
  if (opts.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const maxAttempts = config.DEEPSEEK_MAX_RETRIES + 1;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();

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

    const content = payload.choices?.[0]?.message?.content ?? '';
    const trimmed = content.trim();

    // 空内容：DeepSeek JSON Output 的已知偶发行为，按可重试处理
    if (!trimmed) {
      lastError = new Error('empty content');
      logger.warn('llm.empty_content', {
        attempt,
        finishReason: payload.choices?.[0]?.finish_reason,
        durationMs,
      });
      if (attempt < maxAttempts) {
        await sleep(BACKOFF_MS[attempt - 1] ?? 8000);
        continue;
      }
      throw new LlmError('模型未返回内容，已重试仍为空', { attempts: attempt });
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
