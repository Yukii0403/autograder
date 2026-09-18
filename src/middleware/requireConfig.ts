/**
 * 业务路由的配置校验中间件。
 *
 * 挂载在所有 /api/* 路由上。配置缺失或非法时抛出 ConfigError，
 * 由全局错误处理器返回 500 + CONFIG_MISSING，客户端不会看到任何内部细节。
 *
 * 为什么不放在 requestContext 里：/health 作为存活探针必须在配置损坏时依然可用，
 * 否则「服务活着但配置错了」这种情况无法被区分出来。
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { getConfig } from '../config';

export const requireConfig: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('config', getConfig(c.env));
  await next();
};
