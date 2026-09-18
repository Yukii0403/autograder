/**
 * 类型化错误体系。
 *
 * 规则：
 * - `code` 机器可读，前端据此映射用户文案
 * - `message` 面向用户，绝不包含堆栈、SQL、密钥等内部细节
 * - `internal` 只进日志，永不出现在响应里
 *
 * 参见 docs/技术方案.md 第 12.2 / 12.3 节。
 */

export type ErrorCode =
  | 'CONFIG_MISSING'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'PARSE_FAILED'
  | 'LLM_FAILED'
  | 'LLM_TIMEOUT'
  | 'QUOTE_NOT_VERIFIABLE'
  | 'JUDGEMENT_LEAK'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly internal: unknown;

  constructor(code: ErrorCode, httpStatus: number, message: string, internal?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.internal = internal;
  }

  /** 可直接返回给客户端的规范化结构，不含任何内部细节。 */
  toResponse(requestId: string) {
    return {
      error: { code: this.code, message: this.message },
      requestId,
    };
  }
}

export class ConfigError extends AppError {
  constructor(message = '服务配置缺失，请联系管理员', internal?: unknown) {
    super('CONFIG_MISSING', 500, message, internal);
  }
}

export class ValidationError extends AppError {
  constructor(message = '请求参数不合法', internal?: unknown) {
    super('VALIDATION_FAILED', 400, message, internal);
  }
}

export class NotFoundError extends AppError {
  constructor(message = '未找到对应资源', internal?: unknown) {
    super('NOT_FOUND', 404, message, internal);
  }
}

export class ParseError extends AppError {
  constructor(message = '无法解析该文件，请另存为 .docx 或提供文本版', internal?: unknown) {
    super('PARSE_FAILED', 422, message, internal);
  }
}

export class LlmError extends AppError {
  constructor(message = '模型服务暂时不可用，请稍后重试', internal?: unknown) {
    super('LLM_FAILED', 502, message, internal);
  }
}

export class LlmTimeoutError extends AppError {
  constructor(message = '模型响应超时，请稍后重试', internal?: unknown) {
    super('LLM_TIMEOUT', 504, message, internal);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = '操作过于频繁，请稍后再试', internal?: unknown) {
    super('RATE_LIMITED', 429, message, internal);
  }
}

/**
 * 观察层出现定性判断词汇。
 *
 * 这是三层防线里最硬的一层（程序后置扫描）。命中即拒收并重生成 ——
 * 观察层一旦混入"好/差/不合格"，下游所有结论都失去可信度。
 */
export class JudgementLeakError extends AppError {
  constructor(hit: string, field: string, internal?: unknown) {
    super('JUDGEMENT_LEAK', 422, `观察层出现定性判断词汇「${hit}」（字段 ${field}），已拒收`, internal);
  }
}

/** 某条引文无法在原文中定位 —— 不报错给用户，只用于内部记录与统计。 */
export class QuoteNotVerifiableError extends AppError {
  constructor(quoteId: string, internal?: unknown) {
    super('QUOTE_NOT_VERIFIABLE', 422, `引文 ${quoteId} 无法在原文中定位，已剔除`, internal);
  }
}

/** 未知异常一律归一化为 INTERNAL，绝不把原始信息透给客户端。 */
export function normalizeError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError('INTERNAL', 500, '服务器内部错误', err);
}
