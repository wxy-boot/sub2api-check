import { createServer } from "node:http";
import path from "node:path";
import { DEFAULT_GROUPS, DEFAULT_QUESTION, DEFAULT_SYSTEM_PROMPT, config, rootDir } from "./config.js";
import { describeCron, nextCronTime, validateCron } from "./cron.js";
import {
  httpError,
  readJsonBody,
  safeEqual,
  sendHtml,
  sendJson,
  sendText,
  serveStatic
} from "./http.js";
import { logError, logInfo, logWarn } from "./log.js";
import { renderAdmin, renderIndex } from "./pages.js";
import { createRunner } from "./runner.js";
import { Store } from "./store.js";
import { formatFullTime, formatShortTime, isoNow } from "./time.js";
import { createUpstream } from "./upstream.js";

const MAX_QUESTIONS = 20;
const MAX_GROUPS = 24;

const staticFiles = new Map([
  ["/app.js", { file: path.join(rootDir, "public", "app.js"), type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: path.join(rootDir, "public", "styles.css"), type: "text/css; charset=utf-8" }],
  ["/admin.js", { file: path.join(rootDir, "public", "admin.js"), type: "text/javascript; charset=utf-8" }],
  ["/admin.css", { file: path.join(rootDir, "public", "admin.css"), type: "text/css; charset=utf-8" }]
]);

const store = await Store.open(config.dbFile);
const upstream = createUpstream(config);
const runner = createRunner({ config, store, upstream });

seedStorage();

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    if (error.status && error.code) {
      sendJson(res, error.status, {
        ok: false,
        error: error.code,
        message: error.message,
        ...(error.details || {})
      });
      return;
    }

    logError("request.error", {
      method: req.method,
      url: req.url,
      message: error.message,
      stack: error.stack
    });
    sendJson(res, 500, { ok: false, error: "internal_error", message: "服务内部错误" });
  }
});

