-- AutoGrader 初始表结构
-- 约定：
--   1. 所有变更走迁移，只增不改。已应用的迁移文件不得修改。
--   2. 每张业务表都有 owner_id —— 游客模式下是前端生成的 visitorId。
--      它**不是身份认证**，只是数据隔离，UI 上必须明示这一点。
--   3. 大文本不进 D1：解析后的 markdown 放 R2，这里只存 key。
--   4. 时间统一存 ISO 8601 UTC 字符串，便于跨端解析。

-- ────────────────────────────────────────────────────────────
-- 评分细则
-- ────────────────────────────────────────────────────────────
-- criteria 与 scoring 整体存 JSON：细则是一个「文档」，以整份为单位版本化，
-- 拆成行反而会让版本快照难以还原。
CREATE TABLE IF NOT EXISTS rubric (
  rubric_id     TEXT PRIMARY KEY,
  title         TEXT    NOT NULL,
  course        TEXT    NOT NULL,
  version       INTEGER NOT NULL,
  total_points  REAL    NOT NULL,
  criteria_json TEXT    NOT NULL,
  scoring_json  TEXT    NOT NULL,
  owner_id      TEXT    NOT NULL DEFAULT 'anonymous',
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rubric_owner
  ON rubric (owner_id, updated_at DESC);

-- 同一 owner 下 title + version 唯一，避免并发写出版本号冲突
CREATE UNIQUE INDEX IF NOT EXISTS idx_rubric_owner_title_version
  ON rubric (owner_id, title, version);

-- ────────────────────────────────────────────────────────────
-- 学生报告
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS submission (
  submission_id  TEXT PRIMARY KEY,
  owner_id       TEXT    NOT NULL DEFAULT 'anonymous',
  filename       TEXT    NOT NULL,
  mime           TEXT,
  size_bytes     INTEGER NOT NULL,
  sha256         TEXT    NOT NULL,
  -- 原始文件在 R2 的 key
  object_key     TEXT    NOT NULL,
  -- uploaded | parsed | parse_failed
  status         TEXT    NOT NULL,
  -- 解析后的 markdown 在 R2 的 key
  parsed_key     TEXT,
  parse_meta_json TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submission_owner
  ON submission (owner_id, created_at DESC);

-- 用于「同一份文件是否已传过」的提示；不做唯一约束，因为学生本来就可能重复提交
CREATE INDEX IF NOT EXISTS idx_submission_sha
  ON submission (owner_id, sha256);

-- ────────────────────────────────────────────────────────────
-- 观察层（证据）
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS evidence (
  evidence_id    TEXT PRIMARY KEY,
  submission_id  TEXT NOT NULL,
  criterion_id   TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  -- 引文回查的统计，便于直接看「幻觉率」而不必解析 JSON
  quote_kept     INTEGER NOT NULL DEFAULT 0,
  quote_dropped  INTEGER NOT NULL DEFAULT 0,
  model          TEXT    NOT NULL,
  prompt_version TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES submission (submission_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_submission_criterion
  ON evidence (submission_id, criterion_id);

-- ────────────────────────────────────────────────────────────
-- 等级匹配
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS level_match (
  match_id      TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  criterion_id  TEXT NOT NULL,
  matched_level TEXT,
  needs_human   INTEGER NOT NULL DEFAULT 0,
  payload_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES submission (submission_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_level_match_submission_criterion
  ON level_match (submission_id, criterion_id);

-- ────────────────────────────────────────────────────────────
-- 最终评分记录
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS grade (
  grade_id       TEXT PRIMARY KEY,
  submission_id  TEXT    NOT NULL,
  rubric_id      TEXT    NOT NULL,
  rubric_version INTEGER NOT NULL,
  -- 完整 FinalGrade 快照。评分记录一经确认即为证据，不随细则改动而变
  payload_json   TEXT    NOT NULL,
  computed_total REAL    NOT NULL,
  final_total    REAL    NOT NULL,
  has_pending    INTEGER NOT NULL DEFAULT 0,
  state          TEXT    NOT NULL,
  confirmed_by   TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES submission (submission_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_grade_submission
  ON grade (submission_id);

CREATE INDEX IF NOT EXISTS idx_grade_state
  ON grade (state, updated_at DESC);

-- ────────────────────────────────────────────────────────────
-- 校准信号
-- ────────────────────────────────────────────────────────────
-- 教师每次改档都记一条。**只用于生成「规则修改建议」，绝不自动改规则。**
CREATE TABLE IF NOT EXISTS calibration_signal (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL,
  criterion_id  TEXT NOT NULL,
  agent_level   TEXT,
  human_level   TEXT,
  reason_code   TEXT NOT NULL,
  teacher_note  TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calibration_criterion
  ON calibration_signal (criterion_id, created_at DESC);

-- ────────────────────────────────────────────────────────────
-- 批量任务
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS grade_task (
  task_id      TEXT PRIMARY KEY,
  owner_id     TEXT    NOT NULL DEFAULT 'anonymous',
  rubric_id    TEXT    NOT NULL,
  -- queued | running | awaiting_human | done | failed
  state        TEXT    NOT NULL,
  total_count  INTEGER NOT NULL DEFAULT 0,
  done_count   INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_grade_task_owner
  ON grade_task (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS grade_task_item (
  task_id       TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  -- queued | running | done | failed
  state         TEXT NOT NULL,
  error_code    TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (task_id, submission_id)
);

CREATE INDEX IF NOT EXISTS idx_grade_task_item_state
  ON grade_task_item (task_id, state);
