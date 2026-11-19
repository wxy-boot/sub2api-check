import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCron, nextCronTime, parseCron, validateCron } from "../src/cron.js";

const SHANGHAI = "Asia/Shanghai";

function iso(date) {
  return date instanceof Date ? date.toISOString() : date;
}

test("validateCron 接受标准 5 段表达式并归一化空白", () => {
  assert.equal(validateCron("  */30   * * * * "), "*/30 * * * *");
  assert.equal(validateCron("@daily"), "0 0 * * *");
});

test("validateCron 拒绝非法表达式", () => {
  assert.throws(() => validateCron("*/30 * * *"), (error) => error.code === "invalid_cron");
  assert.throws(() => validateCron("61 * * * *"), (error) => error.code === "invalid_cron");
  assert.throws(() => validateCron("* * * * * *"), (error) => error.code === "invalid_cron");
  assert.throws(() => validateCron("5-1 * * * *"), (error) => error.code === "invalid_cron");
  assert.throws(() => validateCron(""), (error) => error.code === "invalid_cron");
});

test("parseCron 把 7 折叠成周日", () => {
  const schedule = parseCron("0 0 * * 7");
  assert.deepEqual([...schedule.dayOfWeek], [0]);
});

test("nextCronTime：每 30 分钟", () => {
  assert.equal(
    iso(nextCronTime("*/30 * * * *", new Date("2026-11-19T01:00:00Z"), SHANGHAI)),
    "2026-11-19T01:30:00.000Z"
  );
  assert.equal(
    iso(nextCronTime("*/30 * * * *", new Date("2026-11-19T01:07:33Z"), SHANGHAI)),
    "2026-11-19T01:30:00.000Z"
  );
  assert.equal(
    iso(nextCronTime("*/30 * * * *", new Date("2026-11-19T01:59:59Z"), SHANGHAI)),
    "2026-11-19T02:00:00.000Z"
  );
});

test("nextCronTime：每天固定时刻按服务端时区解释", () => {
  // 上海时间 09:00 = UTC 01:00
  assert.equal(
    iso(nextCronTime("0 9 * * *", new Date("2026-11-19T00:00:00Z"), SHANGHAI)),
    "2026-11-19T01:00:00.000Z"
  );
  // 正好命中当前时刻时，取下一次（次日）
  assert.equal(
    iso(nextCronTime("0 9 * * *", new Date("2026-11-19T01:00:00Z"), SHANGHAI)),
    "2026-11-20T01:00:00.000Z"
  );
});

test("nextCronTime：每月 1 日", () => {
  assert.equal(
    iso(nextCronTime("30 8 1 * *", new Date("2026-11-19T00:00:00Z"), SHANGHAI)),
    "2026-12-01T00:30:00.000Z"
  );
});

test("nextCronTime：工作日只在周一到周五触发", () => {
  const from = new Date("2026-11-20T02:00:00Z"); // 上海 2026-11-20 10:00（周五）
  const next = nextCronTime("0 9 * * 1-5", from, SHANGHAI);

  // 周五 10:00 之后的下一次是下周一 09:00（上海）= 2026-11-23T01:00Z
  assert.equal(next.toISOString(), "2026-11-23T01:00:00.000Z");
});

test("nextCronTime：日与周同时受限时满足其一即可", () => {
  // 每月 13 日或每周五的 0 点
  const next = nextCronTime("0 0 13 * 5", new Date("2026-11-19T00:00:00Z"), SHANGHAI);
  assert.equal(next.toISOString(), "2026-11-19T16:00:00.000Z");
});

test("nextCronTime：没有匹配日期时返回 null", () => {
  assert.equal(nextCronTime("0 0 30 2 *", new Date("2026-11-19T00:00:00Z"), SHANGHAI), null);
});

test("describeCron 输出中文解释", () => {
  assert.equal(describeCron("*/30 * * * *"), "每 30 分钟检测一轮");
  assert.equal(describeCron("* * * * *"), "每分钟检测一轮");
  assert.equal(describeCron("0 9 * * *"), "每天 09:00");
  assert.equal(describeCron("0 9 * * 1-5"), "每周一、周二、周三、周四、周五 09:00");
  assert.equal(describeCron("0 3 1 * *"), "每月 1 日 03:00");
  assert.equal(describeCron("0 */2 * * *"), "每 2 小时");
  assert.equal(describeCron("不是 cron"), "Cron 表达式不合法");
});
