/**
 * 评分细则仓储。
 *
 * 只负责数据访问，不含业务判断 —— 版本号怎么算、字段合法与否，都归 service。
 */
import { execute, queryAll, queryFirst } from './db';

/** 数据库行。字段名与 migrations/0001_init.sql 一一对应。 */
export interface RubricRow {
  rubric_id: string;
  title: string;
  course: string;
  version: number;
  total_points: number;
  criteria_json: string;
  scoring_json: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface RubricWriteInput {
  rubricId: string;
  title: string;
  course: string;
  version: number;
  totalPoints: number;
  criteriaJson: string;
  scoringJson: string;
  ownerId: string;
  now: string;
}

const COLUMNS = `rubric_id, title, course, version, total_points,
                 criteria_json, scoring_json, owner_id, created_at, updated_at`;

export async function insertRubric(db: D1Database, input: RubricWriteInput): Promise<void> {
  await execute(
    db,
    `INSERT INTO rubric (${COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.rubricId,
      input.title,
      input.course,
      input.version,
      input.totalPoints,
      input.criteriaJson,
      input.scoringJson,
      input.ownerId,
      input.now,
      input.now,
    ],
  );
}

/** 列表不带 criteria_json —— 列表页不需要，避免把大字段全捞出来。 */
export async function listRubricRows(
  db: D1Database,
  ownerId: string,
): Promise<Array<Omit<RubricRow, 'criteria_json' | 'scoring_json'>>> {
  return queryAll<Omit<RubricRow, 'criteria_json' | 'scoring_json'>>(
    db,
    `SELECT rubric_id, title, course, version, total_points, owner_id, created_at, updated_at
       FROM rubric
      WHERE owner_id = ?
      ORDER BY updated_at DESC
      LIMIT 200`,
    [ownerId],
  );
}

export async function getRubricRow(
  db: D1Database,
  ownerId: string,
  rubricId: string,
): Promise<RubricRow | null> {
  return queryFirst<RubricRow>(
    db,
    `SELECT ${COLUMNS} FROM rubric WHERE owner_id = ? AND rubric_id = ?`,
    [ownerId, rubricId],
  );
}

/** 取同一 owner + 同一标题下的最大版本号，用于自增。 */
export async function maxVersion(
  db: D1Database,
  ownerId: string,
  title: string,
): Promise<number> {
  const row = await queryFirst<{ v: number | null }>(
    db,
    `SELECT MAX(version) AS v FROM rubric WHERE owner_id = ? AND title = ?`,
    [ownerId, title],
  );
  return row?.v ?? 0;
}

/** 返回受影响行数。0 表示目标不存在或不属于该 owner。 */
export async function updateRubricRow(
  db: D1Database,
  input: Omit<RubricWriteInput, 'version'> & { version: number },
): Promise<number> {
  const result = await execute(
    db,
    `UPDATE rubric
        SET title = ?, course = ?, version = ?, total_points = ?,
            criteria_json = ?, scoring_json = ?, updated_at = ?
      WHERE owner_id = ? AND rubric_id = ?`,
    [
      input.title,
      input.course,
      input.version,
      input.totalPoints,
      input.criteriaJson,
      input.scoringJson,
      input.now,
      input.ownerId,
      input.rubricId,
    ],
  );
  return result.meta.changes ?? 0;
}

export async function deleteRubricRow(
  db: D1Database,
  ownerId: string,
  rubricId: string,
): Promise<number> {
  const result = await execute(
    db,
    `DELETE FROM rubric WHERE owner_id = ? AND rubric_id = ?`,
    [ownerId, rubricId],
  );
  return result.meta.changes ?? 0;
}
