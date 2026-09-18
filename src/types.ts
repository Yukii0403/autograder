import type { Context } from 'hono';
import type { Bindings, EnvConfig } from './config';
import type { Logger } from './logger';
import { getConfig } from './config';

/** 请求级上下文，通过 Hono 的 c.set / c.get 传递。 */
export interface AppVariables {
  requestId: string;
  logger: Logger;
  /** 命中 ALLOWED_ORIGINS 的来源，未命中为 undefined */
  allowedOrigin: string | undefined;
  /**
   * 数据归属标识（游客模式）。
   *
   * ⚠️ 这不是身份认证，只是数据隔离。前端生成一个随机 ID 放在 X-Visitor-Id 头里，
   * 任何人都可以伪造 —— 因此它绝不能用来承载任何需要保护的数据。
   * 真实投入使用前必须替换为正式账号体系。
   */
  ownerId: string;
  /**
   * 已校验配置。仅在经过 requireConfig 中间件的路由上可用。
   * 健康检查故意不走该校验 —— 存活探针不应依赖业务配置。
   */
  config?: EnvConfig;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: AppVariables;
};

/** 取已校验配置；未经过 requireConfig 时现场校验并缓存。 */
export function requireConfig(c: Context<AppEnv>): EnvConfig {
  const cached = c.get('config');
  if (cached) return cached;
  const resolved = getConfig(c.env);
  c.set('config', resolved);
  return resolved;
}
