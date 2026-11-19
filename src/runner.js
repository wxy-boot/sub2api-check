import { randomUUID } from "node:crypto";
import { extractArtifact } from "./artifact.js";
import { DEFAULT_SYSTEM_PROMPT } from "./config.js";
import { describeCron, nextCronTime } from "./cron.js";
import { httpError } from "./http.js";
import { logError, logInfo, logWarn } from "./log.js";
import { isoNow } from "./time.js";

const MAX_TIMER_DELAY = 2_000_000_000;

export function createRunner({ config, store, upstream }) {
  let runningRound = null;
  let timer = null;

  function getSchedule() {
    const expression = store.getSetting("schedule_cron") || config.defaultCron;
    const enabled = store.readBoolSetting("schedule_enabled", config.defaultCronEnabled);

    return {
      expression,
      enabled,
      describe: describeCron(expression),
      nextRunAt: store.getSetting("next_run_at") || "",
      lastRunAt: store.getSetting("last_run_at") || ""
    };
  }

  function getSystemPrompt() {
    // 后台保存过就用保存值（哪怕是空字符串＝不加前置提示），否则回退到内置默认值。
    if (store.readBoolSetting("system_prompt_custom", false)) {
      return store.getSetting("system_prompt");
    }

    return store.getSetting("system_prompt") || DEFAULT_SYSTEM_PROMPT;
  }

  /** 每个分组的实际提示词 = 统一前置要求 + 试题原文。 */
  function buildPrompt(question) {
    const preamble = getSystemPrompt().trim();
    return preamble ? `${preamble}\n\n— 试题 —\n${question.prompt.trim()}` : question.prompt.trim();
  }

  function getStatus() {
    return {
      ...getSchedule(),
      running: Boolean(runningRound)
    };
  }

  /** 不真正执行，只检查当前配置是否可跑一轮。 */
  function validateRun() {
    const questions = store.getQuestions().filter((question) => question.enabled);
    const groups = store.getGroups().filter((group) => group.enabled);
    const runnableGroups = groups.filter(
      (group) => group.baseUrl.trim() && group.model.trim() && group.apiKey.trim()
    );

    if (questions.length === 0) {
      return { ok: false, code: "no_questions", message: "没有启用的检测题目，请先在后台添加题目。" };
    }

    if (runnableGroups.length === 0) {
      return {
        ok: false,
        code: "no_groups",
        message:
          groups.length === 0
            ? "没有启用的检测分组，请先在后台添加分组。"
            : "启用的分组还缺少 API 地址、API Key 或模型名称，请先补全。"
      };
    }

    return {
      ok: true,
      questions,
      runnableGroups,
      unconfigured: groups.filter((group) => !runnableGroups.includes(group)),
      totalCount: questions.length * runnableGroups.length
    };
  }

  async function runRound(trigger = "cron") {
    if (runningRound) {
      logWarn("round.skipped", { trigger, reason: "already_running", roundId: runningRound.id });
      return { ok: false, skipped: true, reason: "already_running", roundId: runningRound.id };
    }

    const check = validateRun();

    if (!check.ok) {
      throw httpError(400, check.code, check.message);
    }

    const { questions, runnableGroups, unconfigured } = check;
    const round = {
      id: randomUUID(),
      trigger,
      status: "running",
      startedAt: isoNow()
    };
    const totalCount = check.totalCount;

    store.createRound({ ...round, totalCount });
    runningRound = round;

    logInfo("round.started", {
      roundId: round.id,
      trigger,
      totalCount,
      groups: runnableGroups.map((group) => group.name),
      questions: questions.map((question) => question.title),
      unconfiguredGroups: unconfigured.map((group) => group.name)
    });

    const tasks = [];

    for (const group of runnableGroups) {
      for (const question of questions) {
        tasks.push({ group, question });
      }
    }

    let okCount = 0;
    let failedCount = 0;

    try {
      await mapLimit(tasks, config.concurrency, async ({ group, question }) => {
        const result = await runTask({ round, group, question });

        if (result.status === "ok") {
          okCount += 1;
        } else {
          failedCount += 1;
        }
      });
    } finally {
      const status =
        failedCount === 0 ? "done" : failedCount === totalCount ? "error" : "partial";
      const finishedAt = isoNow();

      store.finishRound(round.id, {
        status,
        finishedAt,
        totalCount,
        okCount,
        failedCount,
        note: unconfigured.length > 0 ? `跳过未配置分组：${unconfigured.map((g) => g.name).join("、")}` : ""
      });
      store.setSetting("last_run_at", finishedAt);
      runningRound = null;

      logInfo("round.finished", {
        roundId: round.id,
        status,
        okCount,
        failedCount,
        totalCount,
        durationMs: Date.parse(finishedAt) - Date.parse(round.startedAt)
      });
    }

    return {
      ok: true,
      roundId: round.id,
      totalCount,
      okCount,
      failedCount,
      skippedGroups: unconfigured.map((group) => group.name)
    };
  }

  async function runTask({ round, group, question }) {
    const prompt = buildPrompt(question);
    const startedAt = Date.now();

    try {
      const result = await upstream.runChatCompletion(group, prompt);
      const artifact = extractArtifact(result.content, { maxChars: config.maxOutputChars });

      store.insertArtifact({
        id: randomUUID(),
        roundId: round.id,
        questionId: question.id,
        groupId: group.id,
        status: "ok",
        kind: artifact.kind,
        model: result.model || group.model,
        durationMs: result.durationMs,
        prompt,
        html: artifact.kind === "html" ? artifact.html : artifact.text,
        raw: result.raw,
        error: "",
        charCount: artifact.charCount,
        createdAt: isoNow()
      });

      logInfo("artifact.saved", {
        roundId: round.id,
        group: group.name,
        question: question.title,
        kind: artifact.kind,
        charCount: artifact.charCount,
        durationMs: result.durationMs
      });

      return { status: "ok" };
    } catch (error) {
      const durationMs = Number(error?.details?.durationMs) || Date.now() - startedAt;

      store.insertArtifact({
        id: randomUUID(),
        roundId: round.id,
        questionId: question.id,
        groupId: group.id,
        status: "error",
        kind: "text",
        model: group.model,
        durationMs,
        prompt,
        html: "",
        raw: String(error?.details?.raw || ""),
        error: error?.message || "未知错误",
        charCount: 0,
        createdAt: isoNow()
      });

      logError("artifact.failed", {
        roundId: round.id,
        group: group.name,
        question: question.title,
        code: error?.code || "",
        message: error?.message || ""
      });

      return { status: "error" };
    }
  }

  // ---------- 定时器 ----------

  function recover() {
    const stale = store.getRunningRound();

    if (stale) {
      store.finishRound(stale.id, {
        status: "error",
        finishedAt: isoNow(),
        totalCount: Number(stale.total_count || 0),
        okCount: Number(stale.ok_count || 0),
        failedCount: Number(stale.failed_count || 0),
        note: "服务重启时该轮次未完成，已标记为中断。"
      });
      logWarn("round.recovered", { roundId: stale.id });
    }
  }

  function start() {
    recover();

    if (config.disableScheduler) {
      logWarn("scheduler.disabled", { message: "CHECK_DISABLE_SCHEDULER=true，定时器未启动。" });
      return;
    }

    scheduleNext();
  }

  function scheduleNext() {
    clearTimer();

    const schedule = getSchedule();

    if (!schedule.enabled) {
      store.setSetting("next_run_at", "");
      logInfo("scheduler.paused", { cron: schedule.expression });
      return;
    }

    const next = nextCronTime(schedule.expression, new Date(), config.timezone);

    if (!next) {
      store.setSetting("next_run_at", "");
      logWarn("scheduler.no_next_run", { cron: schedule.expression });
      return;
    }

    store.setSetting("next_run_at", next.toISOString());
    const delay = Math.max(1_000, Math.min(next.getTime() - Date.now(), MAX_TIMER_DELAY));

    timer = setTimeout(() => {
      timer = null;
      void fire();
    }, delay);
    timer.unref?.();

    logInfo("scheduler.planned", {
      cron: schedule.expression,
      describe: schedule.describe,
      nextRunAt: next.toISOString(),
      delayMs: delay
    });
  }

  async function fire() {
    const plannedAt = Date.parse(store.getSetting("next_run_at") || "");

    // 定时器被最大延时截断时会提前醒来，这里补一次判断。
    if (Number.isFinite(plannedAt) && Date.now() + 1_000 < plannedAt) {
      scheduleNext();
      return;
    }

    try {
      await runRound("cron");
    } catch (error) {
      logError("scheduler.round_failed", { message: error?.message || "", code: error?.code || "" });
    } finally {
      scheduleNext();
    }
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function stop() {
    clearTimer();
  }

  return {
    start,
    stop,
    recover,
    runRound,
    validateRun,
    refreshSchedule: scheduleNext,
    getStatus,
    buildPrompt,
    getSystemPrompt
  };
}

async function mapLimit(items, limit, worker) {
  const queue = [...items];
  const size = Math.max(1, Math.min(limit || 1, queue.length || 1));
  const workers = Array.from({ length: size }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();

      if (item === undefined) {
        return;
      }

      await worker(item);
    }
  });

  await Promise.all(workers);
}
