/**
 * 评阅接口（M4）。
 *
 * 两个接口的分工是本模块的核心设计：
 *
 *   POST /api/grade            完整链路（抽取 + 匹配 + 算分），每次 4–6 次模型调用
 *   POST /api/grade/recompute  只算分，纯函数，毫秒级
 *
 * 为什么要拆开：教师复核时改一次档位，如果走完整链路就要重跑全部模型调用，
 * 等几十秒；而改档只影响算分，不该牵动模型。拆开之后复核页的交互是即时的 ——
 * 这是「教师确认与校准」这个环节能不能被用起来的前提。
 *
 * 挂载说明：本模块挂在 `/api/grade` 下（见 src/index.ts），
 * 所以这里的 `'/'` 对应 `/api/grade`，`'/recompute'` 对应 `/api/grade/recompute`。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { ValidationError } from '../errors';
import { rateLimit } from '../middleware/rateLimit';
import { getRubric } from '../services/rubricService';
import { gradeSubmission } from '../services/gradeService';
import { computeGrade, toFinalGrade, PASS_LINE_BAND, type LevelCode } from '../services/scoringService';
import { LevelMatchSchema } from '../schema';

export const gradeRoutes = new Hono<AppEnv>();

/**
 * 完整链路是重操作（每评分点 2 次模型调用），单独限流。
 * 只挂在 `'/'` 上 —— recompute 是纯计算，沿用 api 层的通用限流即可，
 * 不该被这个更严的限制误伤（复核时可能连点）。
 */
gradeRoutes.use('/', rateLimit({ route: 'grade.full', perMinute: () => 5 }));

const LevelCodeSchema = z.enum(['L1', 'L2', 'L3', 'L4']);

const GradeBodySchema = z.object({
  rubricId: z.string().min(3).max(64),
  materialId: z.string().min(1).max(64).default('m1'),
  text: z.string().min(1).max(400_000),
  criterionIds: z.array(z.string()).optional(),
  overrides: z
    .array(z.object({ criterionId: z.string().min(1), level: LevelCodeSchema }))
    .max(50)
    .optional(),
  confirmedBy: z.string().min(1).max(64).nullable().optional(),
});

gradeRoutes.post('/', async (c) => {
  const config = c.get('config')!;
  const logger = c.get('logger');
  const ownerId = c.get('ownerId');

  const body = await readJson(c.req.raw);

  const parsed = GradeBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(`请求体不合法：${formatIssues(parsed.error.issues)}`);
  }
  const input = parsed.data;

  const rubric = await getRubric(c.env.DB, ownerId, input.rubricId);

  const result = await gradeSubmission({
    config,
    logger,
    rubric,
    materialId: input.materialId,
    materialText: input.text,
    overrides: input.overrides,
    confirmedBy: input.confirmedBy ?? null,
    criterionIds: input.criterionIds,
  });

  return c.json({
    rubricId: rubric.rubric_id,
    rubricVersion: rubric.version,
    passLine: rubric.scoring.pass_line,
    grade: result.grade,
    explain: result.explain,
    dispositions: result.dispositions,
    matches: result.matches,
    stats: result.stats,
    notice: buildNotice(result.grade.has_pending_items, result.stats.pendingCount),
  });
});

// ────────────────────────────────────────────────────────────

const RecomputeBodySchema = z.object({
  rubricId: z.string().min(3).max(64),
  materialId: z.string().min(1).max(64).default('m1'),
  matches: z.array(LevelMatchSchema).max(50),
  overrides: z
    .array(z.object({ criterionId: z.string().min(1), level: LevelCodeSchema }))
    .max(50)
    .optional(),
  confirmedBy: z.string().min(1).max(64).nullable().optional(),
  /** 上一次的 grade_id，传入则保持不变 —— 便于前端做「同一份记录的修订」 */
  gradeId: z.string().min(1).max(64).optional(),
});

/**
 * 只重算分。
 *
 * 用于教师改档后的即时反馈：输入是本地的 matches（不改动）+ overrides，
 * 输出新的分数与逐分解释。不碰模型、不碰字符串匹配，因此是纯计算。
 */
gradeRoutes.post('/grade/recompute', async (c) => {
  const logger = c.get('logger');
  const ownerId = c.get('ownerId');

  const body = await readJson(c.req.raw);
  const parsed = RecomputeBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(`请求体不合法：${formatIssues(parsed.error.issues)}`);
  }
  const input = parsed.data;

  const rubric = await getRubric(c.env.DB, ownerId, input.rubricId);

  const now = new Date().toISOString();
  const gradeId = input.gradeId ?? `gr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const computeArgs = {
    gradeId,
    submissionId: `inline_${input.materialId}`,
    rubric,
    matches: input.matches,
    overrides: (input.overrides ?? []) as Array<{ criterionId: string; level: LevelCode }>,
    confirmedBy: input.confirmedBy ?? null,
    now,
  };

  const computed = computeGrade(computeArgs);
  const grade = toFinalGrade(computeArgs, computed);

  logger.info('grade.recomputed', {
    rubricId: rubric.rubric_id,
    overrideCount: computeArgs.overrides.length,
    finalTotal: grade.final_total,
    state: grade.state,
  });

  return c.json({
    rubricId: rubric.rubric_id,
    rubricVersion: rubric.version,
    passLine: rubric.scoring.pass_line,
    grade,
    pendingCriteria: computed.pendingCriteria,
    borderline: computed.borderline,
    notice: computed.borderline
      ? `总分落在及格线 ±${PASS_LINE_BAND} 分内，程序不给出及格结论，请人工确认`
      : buildNotice(grade.has_pending_items, computed.pendingCriteria.length),
  });
});

// ────────────────────────────────────────────────────────────

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ValidationError('请求体不是合法的 JSON');
  }
}

function formatIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('；');
}

function buildNotice(hasPending: boolean, pendingCount: number): string {
  return hasPending
    ? `有 ${pendingCount} 个评分点待人工确认，当前总分不是最终值。AI 仅提供建议，最终判定由教师做出。`
    : '全部评分点已完成自动定级，仍需教师确认后方可作为正式成绩。AI 仅提供建议，最终判定由教师做出。';
}
