/**
 * 配置集中校验。
 *
 * 原则：所有配置来自环境变量，在首次请求时集中校验并缓存，缺失或非法即快速失败。
 * 绝不把密钥写进代码或 wrangler.jsonc —— DEEPSEEK_API_KEY 走 `wrangler secret put`。
 *
 * 参见 docs/技术方案.md 第 12.1 节。
 */
import { z } from 'zod';
import { ConfigError } from './errors';

const boolFromString = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase()),
  );

const originsFromString = z
  .string()
  .min(1, 'ALLOWED_ORIGINS 不能为空')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  .refine((arr) => arr.length > 0, 'ALLOWED_ORIGINS 至少需要一个来源');

const RawEnvSchema = z.object({
  // 模型接入 —— DEEPSEEK_API_KEY 为 secret，其余为 vars
  DEEPSEEK_API_KEY: z.string().min(1, '缺少 DEEPSEEK_API_KEY（本地放 .dev.vars，线上用 wrangler secret put）'),
  DEEPSEEK_BASE_URL: z.url('DEEPSEEK_BASE_URL 必须是合法 URL'),
  DEEPSEEK_MODEL: z.string().min(1, '缺少 DEEPSEEK_MODEL'),
  DEEPSEEK_TIMEOUT_MS: z.coerce.number().int().positive(),
  DEEPSEEK_MAX_RETRIES: z.coerce.number().int().min(0).max(5),

  // 跨域
  ALLOWED_ORIGINS: originsFromString,

  // 限流
  RATE_LIMIT_GRADE_PER_MIN: z.coerce.number().int().positive(),
  RATE_LIMIT_UPLOAD_PER_MIN: z.coerce.number().int().positive(),

  // 上传
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive(),

  // 证据链硬门槛
  QUOTE_VERIFY_MIN_SIMILARITY: z.coerce.number().min(0.5).max(1),
  EVIDENCE_EXTRACT_CONCURRENCY: z.coerce.number().int().min(1).max(6),

  // 日志
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']),

  // 演示降级
  DEMO_FALLBACK_ENABLED: boolFromString,
});

export type EnvConfig = z.infer<typeof RawEnvSchema>;

/** Worker 运行时可见的全部绑定（含非配置类绑定）。 */
export interface Bindings {
  DB: D1Database;
  /**
   * 原始文件与解析产物。
   *
   * ⚠️ 声明为可选：本地 `wrangler dev --local` 用的是模拟 R2，
   * **本地 /ready 通过不代表线上存在同名 bucket**（这是实际踩过的坑）。
   * 若账号未开通 R2（需要绑定支付方式），可从 wrangler.jsonc 注释掉该绑定后再部署，
   * 代码不会因此崩溃 —— M1–M4 没有任何地方读写它，只有健康检查做探针。
   * M2.5 接入文档解析后该绑定变为必需，届时调用处必须自行判空。
   */
  FILES?: R2Bucket;
  /**
   * Workers AI。
   *
   * ⚠️ 声明为可选：该绑定会让 `wrangler dev` 走 remote 模式（需要 cloudflared 隧道），
   * 在代理环境下不可用，因此 wrangler.jsonc 里默认是注释掉的。
   * M2.5 接入文档解析（`env.AI.toMarkdown`）时再启用，且调用处必须自行判空。
   */
  AI?: Ai;
  ASSETS?: Fetcher;

  DEEPSEEK_API_KEY: string;
  DEEPSEEK_BASE_URL: string;
  DEEPSEEK_MODEL: string;
  DEEPSEEK_TIMEOUT_MS: string;
  DEEPSEEK_MAX_RETRIES: string;
  ALLOWED_ORIGINS: string;
  RATE_LIMIT_GRADE_PER_MIN: string;
  RATE_LIMIT_UPLOAD_PER_MIN: string;
  MAX_UPLOAD_BYTES: string;
  QUOTE_VERIFY_MIN_SIMILARITY: string;
  EVIDENCE_EXTRACT_CONCURRENCY: string;
  LOG_LEVEL: string;
  DEMO_FALLBACK_ENABLED: string;
}

let cached: EnvConfig | null = null;

/** 已校验的配置。首次调用时校验，之后走缓存。校验失败抛 ConfigError。 */
export function getConfig(env: Bindings): EnvConfig {
  if (cached) return cached;

  const parsed = RawEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    // 只把字段名与规则写进日志，不回显任何值
    throw new ConfigError('服务配置缺失或非法，请联系管理员', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
      summary: details,
    });
  }

  cached = parsed.data;
  return cached;
}

/** 仅供测试使用：清空配置缓存。 */
export function resetConfigCache(): void {
  cached = null;
}
