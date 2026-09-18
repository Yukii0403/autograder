/**
 * D1 薄封装。
 *
 * 目标只有一个：把 `prepare().bind().first()` 这套样板收拢到一处，
 * 让仓储层读起来是业务而不是 SQL 驱动细节。
 *
 * 刻意不做的事：
 *   - 不做 ORM（D1 是 SQLite，手写 SQL 更可控，也更好排查）
 *   - 不吞异常（错误照常抛出，由全局错误处理器归一化）
 */

/** 查询单行。无结果返回 null（D1 本身返回 null，这里保持语义）。 */
export async function queryFirst<T>(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const stmt = db.prepare(sql);
  const bound = params.length > 0 ? stmt.bind(...params) : stmt;
  return (await bound.first<T>()) ?? null;
}

/** 查询多行。 */
export async function queryAll<T>(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const stmt = db.prepare(sql);
  const bound = params.length > 0 ? stmt.bind(...params) : stmt;
  const result = await bound.all<T>();
  return result.results ?? [];
}

/** 执行写操作。 */
export async function execute(
  db: D1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<D1Result> {
  const stmt = db.prepare(sql);
  const bound = params.length > 0 ? stmt.bind(...params) : stmt;
  return bound.run();
}

export interface BoundStatement {
  sql: string;
  params: readonly unknown[];
}

/**
 * 事务性执行多条写语句。
 *
 * D1 的 batch 在一次事务内执行：任一失败则整体回滚。
 * 用于「写入 FinalGrade 的同时写入校准信号」这类必须同时成功的场景。
 */
export async function executeBatch(
  db: D1Database,
  statements: readonly BoundStatement[],
): Promise<D1Result[]> {
  if (statements.length === 0) return [];
  const prepared = statements.map((s) =>
    s.params.length > 0 ? db.prepare(s.sql).bind(...s.params) : db.prepare(s.sql),
  );
  return db.batch(prepared);
}

/** 拼接 IN 子句的占位符。传入 n 返回 "?, ?, ?"。 */
export function placeholders(n: number): string {
  if (n <= 0) throw new Error('placeholders 的参数必须为正整数');
  return new Array(n).fill('?').join(', ');
}
