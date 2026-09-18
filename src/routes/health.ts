/**
 * 健康检查。
 *
 * /health  存活检查：立即返回 200，不碰任何外部依赖。用于「进程还活着吗」。
 * /ready   就绪检查：校验配置加载、D1 连通、R2 可访问。任一失败返回 503。
 *          用于「现在能对外服务吗」。
 *
 * 两个端点都必须排除在限流之外，否则探针会被自己的限流挡住。
 *
 * 关于 R2：绑定不存在时报告 `skipped` 而非失败。理由是「未绑定」和「绑定了但坏了」
 * 是两回事 —— 前者是当前阶段的已知状态（M1–M4 不读写 R2），后者才需要告警。
 * 把两者混为一谈会让 /ready 永远 503，探测就失去意义了。
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { getConfig } from '../config';
import { VERSION } from '../version';

export const healthRoutes = new Hono<AppEnv>();

const PROBE_KEY = '__readiness_probe__';
const PROBE_TIMEOUT_MS = 3_000;

interface CheckResult {
  ok: boolean;
  detail?: string;
  /** 该项未配置因而跳过 —— 不是故障 */
  skipped?: boolean;
}

healthRoutes.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'autograder',
    version: VERSION,
    ts: new Date().toISOString(),
  }),
);

healthRoutes.get('/ready', async (c) => {
  const checks: Record<string, CheckResult> = {};

  try {
    getConfig(c.env);
    checks.config = { ok: true };
  } catch (err) {
    // 只报「哪些字段不合规」，绝不报字段的值 —— 字段名不是秘密，值才是。
    checks.config = { ok: false, detail: describeConfigIssues(err) };
  }

  // 先取出局部变量，让 TS 的窄化在 async 闭包里保持有效
  const files = c.env.FILES;

  const [db, r2] = await Promise.all([
    probe('d1', async () => {
      await c.env.DB.prepare('SELECT 1 AS ok').first();
    }),
    files
      ? probe('r2', async () => {
          await files.head(PROBE_KEY);
        })
      : Promise.resolve<CheckResult>({
          ok: true,
          skipped: true,
          detail: '未绑定 R2（当前代码未使用该资源；文档解析上线前需配置）',
        }),
  ]);
  checks.d1 = db;
  checks.r2 = r2;

  const ready = Object.values(checks).every((v) => v.ok);
  const requestId = c.get('requestId');

  if (!ready) {
    c.get('logger').warn('ready.failed', { checks });
  }

  return c.json({ status: ready ? 'ready' : 'not_ready', checks, requestId }, ready ? 200 : 503);
});

/** 带超时的探针，避免依赖卡住导致 /ready 挂死。 */
async function probe(name: string, fn: () => Promise<void>): Promise<CheckResult> {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS)),
    ]);
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: `${name} 不可用: ${(err as Error).message}` };
  }
}

/**
 * 把 ConfigError 里的字段级问题转成可读提示。
 *
 * 只输出字段路径与失败类型，**不输出任何字段值** —— 这样运维能定位问题，
 * 而万一响应被旁人看到也不会泄漏密钥。
 *
 * 常见 code 含义：
 *   invalid_type  字段缺失（或类型完全不对）
 *   too_small     字符串为空 / 数值过小
 *   invalid_format URL 等格式不合规
 *   invalid_value 枚举值不在允许范围内
 */
function describeConfigIssues(err: unknown): string {
  const internal = (err as { internal?: unknown })?.internal;
  const issues = (internal as { issues?: Array<{ path?: string; code?: string }> })?.issues;

  if (!Array.isArray(issues) || issues.length === 0) {
    return '配置缺失或非法';
  }

  const parts = issues
    .map((i) => {
      const field = i.path && i.path.length > 0 ? i.path : '(root)';
      return i.code ? `${field}[${i.code}]` : field;
    })
    .slice(0, 8);

  const more = issues.length > parts.length ? ` 等 ${issues.length} 项` : '';
  return `字段不合规：${parts.join('、')}${more}`;
}
