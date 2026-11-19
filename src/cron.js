import { httpError } from "./http.js";
import { zonedParts } from "./time.js";

// 标准 5 段 Cron：分 时 日 月 周（周 0 和 7 都代表周日）。
const FIELD_SPECS = [
  { key: "minute", label: "分钟", min: 0, max: 59 },
  { key: "hour", label: "小时", min: 0, max: 23 },
  { key: "dayOfMonth", label: "日", min: 1, max: 31 },
  { key: "month", label: "月", min: 1, max: 12 },
  { key: "dayOfWeek", label: "周", min: 0, max: 7 }
];

const MONTH_NAMES = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
};

const DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const SHORTCUTS = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *"
};

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function normalizeCron(expression) {
  const text = String(expression ?? "")
    .trim()
    .replace(/\s+/g, " ");

  return SHORTCUTS[text.toLowerCase()] || text;
}

export function parseCron(expression) {
  const normalized = normalizeCron(expression);

  if (!normalized) {
    throw httpError(400, "invalid_cron", "Cron 表达式不能为空。");
  }

  const fields = normalized.split(" ");

  if (fields.length !== 5) {
    throw httpError(
      400,
      "invalid_cron",
      `Cron 表达式需要 5 段（分 时 日 月 周），当前是 ${fields.length} 段。`
    );
  }

  const parsed = { expression: normalized };

  FIELD_SPECS.forEach((spec, index) => {
    const result = parseField(fields[index], spec);
    parsed[spec.key] = result.values;
    parsed[`${spec.key}Restricted`] = result.restricted;
  });

  // 7 也代表周日，统一折叠成 0。
  if (parsed.dayOfWeek.has(7)) {
    parsed.dayOfWeek.add(0);
    parsed.dayOfWeek.delete(7);
  }

  return parsed;
}

export function validateCron(expression) {
  parseCron(expression);
  return normalizeCron(expression);
}

/**
 * 计算下一次执行时间：按指定时区解释 Cron，返回 UTC Date。
 * 找不到（例如 2 月 30 日）时返回 null。
 */
export function nextCronTime(expression, from = new Date(), timezone = "UTC") {
  const schedule = typeof expression === "string" ? parseCron(expression) : expression;
  const fromMs = from instanceof Date ? from.getTime() : new Date(from).getTime();

  if (!Number.isFinite(fromMs)) {
    return null;
  }

  let time = Math.floor(fromMs / 60000) * 60000 + 60000;
  const limit = time + 5 * 366 * 24 * 60 * 60000;

  while (time <= limit) {
    const parts = zonedParts(new Date(time), timezone);
    const month = Number(parts.month);
    const day = Number(parts.day);
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    const weekday = weekdayOf(parts);

    if (!schedule.month.has(month) || !matchesDay(schedule, day, weekday)) {
      // 整天都不匹配：跳到次日 00:00。
      time += (1440 - (hour * 60 + minute)) * 60000;
      continue;
    }

    if (!schedule.hour.has(hour)) {
      time += (60 - minute) * 60000;
      continue;
    }

    if (!schedule.minute.has(minute)) {
      time += 60000;
      continue;
    }

    return new Date(time);
  }

  return null;
}

/** 给后台/看板展示的一句话解释，例如「每 30 分钟」。 */
export function describeCron(expression) {
  let schedule;

  try {
    schedule = parseCron(expression);
  } catch {
    return "Cron 表达式不合法";
  }

  const minutes = sortedValues(schedule.minute);
  const hours = sortedValues(schedule.hour);
  const minutesEvery = detectStepMinutes(schedule);
  const domRestricted = schedule.dayOfMonthRestricted;
  const dowRestricted = schedule.dayOfWeekRestricted;
  const monthRestricted = schedule.monthRestricted;
  const hourFull = isFullSet(schedule.hour, 0, 23);

  if (minutesEvery !== null && hourFull && !domRestricted && !dowRestricted && !monthRestricted) {
    return minutesEvery === 1 ? "每分钟检测一轮" : `每 ${minutesEvery} 分钟检测一轮`;
  }

  if (isFullSet(schedule.minute, 0, 59) && hourFull) {
    return "每分钟检测一轮";
  }

  const hourStep = detectStepHours(schedule);

  if (hourStep !== null && !domRestricted && !dowRestricted && !monthRestricted) {
    if (minutes.length === 1) {
      const suffix = minutes[0] === 0 ? "" : `，第 ${minutes[0]} 分`;
      return `每 ${hourStep} 小时${suffix}`;
    }

    return `每 ${hourStep} 小时的第 ${minutes.join("、")} 分`;
  }

  const timeText = formatTimeText(hours, minutes);

  if (!domRestricted && !dowRestricted && !monthRestricted) {
    return `每天 ${timeText}`;
  }

  if (dowRestricted && !domRestricted && !monthRestricted) {
    const days = sortedValues(schedule.dayOfWeek)
      .map((value) => WEEKDAY_LABELS[value] || String(value))
      .join("、");
    return `每${days} ${timeText}`;
  }

  if (domRestricted && !dowRestricted && !monthRestricted) {
    return `每月 ${sortedValues(schedule.dayOfMonth).join("、")} 日 ${timeText}`;
  }

  return `Cron：${schedule.expression}`;
}

