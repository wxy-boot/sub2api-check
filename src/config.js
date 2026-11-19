import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const rootDir = path.resolve(__dirname, "..");

// 图中固定试题的原文。首次启动会写入 SQLite，之后在后台“检测题目”里维护。
export const DEFAULT_QUESTION = {
  id: "question-fox-camel",
  title: "狐狸骑骆驼",
  note: "low",
  prompt: "创建一个HTML，内容是SVG绘制一个狐狸骑骆驼的2D动画，不要参考任何提示词和html",
  enabled: true
};

// 首次启动写入的占位分组，URL / API Key / 模型需要到后台补齐。
export const DEFAULT_GROUPS = [
  { id: "group-1", name: "PRO1", model: "", reasoning: "", enabled: true },
  { id: "group-2", name: "PRO2", model: "", reasoning: "", enabled: true },
  { id: "group-3", name: "PRO3", model: "", reasoning: "", enabled: true }
];

export const DEFAULT_CRON = "*/30 * * * *";

export const config = {
  serviceName: "sub2api-check",
  port: readIntEnv("PORT", 8789),
  publicBasePath: normalizeBasePath(process.env.PUBLIC_BASE_PATH || "/"),
  dbFile: path.resolve(
    rootDir,
    process.env.CHECK_DB_FILE || process.env.SQLITE_FILE || "./data/check.db"
  ),
  timezone: process.env.CHECK_TIMEZONE || "Asia/Shanghai",
  adminPassword: process.env.CHECK_ADMIN_PASSWORD || "",
  title: process.env.CHECK_TITLE || "模型智商检测",
  subtitle:
    process.env.CHECK_SUBTITLE ||
    "用同一道固定试题，横向对比各分组模型的真实生成表现。",
  defaultCron: process.env.CHECK_CRON || DEFAULT_CRON,
  defaultCronEnabled: readBoolEnv("CHECK_CRON_ENABLED", true),
  requestTimeoutMs: Math.max(5, readIntEnv("CHECK_REQUEST_TIMEOUT_SECONDS", 180)) * 1000,
  maxOutputChars: Math.max(1000, readIntEnv("CHECK_MAX_OUTPUT_CHARS", 200000)),
  sendReasoningEffort: readBoolEnv("CHECK_SEND_REASONING_EFFORT", true),
  disableScheduler: readBoolEnv("CHECK_DISABLE_SCHEDULER", false),
  concurrency: Math.max(1, Math.min(8, readIntEnv("CHECK_CONCURRENCY", 3))),
  defaultPageSize: 5,
  maxPageSize: 50
};

export function readIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

export function readBoolEnv(name, fallback = false) {
  const value = String(process.env[name] || "").trim().toLowerCase();

  if (["1", "true", "yes", "on", "enabled"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off", "disabled"].includes(value)) {
    return false;
  }

  return fallback;
}

function normalizeBasePath(value) {
  const text = String(value || "/").trim();
  const withSlash = text.startsWith("/") ? text : `/${text}`;
  const trimmed = withSlash.replace(/\/+$/, "");
  return trimmed || "/";
}
