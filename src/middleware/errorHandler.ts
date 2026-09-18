/**
 * 全局错误处理。
 *
 * 客户端只会看到规范化结构 { error: { code, message }, requestId }，
 * 绝不返回堆栈、SQL、密钥或任何内部细节 —— 内部信息只进日志。
 */
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { normalizeError, NotFoundError } from '../errors';
import type { AppEnv } from '../types';
import type { Logger } from '../logger';

/**
 * 安全读取上下文字段。
 *
 * 错误可能发生在 requestContext 中间件之前（例如挂载顺序被改动），
 * 那时 c.get 会返回 undefined。直接 c.get('logger') 在类型上是 Logger，
 * 但运行时可能是 undefined，所以这里显式做存在性判断。
 */
function safeRequestId(c: Context<AppEnv>): string {
  try {
    const value = (c as unknown as { get: (k: string) => unknown }).get('requestId');
    return typeof value === 'string' && value.length > 0 ? value : 'unknown';
  } catch {
    return 'unknown';
  }
}

function safeLogger(c: Context<AppEnv>): Logger | undefined {
  try {
    const value = (c as unknown as { get: (k: string) => unknown }).get('logger');
    if (value && typeof value === 'object' && typeof (value as Logger).error === 'function') {
      return value as Logger;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const appError = normalizeError(err);

  const requestId = safeRequestId(c);
  const logger = safeLogger(c);

  const fields = {
    code: appError.code,
    httpStatus: appError.httpStatus,
    method: c.req.method,
    path: c.req.path,
    internal: appError.internal,
  };

  // 5xx 是「我们的问题」，4xx 是「调用方的问题」—— 分开记录便于告警
  if (appError.httpStatus >= 500) {
    logger?.error('request.error', fields);
  } else {
    logger?.warn('request.error', fields);
  }

  // 状态码来自受控的错误枚举，均在 Hono 接受范围内
  return c.json(appError.toResponse(requestId), appError.httpStatus as 400);
};

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) => {
  const err = new NotFoundError(`接口不存在: ${c.req.method} ${c.req.path}`);

  safeLogger(c)?.warn('request.not_found', { path: c.req.path, method: c.req.method });

  return c.json(err.toResponse(safeRequestId(c)), 404);
};