function parseField(field, spec) {
  const text = String(field || "").trim().toLowerCase();

  if (!text) {
    throw httpError(400, "invalid_cron", `Cron 的「${spec.label}」段为空。`);
  }

  if (text === "*") {
    return { values: fullSet(spec.min, spec.max), restricted: false };
  }

  const values = new Set();

  for (const chunk of text.split(",")) {
    const stepSplit = chunk.split("/");
    const body = stepSplit[0];
    const step = stepSplit.length > 1 ? Number(stepSplit[1]) : 1;

    if (!Number.isInteger(step) || step <= 0) {
      throw httpError(400, "invalid_cron", `Cron 的「${spec.label}」段步长不合法：${chunk}`);
    }

    let start;
    let end;

    if (body === "*" || body === "") {
      start = spec.min;
      end = spec.max;
    } else if (body.includes("-")) {
      const [rawStart, rawEnd] = body.split("-");
      start = parseValue(rawStart, spec);
      end = parseValue(rawEnd, spec);
    } else {
      start = parseValue(body, spec);
      end = stepSplit.length > 1 ? spec.max : start;
    }

    if (start > end) {
      throw httpError(400, "invalid_cron", `Cron 的「${spec.label}」段范围不合法：${chunk}`);
    }

    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }

  if (values.size === 0) {
    throw httpError(400, "invalid_cron", `Cron 的「${spec.label}」段没有有效取值。`);
  }

  return {
    values,
    restricted: !isFullSet(values, spec.min, spec.max === 7 ? 6 : spec.max)
  };
}

function parseValue(raw, spec) {
  const text = String(raw || "").trim();
  const named = spec.key === "month" ? MONTH_NAMES[text] : spec.key === "dayOfWeek" ? DAY_NAMES[text] : undefined;

  if (named !== undefined) {
    return named;
  }

  const value = Number(text);

  if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
    throw httpError(
      400,
      "invalid_cron",
      `Cron 的「${spec.label}」段取值超出 ${spec.min}-${spec.max}：${text}`
    );
  }

  return value;
}

function matchesDay(schedule, dayOfMonth, weekday) {
  const domOk = schedule.dayOfMonth.has(dayOfMonth);
  const dowOk = schedule.dayOfWeek.has(foldWeekday(weekday));

  // 标准 Cron：日与周都被限制时，满足其一即可。
  if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) {
    return domOk || dowOk;
  }

  return domOk && dowOk;
}

function weekdayOf(parts) {
  return new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))
  ).getUTCDay();
}

// dayOfWeek 允许 0-7，这里把 7 折叠成 0，保证集合运算一致。
function foldWeekday(weekday) {
  return weekday === 7 ? 0 : weekday;
}

function fullSet(min, max) {
  const values = new Set();

  for (let value = min; value <= max; value += 1) {
    values.add(value);
  }

  return values;
}

function isFullSet(values, min, max) {
  if (values.size !== max - min + 1) {
    return false;
  }

  for (let value = min; value <= max; value += 1) {
    if (!values.has(value)) {
      return false;
    }
  }

  return true;
}

function sortedValues(values) {
  return [...values].sort((left, right) => left - right);
}

function detectStepMinutes(schedule) {
  const values = sortedValues(schedule.minute);

  if (values.length < 2) {
    return null;
  }

  const step = values[1] - values[0];

  if (values[0] !== 0 || 60 % step !== 0) {
    return null;
  }

  for (let index = 1; index < values.length; index += 1) {
    if (values[index] - values[index - 1] !== step) {
      return null;
    }
  }

  return values[values.length - 1] + step === 60 ? step : null;
}

function detectStepHours(schedule) {
  const values = sortedValues(schedule.hour);

  if (values.length < 2) {
    return null;
  }

  const step = values[1] - values[0];

  if (values[0] !== 0 || 24 % step !== 0) {
    return null;
  }

  for (let index = 1; index < values.length; index += 1) {
    if (values[index] - values[index - 1] !== step) {
      return null;
    }
  }

  return values[values.length - 1] + step === 24 ? step : null;
}

function formatTimeText(hours, minutes) {
  const pad = (value) => String(value).padStart(2, "0");

  if (hours.length > 4) {
    return `${hours.map(pad).join("、")} 时的第 ${minutes.map(pad).join("、")} 分`;
  }

  const clock = [];

  for (const hour of hours) {
    for (const minute of minutes) {
      clock.push(`${pad(hour)}:${pad(minute)}`);
    }

    if (clock.length > 8) {
      break;
    }
  }

  return clock.length > 0 ? clock.join("、") : "-";
}
