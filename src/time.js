const PARTS_FORMATTERS = new Map();

function partsFormatter(timezone) {
  let formatter = PARTS_FORMATTERS.get(timezone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    PARTS_FORMATTERS.set(timezone, formatter);
  }

  return formatter;
}

export function zonedParts(date, timezone) {
  const parts = partsFormatter(timezone).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second
  };
}

export function dateKey(date, timezone) {
  const values = zonedParts(date, timezone);
  return `${values.year}-${values.month}-${values.day}`;
}

/** 11/19 09:07:37 —— 看板与后台统一使用的短时间格式。 */
export function formatShortTime(value, timezone) {
  const date = toDate(value);

  if (!date) {
    return "-";
  }

  const parts = zonedParts(date, timezone);
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** 2026-11-19 09:07:37 —— 导出、详情页使用的完整时间格式。 */
export function formatFullTime(value, timezone) {
  const date = toDate(value);

  if (!date) {
    return "-";
  }

  const parts = zonedParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function toDate(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isoNow(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

export function shiftDateKey(date, delta) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));

  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0")
  ].join("-");
}
