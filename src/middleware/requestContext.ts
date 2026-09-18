/**
 * 请求上下文中间件：生成 requestId 并装配 logger。
 *
 * 顺序要求：必须最先挂载 —— 后续所有中间件与路由都依赖 requestId 与 logger。
 *
 * 注意：这里**不**做配置校验。存活探针 /health 不应因为业务配置缺失而失败。
 * 配置校验由 requireConfig 在业务路由上完成（见 middleware/requireConfig.ts）。
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { createLogger } from '../logger';

/** 优先沿用上游传入的追踪 ID，否则生成一个。 */
function resolveRequestId(header: string | undefined | null): string {
  if (header && /^[\w.:-]{1,128}$/.test(header)) return header;
  return `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = resolveRequestId(c.req.header('cf-ray') ?? c.req.header('x-request-id'));
  const logger = createLogger(c.env.LOG_LEVEL ?? 'info').child({ requestId });

  c.set('requestId', requestId);
  c.set('logger', logger);

  const startedAt = Date.now();
  logger.debug('request.start', { method: c.req.method, path: c.req.path });

  await next();

  logger.info('request.end', {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - startedAt,
  });
};
