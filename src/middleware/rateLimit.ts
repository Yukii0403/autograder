/**
 * 限流中间件。
 *
 * ⚠️ 当前实现是「单 isolate 内存计数」，属于 best-effort：
 *    Workers 会并行运行多个 isolate，每个 isolate 各有一份计数，
 *    因此实际放行量约为 `limit × isolate 数`，不能作为生产级限流。
 *
 * 生产化路径（M8）：改为 Durable Object（单点计数，强一致）或 KV + 滑动窗口。
 * 现在保留它有两个理由：一是中间件顺序需要尽早定型；二是对单机本地开发有效。
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { RateLimitedError } from '../errors';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_TRACKED_KEYS = 10_000;

function clientKey(c: { req: { header: (n: string) => string | undefined } }): string {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

export function rateLimit(opts: { route: string; perMinute: () => number; keyExtra?: string }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const now = Date.now();
    const windowMs = 60_000;
    const limit = opts.perMinute();
    const key = `${opts.route}:${opts.keyExtra ?? clientKey(c)}`;

    // 防止内存无限增长
    if (buckets.size > MAX_TRACKED_KEYS) {
      for (const [k, b] of buckets) {
        if (b.resetAt <= now) buckets.delete(k);
      }
    }

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    c.header('X-RateLimit-Reset', String(resetSeconds));

    if (bucket.count > limit) {
      c.get('logger').warn('ratelimit.exceeded', { route: opts.route, limit });
      throw new RateLimitedError(`操作过于频繁，请 ${resetSeconds} 秒后再试`);
    }

    await next();
  };
}
