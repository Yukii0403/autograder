/**
 * 评分细则服务层。
 *
 * 承载业务规则：版本号自增、字段校验、以及「细则是否可被自动流程使用」的前置判断。
 * 不依赖请求/响应对象，可独立单测。
 */
import { z } from 'zod';
import { RubricSchema, type Rubric } from '../schema';
import { NotFoundError, ValidationError } from '../errors';
import * as repo from '../repo/rubricRepo';

/** 新建/更新时的输入：id 与 version 由服务端分配，不接受客户端指定。 */
export const RubricInputSchema = RubricSchema.omit({ rubric_id: true, version: true });
export type RubricInput = z.infer<typeof RubricInputSchema>;

export interface RubricSummary {
  rubricId: string;
  title: string;
  course: string;
  version: number;
  totalPoints: number;
  updatedAt: string;
}

/**
 * 业务校验：细则能不能被自动流程使用。
 *
 * 没有这一层的话，教师可能建出一份「全是定性判断」的细则 ——
 * 系统跑完只会得到一堆 needs_human，等于什么都没做。
 */
function assertUsable(rubric: Pick<Rubric, 'criteria'>): void {
  const executable = rubric.criteria.filter((c) => c.type === 'execution');

  if (executable.length === 0) {
    throw new ValidationError(
      '细则里至少要有一条「可机械核查」的评分点，否则自动流程无事可做。请把至少一条改为 execution 类型。',
    );
  }

  // 权重全为 0 会让归一化失去意义（虽然 schema 已保证每项为正，这里守住总和）
  const totalWeight = rubric.criteria.reduce((sum, c) => sum + c.weight, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    throw new ValidationError('评分点权重之和必须大于 0');
  }

  // 每个评分点的档位系数必须互不相同，否则档位无法区分
  for (const c of rubric.criteria) {
    const ratios = new Set(c.levels.map((l) => l.score_ratio));
    if (ratios.size !== c.levels.length) {
      throw new ValidationError(`评分点「${c.name}」的档位系数存在重复，档位之间应可区分`);
    }
  }
}

function parseInput(input: unknown): RubricInput {
  const parsed = RubricInputSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('；');
    throw new ValidationError(`细则格式不合法：${issues}`);
  }
  return parsed.data;
}

function rowToRubric(row: repo.RubricRow): Rubric {
  return {
    rubric_id: row.rubric_id,
    title: row.title,
    course: row.course,
    version: row.version,
    total_points: row.total_points,
    criteria: JSON.parse(row.criteria_json),
    scoring: JSON.parse(row.scoring_json),
  };
}

// ────────────────────────────────────────────────────────────

export async function createRubric(
  db: D1Database,
  ownerId: string,
  rawInput: unknown,
  now: string,
): Promise<Rubric> {
  const input = parseInput(rawInput);
  assertUsable(input);

  // 版本号按「同一 owner + 同一标题」自增，便于同一门课的细则迭代留痕
  const version = (await repo.maxVersion(db, ownerId, input.title)) + 1;
  const rubricId = `rb_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

  await repo.insertRubric(db, {
    rubricId,
    title: input.title,
    course: input.course,
    version,
    totalPoints: input.total_points,
    criteriaJson: JSON.stringify(input.criteria),
    scoringJson: JSON.stringify(input.scoring),
    ownerId,
    now,
  });

  return { ...input, rubric_id: rubricId, version };
}

export async function listRubrics(db: D1Database, ownerId: string): Promise<RubricSummary[]> {
  const rows = await repo.listRubricRows(db, ownerId);
  return rows.map((r) => ({
    rubricId: r.rubric_id,
    title: r.title,
    course: r.course,
    version: r.version,
    totalPoints: r.total_points,
    updatedAt: r.updated_at,
  }));
}

export async function getRubric(db: D1Database, ownerId: string, rubricId: string): Promise<Rubric> {
  const row = await repo.getRubricRow(db, ownerId, rubricId);
  if (!row) throw new NotFoundError('未找到该评分细则');
  return rowToRubric(row);
}

/**
 * 更新细则。
 *
 * 注意：**版本号不加**。改内容属于原地修订；只有需要留档的重大变更才应升版本。
 * 若将来要支持「升版本」，应新增一个 fork 接口，而不是让 update 隐式改版本 ——
 * 否则历史评分记录与细则版本会对不上。
 */
export async function updateRubric(
  db: D1Database,
  ownerId: string,
  rubricId: string,
  rawInput: unknown,
  now: string,
): Promise<Rubric> {
  const input = parseInput(rawInput);
  assertUsable(input);

  const existing = await repo.getRubricRow(db, ownerId, rubricId);
  if (!existing) throw new NotFoundError('未找到该评分细则');

  const changes = await repo.updateRubricRow(db, {
    rubricId,
    title: input.title,
    course: input.course,
    version: existing.version,
    totalPoints: input.total_points,
    criteriaJson: JSON.stringify(input.criteria),
    scoringJson: JSON.stringify(input.scoring),
    ownerId,
    now,
  });

  if (changes === 0) throw new NotFoundError('未找到该评分细则');

  return { ...input, rubric_id: rubricId, version: existing.version };
}

export async function deleteRubric(
  db: D1Database,
  ownerId: string,
  rubricId: string,
): Promise<void> {
  const changes = await repo.deleteRubricRow(db, ownerId, rubricId);
  if (changes === 0) throw new NotFoundError('未找到该评分细则');
}
