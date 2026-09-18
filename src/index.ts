/**
 * Worker 入口：装配中间件顺序并挂载路由。
 *
 * 中间件顺序（自上而下依次执行）：
 *   1. requestContext   生成 requestId、装配 logger
 *   2. securityHeaders  安全响应头
 *   3. cors             显式来源白名单
 *   4. requireConfig    业务路由的配置校验（仅 /api/*）
 *   5. rateLimit        限流
 *
 * 参见 docs/技术方案.md 第 3 章与第 12 章。
 */
import { Hono } from 'hono';
import type { AppEnv } from './types';
import { requestContext } from './middleware/requestContext';
import { requireConfig } from './middleware/requireConfig';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { cors, securityHeaders } from './middleware/security';
import { rateLimit } from './middleware/rateLimit';
import { visitor } from './middleware/visitor';
import { healthRoutes } from './routes/health';
import { rubricRoutes } from './routes/rubrics';
import { evidenceRoutes } from './routes/evidence';
import { gradeRoutes } from './routes/grade';
import { VERSION } from './version';

const app = new Hono<AppEnv>();

// ── 全局错误处理：必须最先注册 ────────────────────────
app.onError(errorHandler);
app.notFound(notFoundHandler);

// ── 全局中间件 ────────────────────────────────────────
app.use('*', requestContext);
app.use('*', securityHeaders);
app.use('*', cors);

// ── 健康检查：排除在配置校验与限流之外 ────────────────
app.route('/', healthRoutes);

// ── 业务 API ──────────────────────────────────────────
const api = new Hono<AppEnv>();
api.use('*', requireConfig);
api.use('*', visitor);
api.use('*', rateLimit({ route: 'api', perMinute: () => 120 }));

api.get('/version', (c) =>
  c.json({
    version: VERSION,
    model: c.get('config')!.DEEPSEEK_MODEL,
    ts: new Date().toISOString(),
  }),
);

// 已挂载
api.route('/rubrics', rubricRoutes);    // M2 评分细则 CRUD
api.route('/evidence', evidenceRoutes); // M3 证据抽取（观察层）
api.route('/grade', gradeRoutes);       // M4 等级匹配与确定性算分

// 后续里程碑在此挂载：
//   api.route('/submissions', submissionRoutes); // M2.5 上传与文档解析
//   api.route('/review', reviewRoutes);          // M5 教师复核与校准

app.route('/api', api);

export default app;
