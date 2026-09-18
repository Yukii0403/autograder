/**
 * 游客模式下的数据归属中间件。
 *
 * 前端首次访问时用 `crypto.randomUUID()` 生成一个 ID 存 localStorage，
 * 之后每个请求放在 `X-Visitor-Id` 头里。
 *
 * ⚠️ 明确的局限（必须让使用者知道）：
 *   - 这不是身份认证。任何人都能伪造任意 ID 读写他人的数据。
 *   - 数据不具备跨设备可携带性，清掉 localStorage 就找不回来了。
 *
 * 因此它只适用于演示与验证阶段。真实投入使用必须换成正式账号体系。
 * 之所以现在就用中间件固定下来，是为了将来替换时只改这一处。
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';

/** 接受 UUID 或同量级的随机十六进制串。不合法一律降级为 anonymous。 */
const VISITOR_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const ANONYMOUS_OWNER = 'anonymous';

export function resolveOwnerId(rawHeader: string | undefined | null): string {
  if (!rawHeader) return ANONYMOUS_OWNER;
  const trimmed = rawHeader.trim();
  return VISITOR_ID_RE.test(trimmed) ? trimmed : ANONYMOUS_OWNER;
}

export const visitor: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('ownerId', resolveOwnerId(c.req.header('x-visitor-id')));
  await next();
};
