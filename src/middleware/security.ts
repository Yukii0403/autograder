/**
 * 安全头与 CORS。
 *
 * CORS 使用显式来源白名单，生产环境禁止通配符 —— 未命中白名单的来源不会拿到
 * Access-Control-Allow-Origin 头，浏览器会自行拦截。
 *
 * 这里直接读原始 env 而不走 getConfig：CORS 不应因为某个业务配置缺失而整体失效。
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    c.res.headers.set(k, v);
  }
};

export const cors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header('origin');
  const allowed = parseOrigins(c.env.ALLOWED_ORIGINS);
  const matched = origin && allowed.includes(origin) ? origin : undefined;

  c.set('allowedOrigin', matched);

  // 预检请求直接短路，不进入业务逻辑
  if (c.req.method === 'OPTIONS') {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Request-Id',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (matched) {
      headers['Access-Control-Allow-Origin'] = matched;
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
    return new Response(null, { status: 204, headers });
  }

  await next();

  // Vary 必须始终带上，否则 CDN 会把带与不带 CORS 头的响应混缓存
  c.res.headers.append('Vary', 'Origin');
  if (matched) {
    c.res.headers.set('Access-Control-Allow-Origin', matched);
    c.res.headers.set('Access-Control-Allow-Credentials', 'true');
  }
};