server.listen(config.port, () => {
  logInfo("service.started", {
    port: config.port,
    basePath: config.publicBasePath,
    dbFile: config.dbFile,
    timezone: config.timezone,
    cron: store.getSetting("schedule_cron"),
    cronEnabled: store.readBoolSetting("schedule_enabled", config.defaultCronEnabled),
    questionCount: store.getQuestions().length,
    groupCount: store.getGroups().length,
    schedulerDisabled: config.disableScheduler
  });

  if (!config.adminPassword) {
    logWarn("config.missing_admin_password", {
      message: "CHECK_ADMIN_PASSWORD is empty; admin APIs are disabled."
    });
  }

  const unconfigured = store
    .getGroups()
    .filter((group) => !group.baseUrl || !group.model || !group.apiKey);

  if (unconfigured.length > 0) {
    logWarn("config.unconfigured_groups", {
      groups: unconfigured.map((group) => group.name),
      message: "这些分组缺少 URL / API Key / 模型，检测时会自动跳过。"
    });
  }

  runner.start();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    logInfo("service.stopping", { signal });
    runner.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

function seedStorage() {
  store.seedSettings({
    schedule_cron: config.defaultCron,
    schedule_enabled: config.defaultCronEnabled ? "1" : "0",
    board_page_size: String(config.defaultPageSize)
  });

  if (store.countQuestions() === 0) {
    store.replaceQuestions(validateQuestions([DEFAULT_QUESTION]));
  }

  if (store.countGroups() === 0) {
    store.replaceGroups(
      validateGroups(
        DEFAULT_GROUPS.map((group) => ({
          ...group,
          baseUrl: "",
          apiKey: "",
          protocol: "/v1/chat/completions"
        }))
      )
    );
  }
}

async function route(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  const routePath = stripPublicBasePath(pathname);
  const method = req.method === "HEAD" ? "GET" : req.method;

  if (routePath === null) {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return;
  }

  if (method === "GET" && routePath === "/healthz") {
    sendJson(res, 200, { ok: true, service: config.serviceName, time: isoNow() });
    return;
  }

  if (method === "GET" && routePath === "/api/board") {
    sendJson(res, 200, buildBoardPayload(url));
    return;
  }

  const artifactHtmlMatch = routePath.match(/^\/api\/artifact\/([^/]+)\/html$/);

  if (method === "GET" && artifactHtmlMatch) {
    sendArtifactHtml(res, artifactHtmlMatch[1]);
    return;
  }

  const artifactMatch = routePath.match(/^\/api\/artifact\/([^/]+)$/);

  if (method === "GET" && artifactMatch) {
    sendJson(res, 200, { ok: true, artifact: buildArtifactDetail(artifactMatch[1]) });
    return;
  }

  if (routePath.startsWith("/api/admin/")) {
    await handleAdmin(req, res, routePath, method, url);
    return;
  }

  if (method === "GET" && staticFiles.has(routePath)) {
    serveStatic(res, staticFiles.get(routePath));
    return;
  }

  if (method === "GET" && (routePath === "/" || routePath === "/index.html")) {
    sendHtml(res, renderIndex(config));
    return;
  }

  if (method === "GET" && (routePath === "/admin" || routePath === "/admin/")) {
    sendHtml(res, renderAdmin(config));
    return;
  }

  sendJson(res, 404, { ok: false, error: "not_found" });
}

// ---------- 公开接口 ----------

function buildBoardPayload(url) {
  const questions = store.getQuestions();
  const groups = store.getGroups();
  const schedule = runner.getStatus();
  const enabledQuestions = questions.filter((question) => question.enabled);
  const questionId = resolveQuestionId(url.searchParams.get("questionId"), questions);
  const groupId = String(url.searchParams.get("groupId") || "");
  const pageSize = clampInt(
    url.searchParams.get("pageSize"),
    1,
    10,
    store.readNumberSetting("board_page_size", config.defaultPageSize)
  );
  const requestedPage = clampInt(url.searchParams.get("page"), 1, 10_000, 1);
  const visibleGroups = groupId ? groups.filter((group) => group.id === groupId) : groups;
  const latestRound = store.getLatestRound();
  const question = questions.find((item) => item.id === questionId) || null;

  const columns = visibleGroups.map((group) => {
    const total = store.countGroupArtifacts(group.id, questionId);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = store.listGroupArtifacts(group.id, questionId, pageSize, (page - 1) * pageSize);
    const roundArtifact = latestRound
      ? store.findRoundArtifact(latestRound.id, group.id, questionId)
      : null;

    return {
      group: publicGroup(group),
      page,
      pageSize,
      total,
      totalPages,
      artifacts: rows.map(publicArtifactSummary),
      round: {
        id: latestRound?.id || "",
        state: resolveRoundState({ latestRound, roundArtifact, running: schedule.running }),
        startedAt: latestRound?.started_at || "",
        startedAtLabel: latestRound ? formatShortTime(latestRound.started_at, config.timezone) : "",
        error: roundArtifact?.status === "error" ? roundArtifact.error || "" : ""
      }
    };
  });

  const maxTotal = Math.max(0, ...columns.map((column) => column.total));

  return {
    ok: true,
    title: config.title,
    subtitle: config.subtitle,
    timezone: config.timezone,
    schedule: {
      enabled: schedule.enabled,
      expression: schedule.expression,
      describe: schedule.describe,
      running: schedule.running,
      lastRunAt: schedule.lastRunAt,
      lastRunAtLabel: formatShortTime(schedule.lastRunAt, config.timezone),
      nextRunAt: schedule.nextRunAt,
      nextRunAtLabel: formatShortTime(schedule.nextRunAt, config.timezone)
    },
    questions: enabledQuestions.map((item) => ({
      id: item.id,
      title: item.title,
      note: item.note,
      label: questionLabel(item)
    })),
    groups: groups.map(publicGroup),
    selected: { questionId, groupId },
    question: question
      ? { id: question.id, title: question.title, note: question.note, prompt: question.prompt }
      : null,
    latestRound: latestRound
      ? {
          id: latestRound.id,
          status: latestRound.status,
          trigger: latestRound.trigger,
          startedAt: latestRound.started_at,
          finishedAt: latestRound.finished_at || ""
        }
      : null,
    paging: {
      page: requestedPage,
      pageSize,
      total: maxTotal,
      totalPages: Math.max(1, Math.ceil(maxTotal / pageSize))
    },
    columns
  };
}

function resolveRoundState({ latestRound, roundArtifact, running }) {
  if (!latestRound) {
    return "none";
  }

  if (roundArtifact) {
    return roundArtifact.status === "ok" ? "ok" : "error";
  }

  return running || latestRound.status === "running" ? "running" : "missing";
}

function publicGroup(group) {
  return {
    id: group.id,
    name: group.name,
    model: group.model,
    reasoning: group.reasoning,
    enabled: group.enabled,
    label: modelLabel(group.model, group.reasoning),
    configured: Boolean(group.baseUrl && group.model && group.apiKey)
  };
}

function publicArtifactSummary(row) {
  return {
    id: row.id,
    roundId: row.roundId,
    groupId: row.groupId,
    groupName: row.groupName || "",
    questionId: row.questionId,
    questionTitle: row.questionTitle || "",
    questionNote: row.questionNote || "",
    status: row.status,
    kind: row.kind,
    model: row.model || row.groupModel || "",
    reasoning: row.groupReasoning || "",
    modelLabel: modelLabel(row.model || row.groupModel || "", row.groupReasoning || ""),
    durationMs: Number(row.durationMs || 0),
    charCount: Number(row.charCount || 0),
    error: row.error || "",
    createdAt: row.createdAt,
    createdAtLabel: formatShortTime(row.createdAt, config.timezone)
  };
}

function sendArtifactHtml(res, id) {
  const body = store.getArtifactBody(id);

  if (!body) {
    throw httpError(404, "artifact_not_found", "作品不存在或已被删除。");
  }

  const headers = {
    // 双重隔离：iframe sandbox 属性 + 文档级 CSP sandbox，作品无法访问本服务的数据。
    "Content-Security-Policy": "sandbox allow-scripts",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  };

  if (body.kind === "html" && body.html) {
    sendHtml(res, body.html, headers);
    return;
  }

  sendText(res, 200, body.html || "（本次没有可用正文）", "text/plain; charset=utf-8", headers);
}

function buildArtifactDetail(id) {
  const row = store.getArtifact(id);

  if (!row) {
    throw httpError(404, "artifact_not_found", "作品不存在或已被删除。");
  }

  return {
    ...publicArtifactSummary(row),
    prompt: row.prompt || "",
    raw: row.raw || "",
    createdAtFull: formatFullTime(row.createdAt, config.timezone)
  };
}

// ---------- 管理接口 ----------

async function handleAdmin(req, res, routePath, method, url) {
  if (method === "GET" && routePath === "/api/admin/session") {
    requireAdmin(req);
    sendJson(res, 200, { ok: true });
    return;
  }

  requireAdmin(req);

  if (method === "GET" && routePath === "/api/admin/config") {
    sendJson(res, 200, buildAdminPayload());
    return;
  }

  if (method === "PUT" && routePath === "/api/admin/schedule") {
    const body = await readJsonBody(req);
    const expression = validateCron(body?.cron ?? store.getSetting("schedule_cron"));
    const enabled =
      typeof body?.enabled === "boolean"
        ? body.enabled
        : store.readBoolSetting("schedule_enabled", config.defaultCronEnabled);

    store.transaction(() => {
      store.setSetting("schedule_cron", expression);
      store.setSetting("schedule_enabled", enabled ? "1" : "0");
    });
    runner.refreshSchedule();

    logInfo("admin.schedule.updated", { cron: expression, enabled });
    sendJson(res, 200, buildAdminPayload());
    return;
  }

  if (method === "PUT" && routePath === "/api/admin/prompt") {
    const body = await readJsonBody(req);
    const systemPrompt =
      body?.systemPrompt === undefined
        ? store.getSetting("system_prompt")
        : String(body.systemPrompt).slice(0, 8000).trim();

    store.setSetting("system_prompt", systemPrompt);
    store.setSetting("system_prompt_custom", "1");
    logInfo("admin.prompt.updated", { length: systemPrompt.length });
    sendJson(res, 200, buildAdminPayload());
    return;
  }

  if (method === "PUT" && routePath === "/api/admin/questions") {
    const body = await readJsonBody(req);
    const questions = validateQuestions(body?.questions ?? []);

    store.replaceQuestions(questions);
    logInfo("admin.questions.updated", { count: questions.length });
    sendJson(res, 200, buildAdminPayload());
    return;
  }

  if (method === "PUT" && routePath === "/api/admin/groups") {
    const body = await readJsonBody(req);
    const groups = validateGroups(body?.groups ?? [], store.getGroups());

    store.replaceGroups(groups);
    logInfo("admin.groups.updated", {
      count: groups.length,
      configured: groups.filter((group) => group.baseUrl && group.model && group.apiKey).length
    });
    sendJson(res, 200, buildAdminPayload());
    return;
  }

  if (method === "GET" && routePath === "/api/admin/cron-preview") {
    const raw = String(url.searchParams.get("cron") || "");

    try {
      const expression = validateCron(raw);
      const next = nextCronTime(expression, new Date(), config.timezone);

      sendJson(res, 200, {
        ok: true,
        valid: true,
        expression,
        describe: describeCron(expression),
        nextLabel: next ? formatFullTime(next, config.timezone) : "没有下一次执行时间"
      });
    } catch (error) {
      sendJson(res, 200, {
        ok: true,
        valid: false,
        expression: raw,
        describe: error.message || "Cron 表达式不合法",
        nextLabel: "-"
      });
    }

    return;
  }

  if (method === "POST" && routePath === "/api/admin/run") {
    const check = runner.validateRun();

    if (!check.ok) {
      throw httpError(400, check.code, check.message);
    }

    if (runner.getStatus().running) {
      throw httpError(409, "round_running", "上一轮检测还没结束，请稍后再试。");
    }

    // 一轮可能要跑几分钟，这里立刻返回，后台再用配置里的 running 字段轮询进度。
    void runner.runRound("manual").catch((error) => {
      logError("admin.run.failed", { code: error?.code || "", message: error?.message || "" });
    });

    sendJson(res, 200, {
      ok: true,
      started: true,
      totalCount: check.totalCount,
      config: buildAdminPayload()
    });
    return;
  }

  if (method === "GET" && routePath === "/api/admin/records") {
    sendJson(res, 200, buildRecordsPayload(url));
    return;
  }

  const adminArtifactMatch = routePath.match(/^\/api\/admin\/artifacts\/([^/]+)$/);

  if (adminArtifactMatch) {
    const id = adminArtifactMatch[1];

    if (method === "GET") {
      const row = store.getArtifact(id);

      if (!row) {
        throw httpError(404, "artifact_not_found", "作品不存在或已被删除。");
      }

      sendJson(res, 200, {
        ok: true,
        artifact: {
          ...publicArtifactSummary(row),
          prompt: row.prompt || "",
          raw: row.raw || "",
          html: row.html || "",
          createdAtFull: formatFullTime(row.createdAt, config.timezone)
        }
      });
      return;
    }

    if (method === "DELETE") {
      store.deleteArtifact(id);
      logInfo("admin.artifact.deleted", { id });
      sendJson(res, 200, { ok: true, records: buildRecordsPayload(url) });
      return;
    }
  }

  throw httpError(404, "not_found", "接口不存在。");
}

function buildRecordsPayload(url) {
  const page = clampInt(url.searchParams.get("page"), 1, 100_000, 1);
  const pageSize = clampInt(url.searchParams.get("pageSize"), 1, 100, 20);
  const filters = {
    questionId: String(url.searchParams.get("questionId") || ""),
    groupId: String(url.searchParams.get("groupId") || ""),
    status: String(url.searchParams.get("status") || ""),
    query: String(url.searchParams.get("q") || "").trim().slice(0, 100)
  };
  const total = store.countArtifacts(filters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const rows = store.listArtifacts({
    ...filters,
    limit: pageSize,
    offset: (safePage - 1) * pageSize
  });

  return {
    ok: true,
    page: safePage,
    pageSize,
    total,
    totalPages,
    filters,
    records: rows.map(publicArtifactSummary)
  };
}

function buildAdminPayload() {
  const questions = store.getQuestions();
  const groups = store.getGroups();
  const schedule = runner.getStatus();

  return {
    ok: true,
    title: config.title,
    subtitle: config.subtitle,
    timezone: config.timezone,
    schedule: {
      ...schedule,
      nextRunAtLabel: formatShortTime(schedule.nextRunAt, config.timezone),
      lastRunAtLabel: formatShortTime(schedule.lastRunAt, config.timezone),
      previewNextRunAt: previewNextRun(schedule.expression)
    },
    questions,
    systemPrompt: runner.getSystemPrompt(),
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    groups: groups.map((group) => ({
      ...group,
      apiKey: "",
      apiKeyMasked: maskSecret(group.apiKey),
      hasApiKey: Boolean(group.apiKey),
      label: modelLabel(group.model, group.reasoning)
    })),
    stats: buildStats(),
    rounds: store
      .listRounds(12)
      .map((round) => ({
        id: round.id,
        trigger: round.trigger,
        status: round.status,
        startedAt: round.started_at,
        startedAtLabel: formatShortTime(round.started_at, config.timezone),
        finishedAt: round.finished_at || "",
        finishedAtLabel: round.finished_at
          ? formatShortTime(round.finished_at, config.timezone)
          : "",
        totalCount: Number(round.total_count || 0),
        okCount: Number(round.ok_count || 0),
        failedCount: Number(round.failed_count || 0),
        note: round.note || ""
      })),
    system: buildSystemInfo()
  };
}

function buildStats() {
  const artifactStats = store.getArtifactStats();

  return {
    ...artifactStats,
    questionCount: store.getQuestions().filter((question) => question.enabled).length,
    groupCount: store.getGroups().filter((group) => group.enabled).length,
    configuredGroupCount: store
      .getGroups()
      .filter((group) => group.enabled && group.baseUrl && group.model && group.apiKey).length
  };
}

function buildSystemInfo() {
  return {
    dbFile: config.dbFile,
    timezone: config.timezone,
    port: config.port,
    basePath: config.publicBasePath,
    requestTimeoutSeconds: Math.round(config.requestTimeoutMs / 1000),
    maxOutputChars: config.maxOutputChars,
    concurrency: config.concurrency,
    sendReasoningEffort: config.sendReasoningEffort,
    schedulerDisabled: config.disableScheduler,
    adminConfigured: Boolean(config.adminPassword),
    nodeVersion: process.version,
    uptimeSeconds: Math.round(process.uptime())
  };
}

function previewNextRun(expression) {
  try {
    const next = nextCronTime(expression, new Date(), config.timezone);

    return next
      ? {
          iso: next.toISOString(),
          label: formatFullTime(next, config.timezone),
          describe: describeCron(expression)
        }
      : { iso: "", label: "没有下一次执行时间", describe: describeCron(expression) };
  } catch {
    return { iso: "", label: "-", describe: "Cron 表达式不合法" };
  }
}

// ---------- 校验 ----------

function validateQuestions(input) {
  if (!Array.isArray(input)) {
    throw httpError(400, "invalid_questions", "题目必须是数组。");
  }

  const questions = input
    .map((item, index) => ({
      id: sanitizeId(item?.id, `question-${index + 1}`),
      title: String(item?.title ?? "").trim().slice(0, 80),
      note: String(item?.note ?? "").trim().slice(0, 24),
      prompt: String(item?.prompt ?? "").trim().slice(0, 20000),
      enabled: item?.enabled !== false
    }))
    .filter((item) => item.title || item.prompt);

  if (questions.length === 0) {
    throw httpError(400, "empty_questions", "至少需要保留一道检测题目。");
  }

  if (questions.length > MAX_QUESTIONS) {
    throw httpError(400, "too_many_questions", `检测题目最多 ${MAX_QUESTIONS} 道。`);
  }

  const usedIds = new Set();

  for (const question of questions) {
    if (!question.title) {
      throw httpError(400, "invalid_question_title", "题目名称不能为空。");
    }

    if (!question.prompt) {
      throw httpError(400, "invalid_question_prompt", `题目「${question.title}」的提示词不能为空。`);
    }

    question.id = uniqueId(question.id, usedIds);
  }

  return questions;
}

function validateGroups(input, existingGroups = []) {
  if (!Array.isArray(input)) {
    throw httpError(400, "invalid_groups", "分组必须是数组。");
  }

  const existingById = new Map(existingGroups.map((group) => [group.id, group]));

  const groups = input
    .map((item, index) => {
      const previous = existingById.get(String(item?.id ?? "")) || null;
      const apiKeyInput = item?.apiKey;
      const apiKey =
        apiKeyInput === undefined || apiKeyInput === null
          ? previous?.apiKey || ""
          : String(apiKeyInput).trim();

      return {
        id: sanitizeId(item?.id, `group-${index + 1}`),
        name: String(item?.name ?? "").trim().slice(0, 40),
        baseUrl: normalizeUrl(item?.baseUrl),
        apiKey: apiKey.slice(0, 400),
        model: String(item?.model ?? "").trim().slice(0, 120),
        reasoning: String(item?.reasoning ?? "").trim().slice(0, 24),
        protocol: normalizeProtocolPath(item?.protocol),
        enabled: item?.enabled !== false
      };
    })
    .filter((item) => item.name || item.baseUrl || item.model);

  if (groups.length === 0) {
    throw httpError(400, "empty_groups", "至少需要保留一个检测分组。");
  }

  if (groups.length > MAX_GROUPS) {
    throw httpError(400, "too_many_groups", `检测分组最多 ${MAX_GROUPS} 个。`);
  }

  const usedIds = new Set();

  for (const group of groups) {
    if (!group.name) {
      throw httpError(400, "invalid_group_name", "分组名称不能为空。");
    }

    if (group.baseUrl && !/^https?:\/\/[^\s]+$/i.test(group.baseUrl)) {
      throw httpError(400, "invalid_group_url", `分组「${group.name}」的 API 地址必须以 http:// 或 https:// 开头。`);
    }

    group.id = uniqueId(group.id, usedIds);
  }

  return groups;
}

function normalizeUrl(value) {
  const text = String(value ?? "").trim();

  if (!text) {
    return "";
  }

  return text.replace(/\/+$/, "").slice(0, 400);
}

function normalizeProtocolPath(value) {
  const text = String(value ?? "").trim() || "/v1/chat/completions";

  if (/^https?:\/\//i.test(text)) {
    return text.slice(0, 400);
  }

  const withSlash = text.startsWith("/") ? text : `/${text}`;
  return withSlash.slice(0, 200);
}

function sanitizeId(value, fallback) {
  const raw = String(value ?? "").trim();

  if (!raw) {
    return fallback;
  }

  return raw.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) || fallback;
}

function uniqueId(value, usedIds) {
  let id = value;
  let suffix = 2;

  while (usedIds.has(id)) {
    id = `${value}-${suffix}`;
    suffix += 1;
  }

  usedIds.add(id);
  return id;
}

// ---------- 工具 ----------

function requireAdmin(req) {
  if (!config.adminPassword) {
    throw httpError(403, "admin_disabled", "管理端未启用，请先配置 CHECK_ADMIN_PASSWORD。");
  }

  const provided = getAdminPassword(req);

  if (!safeEqual(provided, config.adminPassword)) {
    throw httpError(401, "invalid_admin_password", "管理密码错误。");
  }
}

function getAdminPassword(req) {
  const direct = req.headers["x-check-admin-password"];

  if (direct) {
    return String(direct);
  }

  const authorization = String(req.headers.authorization || "");

  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7);
  }

  if (authorization.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const index = decoded.indexOf(":");
      return index === -1 ? decoded : decoded.slice(index + 1);
    } catch {
      return "";
    }
  }

  return "";
}

function stripPublicBasePath(pathname) {
  const base = config.publicBasePath;

  if (base === "/") {
    return pathname;
  }

  if (pathname === base) {
    return "/";
  }

  if (pathname.startsWith(`${base}/`)) {
    return pathname.slice(base.length) || "/";
  }

  return null;
}

function resolveQuestionId(rawId, questions) {
  const value = String(rawId || "");

  if (value && questions.some((question) => question.id === value)) {
    return value;
  }

  const firstEnabled =
    questions.find((question) => question.enabled) || questions[0] || null;

  return firstEnabled?.id || "";
}

function questionLabel(question) {
  return question.note ? `${question.title} · ${question.note}` : question.title;
}

function modelLabel(model, reasoning) {
  const name = String(model || "").trim();

  if (!name) {
    return reasoning ? `· ${reasoning}` : "";
  }

  return reasoning ? `${name} · ${reasoning}` : name;
}

function maskSecret(value) {
  const text = String(value || "");

  if (!text) {
    return "";
  }

  if (text.length <= 8) {
    return "****";
  }

  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

function clampInt(raw, min, max, fallback) {
  const value = Number.parseInt(String(raw ?? ""), 10);

  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}
