import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS test_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    reasoning TEXT NOT NULL DEFAULT '',
    protocol TEXT NOT NULL DEFAULT '/v1/chat/completions',
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    total_count INTEGER NOT NULL DEFAULT 0,
    ok_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    status TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'html',
    model TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    prompt TEXT NOT NULL DEFAULT '',
    html TEXT NOT NULL DEFAULT '',
    raw TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    char_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_artifacts_group_question
    ON artifacts (group_id, question_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_artifacts_round ON artifacts (round_id);
  CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_rounds_started ON rounds (started_at DESC);
`;

const SUMMARY_COLUMNS = `
  a.id AS id,
  a.round_id AS roundId,
  a.question_id AS questionId,
  a.group_id AS groupId,
  a.status AS status,
  a.kind AS kind,
  a.model AS model,
  a.duration_ms AS durationMs,
  a.error AS error,
  a.char_count AS charCount,
  a.created_at AS createdAt,
  COALESCE(g.name, '') AS groupName,
  COALESCE(g.model, '') AS groupModel,
  COALESCE(g.reasoning, '') AS groupReasoning,
  COALESCE(q.title, '') AS questionTitle,
  COALESCE(q.note, '') AS questionNote
`;

const DETAIL_COLUMNS = `
  ${SUMMARY_COLUMNS},
  a.prompt AS prompt,
  a.raw AS raw,
  a.html AS html
`;

export class Store {
  constructor(db, dbFile) {
    this.db = db;
    this.dbFile = dbFile;
    this.lock = Promise.resolve();
  }

  static async open(dbFile) {
    await mkdir(path.dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);

    return new Store(db, dbFile);
  }

  close() {
    try {
      this.db.close();
    } catch {
      // 关闭期的异常忽略即可。
    }
  }

  withLock(task) {
    const next = this.lock.then(task, task);
    this.lock = next.catch(() => {});
    return next;
  }

  transaction(task) {
    this.db.exec("BEGIN");

    try {
      const result = task();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---------- settings ----------

  getSetting(key) {
    return this.db.prepare("SELECT value FROM settings WHERE key = ? LIMIT 1").get(key)?.value || "";
  }

  setSetting(key, value) {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`
      )
      .run(key, String(value), new Date().toISOString());
  }

  readNumberSetting(key, fallback) {
    const value = this.getSetting(key);

    if (value === "") {
      return fallback;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  readBoolSetting(key, fallback) {
    const value = this.getSetting(key);

    if (value === "") {
      return fallback;
    }

    return ["1", "true", "yes", "on", "enabled"].includes(String(value).trim().toLowerCase());
  }

  seedSettings(defaults) {
    for (const [key, value] of Object.entries(defaults)) {
      if (this.getSetting(key) === "") {
        this.setSetting(key, value);
      }
    }
  }

  // ---------- questions ----------

  countQuestions() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM questions").get()?.count || 0);
  }

  getQuestions() {
    return this.db
      .prepare(
        `SELECT id, title, note, prompt, enabled
         FROM questions
         ORDER BY sort_order ASC, rowid ASC`
      )
      .all()
      .map((row) => ({
        id: row.id,
        title: row.title,
        note: row.note || "",
        prompt: row.prompt,
        enabled: Boolean(row.enabled)
      }));
  }

  getQuestion(id) {
    const row = this.db
      .prepare("SELECT id, title, note, prompt, enabled FROM questions WHERE id = ? LIMIT 1")
      .get(String(id));

    return row
      ? {
          id: row.id,
          title: row.title,
          note: row.note || "",
          prompt: row.prompt,
          enabled: Boolean(row.enabled)
        }
      : null;
  }

  replaceQuestions(questions) {
    this.db.prepare("DELETE FROM questions").run();
    const statement = this.db.prepare(
      `INSERT INTO questions (id, title, note, prompt, enabled, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const now = new Date().toISOString();

    questions.forEach((question, index) => {
      statement.run(
        question.id,
        question.title,
        question.note || "",
        question.prompt,
        question.enabled ? 1 : 0,
        index,
        now
      );
    });
  }

  // ---------- test groups ----------

  countGroups() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM test_groups").get()?.count || 0);
  }

  getGroups() {
    return this.db
      .prepare(
        `SELECT id, name, base_url AS baseUrl, api_key AS apiKey, model, reasoning,
                protocol, enabled
         FROM test_groups
         ORDER BY sort_order ASC, rowid ASC`
      )
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        baseUrl: row.baseUrl || "",
        apiKey: row.apiKey || "",
        model: row.model || "",
        reasoning: row.reasoning || "",
        protocol: row.protocol || "/v1/chat/completions",
        enabled: Boolean(row.enabled)
      }));
  }

  getGroup(id) {
    return this.getGroups().find((group) => group.id === String(id)) || null;
  }

  replaceGroups(groups) {
    this.db.prepare("DELETE FROM test_groups").run();
    const statement = this.db.prepare(
      `INSERT INTO test_groups (
         id, name, base_url, api_key, model, reasoning, protocol, enabled, sort_order, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = new Date().toISOString();

    groups.forEach((group, index) => {
      statement.run(
        group.id,
        group.name,
        group.baseUrl || "",
        group.apiKey || "",
        group.model || "",
        group.reasoning || "",
        group.protocol || "/v1/chat/completions",
        group.enabled ? 1 : 0,
        index,
        now
      );
    });
  }

  // ---------- rounds ----------

  createRound(round) {
    this.db
      .prepare(
        `INSERT INTO rounds (id, trigger, status, started_at, finished_at, total_count, ok_count, failed_count, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        round.id,
        round.trigger,
        round.status,
        round.startedAt,
        round.finishedAt ?? null,
        round.totalCount ?? 0,
        round.okCount ?? 0,
        round.failedCount ?? 0,
        round.note || ""
      );
  }

  finishRound(id, payload) {
    this.db
      .prepare(
        `UPDATE rounds
         SET status = ?, finished_at = ?, total_count = ?, ok_count = ?, failed_count = ?, note = ?
         WHERE id = ?`
      )
      .run(
        payload.status,
        payload.finishedAt,
        payload.totalCount ?? 0,
        payload.okCount ?? 0,
        payload.failedCount ?? 0,
        payload.note || "",
        String(id)
      );
  }

  getRound(id) {
    return this.db.prepare("SELECT * FROM rounds WHERE id = ? LIMIT 1").get(String(id)) || null;
  }

  getLatestRound() {
    return this.db.prepare("SELECT * FROM rounds ORDER BY started_at DESC LIMIT 1").get() || null;
  }

  getRunningRound() {
    return (
      this.db.prepare("SELECT * FROM rounds WHERE status = 'running' ORDER BY started_at DESC LIMIT 1").get() ||
      null
    );
  }

  listRounds(limit = 20) {
    return this.db
      .prepare("SELECT * FROM rounds ORDER BY started_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(200, Number(limit) || 20)));
  }

  // 进程异常退出时可能残留 running 轮次，启动时统一收尾。
  markStaleRounds(nowIso, message) {
    return this.db
      .prepare(
        `UPDATE rounds
         SET status = 'error', finished_at = ?, note = ?
         WHERE status = 'running'`
      )
      .run(nowIso, message);
  }

  // ---------- artifacts ----------

  insertArtifact(artifact) {
    this.db
      .prepare(
        `INSERT INTO artifacts (
           id, round_id, question_id, group_id, status, kind, model, duration_ms,
           prompt, html, raw, error, char_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        artifact.id,
        artifact.roundId,
        artifact.questionId,
        artifact.groupId,
        artifact.status,
        artifact.kind || "html",
        artifact.model || "",
        artifact.durationMs || 0,
        artifact.prompt || "",
        artifact.html || "",
        artifact.raw || "",
        artifact.error || "",
        artifact.charCount || 0,
        artifact.createdAt
      );
  }

  getArtifact(id, options = {}) {
    const columns = options.withBody === false ? SUMMARY_COLUMNS : DETAIL_COLUMNS;

    return (
      this.db
        .prepare(
          `SELECT ${columns}
           FROM artifacts a
           LEFT JOIN test_groups g ON g.id = a.group_id
           LEFT JOIN questions q ON q.id = a.question_id
           WHERE a.id = ?
           LIMIT 1`
        )
        .get(String(id)) || null
    );
  }

  getArtifactBody(id) {
    return (
      this.db
        .prepare("SELECT id, kind, html, created_at AS createdAt FROM artifacts WHERE id = ? LIMIT 1")
        .get(String(id)) || null
    );
  }

  deleteArtifact(id) {
    return this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(String(id));
  }

  deleteArtifactsByRound(roundId) {
    return this.db.prepare("DELETE FROM artifacts WHERE round_id = ?").run(String(roundId));
  }

  buildArtifactWhere(filters = {}) {
    const clauses = [];
    const params = [];

    if (filters.questionId) {
      clauses.push("a.question_id = ?");
      params.push(String(filters.questionId));
    }

    if (filters.groupId) {
      clauses.push("a.group_id = ?");
      params.push(String(filters.groupId));
    }

    if (filters.status) {
      clauses.push("a.status = ?");
      params.push(String(filters.status));
    }

    if (filters.roundId) {
      clauses.push("a.round_id = ?");
      params.push(String(filters.roundId));
    }

    if (filters.query) {
      const like = `%${String(filters.query).toLowerCase()}%`;
      clauses.push(
        "(LOWER(a.model) LIKE ? OR LOWER(COALESCE(g.name, '')) LIKE ? OR LOWER(COALESCE(q.title, '')) LIKE ? OR LOWER(a.error) LIKE ?)"
      );
      params.push(like, like, like, like);
    }

    return {
      where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
      params
    };
  }

  countArtifacts(filters = {}) {
    const { where, params } = this.buildArtifactWhere(filters);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM artifacts a
         LEFT JOIN test_groups g ON g.id = a.group_id
         LEFT JOIN questions q ON q.id = a.question_id
         ${where}`
      )
      .get(...params);

    return Number(row?.count || 0);
  }

  listArtifacts(filters = {}) {
    const { where, params } = this.buildArtifactWhere(filters);
    const limit = Math.max(1, Math.min(200, Number(filters.limit) || 20));
    const offset = Math.max(0, Number(filters.offset) || 0);

    return this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS}
         FROM artifacts a
         LEFT JOIN test_groups g ON g.id = a.group_id
         LEFT JOIN questions q ON q.id = a.question_id
         ${where}
         ORDER BY a.created_at DESC, a.rowid DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);
  }

  // 看板：某个分组 + 某道题的历史作品（时间倒序），用于每列独立分页。
  listGroupArtifacts(groupId, questionId, limit, offset) {
    const params = [String(groupId)];
    let questionClause = "";

    if (questionId) {
      questionClause = "AND a.question_id = ?";
      params.push(String(questionId));
    }

    return this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS}
         FROM artifacts a
         LEFT JOIN test_groups g ON g.id = a.group_id
         LEFT JOIN questions q ON q.id = a.question_id
         WHERE a.group_id = ? ${questionClause}
         ORDER BY a.created_at DESC, a.rowid DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, Math.max(1, limit), Math.max(0, offset));
  }

  countGroupArtifacts(groupId, questionId) {
    const params = [String(groupId)];
    let questionClause = "";

    if (questionId) {
      questionClause = "AND question_id = ?";
      params.push(String(questionId));
    }

    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM artifacts WHERE group_id = ? ${questionClause}`
      )
      .get(...params);

    return Number(row?.count || 0);
  }

  // 本轮是否已经产出该分组/题目的作品。
  findRoundArtifact(roundId, groupId, questionId) {
    return (
      this.db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS}
           FROM artifacts a
           LEFT JOIN test_groups g ON g.id = a.group_id
           LEFT JOIN questions q ON q.id = a.question_id
           WHERE a.round_id = ? AND a.group_id = ? AND a.question_id = ?
           ORDER BY a.created_at DESC
           LIMIT 1`
        )
        .get(String(roundId), String(groupId), String(questionId)) || null
    );
  }

  getArtifactStats() {
    const byStatus = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM artifacts GROUP BY status")
      .all();
    const byGroup = this.db
      .prepare(
        `SELECT a.group_id AS groupId,
                COALESCE(g.name, a.group_id) AS groupName,
                COUNT(*) AS count,
                SUM(CASE WHEN a.status = 'ok' THEN 1 ELSE 0 END) AS okCount,
                SUM(CASE WHEN a.status = 'ok' THEN a.duration_ms ELSE 0 END) AS okDurationMs
         FROM artifacts a
         LEFT JOIN test_groups g ON g.id = a.group_id
         GROUP BY a.group_id
         ORDER BY count DESC`
      )
      .all()
      .map((row) => ({
        groupId: row.groupId,
        groupName: row.groupName,
        count: Number(row.count || 0),
        okCount: Number(row.okCount || 0),
        okDurationMs: Number(row.okDurationMs || 0)
      }));
    const total = this.db.prepare("SELECT COUNT(*) AS count FROM artifacts").get();

    return {
      total: Number(total?.count || 0),
      byStatus: Object.fromEntries(byStatus.map((row) => [row.status, Number(row.count || 0)])),
      byGroup
    };
  }
}
