import { appendFileSync } from "node:fs";

const TAG = "[sub2api-check]";
// 可选：把同样的单行 JSON 日志追加写入文件，方便容器外排查。
const LOG_FILE = process.env.CHECK_LOG_FILE || "";

export function logInfo(event, data = {}) {
  writeLog("info", event, data);
}

export function logWarn(event, data = {}) {
  writeLog("warn", event, data);
}

export function logError(event, data = {}) {
  writeLog("error", event, data);
}

function writeLog(level, event, data) {
  const payload = {
    time: new Date().toISOString(),
    level,
    event,
    ...data
  };
  const line = `${TAG} ${JSON.stringify(payload)}`;

  if (LOG_FILE) {
    try {
      appendFileSync(LOG_FILE, `${line}\n`);
    } catch {
      // 文件不可写时只走标准输出。
    }
  }

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}
