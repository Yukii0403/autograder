/**
 * 评分细则接口（控制器层）。
 *
 * 职责边界：解析请求、做形状校验、调服务、格式化响应。
 * **不写业务逻辑** —— 版本号、可用性校验都在 service 里。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { ValidationError } from '../errors';
import * as service from '../services/rubricService';

export const rubricRoutes = new Hono<AppEnv>();

const RubricIdSchema = z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/);

async function readJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ValidationError('请求体不是合法的 JSON');
  }
}

function parseRubricId(raw: string | undefined): string {
  const parsed = RubricIdSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('评分细则 ID 格式不合法');
  return parsed.data;
}

/** GET /api/rubrics —— 列表（不含 criteria，避免大字段拖慢列表页） */
rubricRoutes.get('/', async (c) => {
  const items = await service.listRubrics(c.env.DB, c.get('ownerId'));
  return c.json({ items, total: items.length });
});

/** POST /api/rubrics —— 新建，版本号按同标题自增 */
rubricRoutes.post('/', async (c) => {
  const body = await readJsonBody(c);
  const rubric = await service.createRubric(
    c.env.DB,
    c.get('ownerId'),
    body,
    new Date().toISOString(),
  );

  c.get('logger').info('rubric.created', {
    rubricId: rubric.rubric_id,
    version: rubric.version,
    criteriaCount: rubric.criteria.length,
  });

  return c.json({ rubric }, 201);
});

/** GET /api/rubrics/:rubricId */
rubricRoutes.get('/:rubricId', async (c) => {
  const rubricId = parseRubricId(c.req.param('rubricId'));
  const rubric = await service.getRubric(c.env.DB, c.get('ownerId'), rubricId);
  return c.json({ rubric });
});

/** PUT /api/rubrics/:rubricId —— 原地修订，版本号不变（见 service 注释） */
rubricRoutes.put('/:rubricId', async (c) => {
  const rubricId = parseRubricId(c.req.param('rubricId'));
  const body = await readJsonBody(c);

  const rubric = await service.updateRubric(
    c.env.DB,
    c.get('ownerId'),
    rubricId,
    body,
    new Date().toISOString(),
  );

  c.get('logger').info('rubric.updated', { rubricId });
  return c.json({ rubric });
});

/** DELETE /api/rubrics/:rubricId */
rubricRoutes.delete('/:rubricId', async (c) => {
  const rubricId = parseRubricId(c.req.param('rubricId'));
  await service.deleteRubric(c.env.DB, c.get('ownerId'), rubricId);

  c.get('logger').info('rubric.deleted', { rubricId });
  return c.body(null, 204);
});
