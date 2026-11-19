import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const ADMIN_PASSWORD = "test-admin-password-0123456789";
const API_KEY = "sk-test-secret-value-1234567890";

const MODEL_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>fox</title></head>
<body><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="30" fill="#f59e0b" /></svg></body></html>`;

// ------------------------------------------------------------------ 工具

async function getFreePort() {
  const server = net.createServer();

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  return port;
}

// 模拟 OpenAI 兼容上游：只实现 /v1/chat/completions。
async function startStubUpstream() {
  const state = { calls: [], failNext: false, delayMs: 0 };

  const server = createServer(async (req, res) => {
    let body = "";

    for await (const chunk of req) {
      body += chunk;
    }

    state.calls.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization || "",
      body
    });

    res.setHeader("Content-Type", "application/json");

    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    if (state.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    }

    if (state.failNext) {
      state.failNext = false;
      res.writeHead(500);
      res.end(JSON.stringify({ error: { message: "stub upstream boom" } }));
      return;
    }

    const payload = JSON.parse(body || "{}");

    res.writeHead(200);
    res.end(
      JSON.stringify({
        id: "chatcmpl-stub",
        model: payload.model,
        choices: [{ index: 0, message: { role: "assistant", content: MODEL_HTML } }],
        usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 }
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    state,
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`服务进程提前退出，exitCode=${child.exitCode}`);
    }

    try {
      const response = await fetch(url);

      if (response.ok) {
        return;
      }
    } catch {
      // 还没起来
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error("服务启动超时");
}

function adminHeaders(extra = {}) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Check-Admin-Password": ADMIN_PASSWORD,
    ...extra
  };
}

// ------------------------------------------------------------------ 测试

describe("模型智商检测：接口与执行链路", () => {
  let child = null;
  let stub = null;
  let baseUrl = "";
  let tempDir = "";

  before(async () => {
    stub = await startStubUpstream();
    tempDir = await mkdtemp(path.join(os.tmpdir(), "sub2api-check-test-"));
    const port = await getFreePort();

    baseUrl = `http://127.0.0.1:${port}`;

    child = spawn(process.execPath, [path.join(repoRoot, "src", "server.js")], {
      cwd: repoRoot,
      // 沙箱下不能用管道抓子进程输出，这里直接丢弃。
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...process.env,
        PORT: String(port),
        PUBLIC_BASE_PATH: "/",
        CHECK_DB_FILE: path.join(tempDir, "check.db"),
        CHECK_ADMIN_PASSWORD: ADMIN_PASSWORD,
        CHECK_TIMEZONE: "Asia/Shanghai",
        CHECK_DISABLE_SCHEDULER: "true",
        CHECK_CRON: "*/30 * * * *",
        CHECK_REQUEST_TIMEOUT_SECONDS: "20"
      }
    });

    await waitForHealth(`${baseUrl}/healthz`, child);
  });

  after(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 4000);

        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    await stub?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("健康检查可用", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.service, "sub2api-check");
  });

  test("看板初始状态：3 个占位分组 + 1 道固定试题", async () => {
    const response = await fetch(`${baseUrl}/api/board`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.groups.length, 3);
    assert.equal(payload.columns.length, 3);
    assert.equal(payload.questions.length, 1);
    assert.equal(payload.question.prompt.includes("SVG"), true);
    assert.equal(payload.columns.every((column) => column.artifacts.length === 0), true);
    assert.equal(payload.schedule.enabled, true);
    assert.equal(payload.schedule.describe, "每 30 分钟检测一轮");

    // 看板不下发任何密钥字段
    assert.equal(JSON.stringify(payload).includes("apiKey"), false);
    assert.equal(JSON.stringify(payload).includes("baseUrl"), false);
  });

  test("管理接口需要密码", async () => {
    const unauthorized = await fetch(`${baseUrl}/api/admin/config`);
    assert.equal(unauthorized.status, 401);

    const wrong = await fetch(`${baseUrl}/api/admin/config`, {
      headers: adminHeaders({ "X-Check-Admin-Password": "wrong" })
    });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`${baseUrl}/api/admin/config`, { headers: adminHeaders() });
    const payload = await ok.json();

    assert.equal(ok.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.group_placeholder, undefined);
  });

  test("分组保存后 API Key 只回显掩码", async () => {
    const config = await (await fetch(`${baseUrl}/api/admin/config`, { headers: adminHeaders() })).json();
    const groups = config.groups.map((group, index) =>
      index === 0
        ? {
            id: group.id,
            name: group.name,
            baseUrl: `http://127.0.0.1:${stub.port}`,
            apiKey: API_KEY,
            model: "gpt-6.1-sol",
            reasoning: "low",
            protocol: "/v1/chat/completions",
            enabled: true
          }
        : {
            id: group.id,
            name: group.name,
            baseUrl: group.baseUrl,
            model: group.model,
            reasoning: group.reasoning,
            protocol: group.protocol,
            enabled: group.enabled
          }
    );
    const response = await fetch(`${baseUrl}/api/admin/groups`, {
      method: "PUT",
      headers: adminHeaders(),
      body: JSON.stringify({ groups })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.groups[0].hasApiKey, true);
    assert.equal(payload.groups[0].apiKey, "");
    assert.equal(payload.groups[0].apiKeyMasked.startsWith("sk-t"), true);
    assert.equal(JSON.stringify(payload).includes(API_KEY), false);
    assert.equal(payload.stats.configuredGroupCount, 1);
  });

  test("手动执行一轮：作品落库、状态流转、可读取预览", async () => {
    const startedResponse = await fetch(`${baseUrl}/api/admin/run`, {
      method: "POST",
      headers: adminHeaders()
    });
    const started = await startedResponse.json();

    assert.equal(startedResponse.status, 200);
    assert.equal(started.started, true);
    assert.equal(started.totalCount, 1);

    const config = await waitForRound(baseUrl);

    assert.equal(config.schedule.running, false);
    assert.equal(config.stats.total, 1);
    assert.equal(config.stats.byStatus.ok, 1);
    assert.equal(config.rounds[0].status, "done");

    // 上游必须收到 Bearer Key + 模型名 + 完整提示词
    const call = stub.state.calls.at(-1);
    const body = JSON.parse(call.body);

    assert.equal(call.url, "/v1/chat/completions");
    assert.equal(call.authorization, `Bearer ${API_KEY}`);
    assert.equal(body.model, "gpt-6.1-sol");
    assert.equal(body.stream, false);
    assert.equal(body.reasoning_effort, "low");
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, "user");
    assert.equal(body.messages[0].content.includes("SVG"), true);

    const board = await (await fetch(`${baseUrl}/api/board`)).json();
    const configuredColumn = board.columns.find((column) => column.group.configured);
    const otherColumn = board.columns.find((column) => !column.group.configured);

    assert.equal(configuredColumn.artifacts.length, 1);
    assert.equal(configuredColumn.round.state, "ok");
    assert.equal(configuredColumn.artifacts[0].status, "ok");
    assert.equal(configuredColumn.artifacts[0].modelLabel, "gpt-6.1-sol · low");
    assert.equal(configuredColumn.artifacts[0].durationMs >= 0, true);
    assert.equal(otherColumn.artifacts.length, 0);

    const artifactId = configuredColumn.artifacts[0].id;
    const htmlResponse = await fetch(`${baseUrl}/api/artifact/${artifactId}/html`);

    assert.equal(htmlResponse.status, 200);
    assert.equal(htmlResponse.headers.get("content-type").includes("text/html"), true);
    assert.equal(htmlResponse.headers.get("content-security-policy"), "sandbox allow-scripts");

    const html = await htmlResponse.text();

    assert.equal(html.includes("<svg"), true);

    const detail = await (await fetch(`${baseUrl}/api/artifact/${artifactId}`)).json();

    assert.equal(detail.artifact.prompt.includes("SVG"), true);
    assert.equal(detail.artifact.charCount > 0, true);
    // 公开详情不再下发上游原始响应
    assert.equal(detail.artifact.raw, undefined);
  });

  test("作品记录分页与筛选", async () => {
    const config = await (await fetch(`${baseUrl}/api/admin/config`, { headers: adminHeaders() })).json();
    const questions = [
      ...config.questions,
      {
        id: "question-second",
        title: "第二道题",
        note: "mid",
        prompt: "创建一个 HTML，画一只会眨眼的猫。",
        enabled: true
      }
    ];
    const updated = await (
      await fetch(`${baseUrl}/api/admin/questions`, {
        method: "PUT",
        headers: adminHeaders(),
        body: JSON.stringify({ questions })
      })
    ).json();

    assert.equal(updated.questions.length, 2);

    const started = await (
      await fetch(`${baseUrl}/api/admin/run`, { method: "POST", headers: adminHeaders() })
    ).json();

    assert.equal(started.totalCount, 2);
    await waitForRound(baseUrl);

    const page1 = await (
      await fetch(`${baseUrl}/api/admin/records?page=1&pageSize=1`, { headers: adminHeaders() })
    ).json();

    assert.equal(page1.total, 3);
    assert.equal(page1.totalPages, 3);
    assert.equal(page1.records.length, 1);

    const page2 = await (
      await fetch(`${baseUrl}/api/admin/records?page=2&pageSize=1`, { headers: adminHeaders() })
    ).json();

    assert.equal(page2.page, 2);
    assert.notEqual(page2.records[0].id, page1.records[0].id);

    const filtered = await (
      await fetch(`${baseUrl}/api/admin/records?questionId=question-second`, { headers: adminHeaders() })
    ).json();

    assert.equal(filtered.total, 1);
    assert.equal(filtered.records.every((record) => record.questionId === "question-second"), true);
    assert.equal(filtered.records.every((record) => record.questionNote === "mid"), true);

    const board = await (await fetch(`${baseUrl}/api/board?pageSize=1&page=2`)).json();

    assert.equal(board.paging.page, 2);
    assert.equal(board.columns.find((column) => column.group.configured).artifacts.length, 1);
  });

  test("删掉作品后看板同步", async () => {
    const records = await (
      await fetch(`${baseUrl}/api/admin/records?pageSize=50`, { headers: adminHeaders() })
    ).json();
    const target = records.records[0];

    const response = await fetch(`${baseUrl}/api/admin/artifacts/${target.id}`, {
      method: "DELETE",
      headers: adminHeaders()
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.records.total, 2);

    const missing = await fetch(`${baseUrl}/api/artifact/${target.id}/html`);
    assert.equal(missing.status, 404);
  });

  test("上游失败时记录错误而不丢轮次", async () => {
    stub.state.failNext = true;

    const config = await (await fetch(`${baseUrl}/api/admin/config`, { headers: adminHeaders() })).json();
    const groups = config.groups.map((group) => ({
      id: group.id,
      name: group.name,
      baseUrl: group.baseUrl,
      model: group.model,
      reasoning: group.reasoning,
      protocol: group.protocol,
      enabled: group.enabled
    }));

    // 不传 apiKey 表示沿用已保存的 Key
    await fetch(`${baseUrl}/api/admin/groups`, {
      method: "PUT",
      headers: adminHeaders(),
      body: JSON.stringify({ groups })
    });

    await fetch(`${baseUrl}/api/admin/run`, { method: "POST", headers: adminHeaders() });
    const after = await waitForRound(baseUrl);

    assert.equal(after.stats.byStatus.error > 0, true);
    assert.equal(after.rounds[0].status === "partial" || after.rounds[0].status === "error", true);

    const board = await (await fetch(`${baseUrl}/api/board`)).json();
    const column = board.columns.find((item) => item.group.configured);

    assert.equal(column.round.state, "error");
    assert.equal(column.round.error.includes("HTTP 500"), true);
  });

  test("Cron 预览接口校验表达式", async () => {
    const valid = await (
      await fetch(`${baseUrl}/api/admin/cron-preview?cron=${encodeURIComponent("*/15 * * * *")}`, {
        headers: adminHeaders()
      })
    ).json();

    assert.equal(valid.valid, true);
    assert.equal(valid.describe, "每 15 分钟检测一轮");
    assert.equal(valid.nextLabel.length > 0, true);

    const invalid = await (
      await fetch(`${baseUrl}/api/admin/cron-preview?cron=${encodeURIComponent("bad cron")}`, {
        headers: adminHeaders()
      })
    ).json();

    assert.equal(invalid.valid, false);
    assert.equal(invalid.describe.includes("Cron"), true);
  });

  test("定时任务不能设置为非法表达式", async () => {
    const response = await fetch(`${baseUrl}/api/admin/schedule`, {
      method: "PUT",
      headers: adminHeaders(),
      body: JSON.stringify({ cron: "nope", enabled: true })
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "invalid_cron");
  });

  test("可以只检测单个分组，不影响其他分组的历史", async () => {
    const config = await (
      await fetch(`${baseUrl}/api/admin/config`, { headers: adminHeaders() })
    ).json();
    const enabledQuestionCount = config.questions.filter((question) => question.enabled).length;
    const groups = config.groups.map((group) =>
      group.id === "group-2"
        ? {
            id: group.id,
            name: group.name,
            baseUrl: `http://127.0.0.1:${stub.port}`,
            apiKey: "sk-second-group-key",
            model: "gpt-6.1-terra",
            reasoning: "high",
            protocol: "/v1/chat/completions",
            enabled: true
          }
        : {
            id: group.id,
            name: group.name,
            baseUrl: group.baseUrl,
            model: group.model,
            reasoning: group.reasoning,
            protocol: group.protocol,
            enabled: group.enabled
          }
    );

    await fetch(`${baseUrl}/api/admin/groups`, {
      method: "PUT",
      headers: adminHeaders(),
      body: JSON.stringify({ groups })
    });

    const beforeCounts = await countByGroup(baseUrl);

    const started = await (
      await fetch(`${baseUrl}/api/admin/run`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ groupId: "group-2" })
      })
    ).json();

    assert.equal(started.started, true);
    assert.equal(started.groupId, "group-2");
    assert.equal(started.groupName, "PRO2");
    assert.equal(started.totalCount, enabledQuestionCount);

    const afterRound = await waitForRound(baseUrl);

    assert.equal(afterRound.schedule.running, false);

    const afterCounts = await countByGroup(baseUrl);

    // 只有 PRO2 多出了作品，PRO1 的历史保持不变
    assert.equal(afterCounts["group-2"] - beforeCounts["group-2"], enabledQuestionCount);
    assert.equal(afterCounts["group-1"], beforeCounts["group-1"]);

    const recentCall = stub.state.calls.at(-1);
    const body = JSON.parse(recentCall.body);

    assert.equal(body.model, "gpt-6.1-terra");
    assert.equal(body.reasoning_effort, "high");
    assert.equal(recentCall.authorization, "Bearer sk-second-group-key");
  });

  test("单个分组未配置时给出明确报错", async () => {
    const response = await fetch(`${baseUrl}/api/admin/run`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ groupId: "group-3" })
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "no_groups");
    assert.equal(payload.message.includes("PRO3"), true);
  });

  test("不存在的分组直接拒绝", async () => {
    const response = await fetch(`${baseUrl}/api/admin/run`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ groupId: "group-not-exist" })
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "group_not_found");
  });

  test("分组排序决定看板列顺序", async () => {
    const config = await (
      await fetch(`${baseUrl}/api/admin/config`, { headers: adminHeaders() })
    ).json();
    const originalOrder = config.groups.map((group) => group.id);
    const reversedOrder = [...originalOrder].reverse();
    const byId = new Map(config.groups.map((group) => [group.id, group]));

    async function saveOrder(order) {
      const groups = order.map((id) => {
        const group = byId.get(id);

        return {
          id: group.id,
          name: group.name,
          baseUrl: group.baseUrl,
          model: group.model,
          reasoning: group.reasoning,
          protocol: group.protocol,
          enabled: group.enabled
        };
      });

      return fetch(`${baseUrl}/api/admin/groups`, {
        method: "PUT",
        headers: adminHeaders(),
        body: JSON.stringify({ groups })
      });
    }

    const response = await saveOrder(reversedOrder);

    assert.equal(response.status, 200);

    const board = await (await fetch(`${baseUrl}/api/board`)).json();

    assert.deepEqual(
      board.columns.map((column) => column.group.id),
      reversedOrder
    );
    assert.deepEqual(
      board.groups.map((group) => group.id),
      reversedOrder
    );

    // 恢复原顺序，保持其他用例的初始前提
    await saveOrder(originalOrder);

    const restored = await (await fetch(`${baseUrl}/api/board`)).json();

    assert.deepEqual(
      restored.columns.map((column) => column.group.id),
      originalOrder
    );
  });
});

async function countByGroup(baseUrl, pageSize = 100) {
  const records = await (
    await fetch(`${baseUrl}/api/admin/records?pageSize=${pageSize}`, { headers: adminHeaders() })
  ).json();
  const counts = {};

  for (const record of records.records) {
    counts[record.groupId] = (counts[record.groupId] || 0) + 1;
  }

  for (const groupId of ["group-1", "group-2", "group-3"]) {
    counts[groupId] = counts[groupId] || 0;
  }

  return counts;
}

async function waitForRound(baseUrl, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const config = await (
      await fetch(`${baseUrl}/api/admin/config`, { headers: adminHeaders() })
    ).json();

    if (!config.schedule.running) {
      return config;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error("等待检测轮次超时");
}

describe("定时任务：启动时排下一次执行", () => {
  let child = null;
  let tempDir = "";
  let baseUrl = "";

  before(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "sub2api-check-cron-"));
    const port = await getFreePort();

    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(repoRoot, "src", "server.js")], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...process.env,
        PORT: String(port),
        PUBLIC_BASE_PATH: "/",
        CHECK_DB_FILE: path.join(tempDir, "check.db"),
        CHECK_ADMIN_PASSWORD: ADMIN_PASSWORD,
        CHECK_TIMEZONE: "Asia/Shanghai",
        CHECK_CRON: "*/15 * * * *",
        CHECK_CRON_ENABLED: "true"
      }
    });

    await waitForHealth(`${baseUrl}/healthz`, child);
  });

  after(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 4000);

        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  test("启用定时器后会算出并持久化下一次执行时间", async () => {
    const config = await (
      await fetch(`${baseUrl}/api/admin/config`, { headers: adminHeaders() })
    ).json();

    assert.equal(config.schedule.enabled, true);
    assert.equal(config.schedule.running, false);
    assert.equal(config.schedule.describe, "每 15 分钟检测一轮");

    const next = Date.parse(config.schedule.nextRunAt);

    assert.equal(Number.isFinite(next), true);
    assert.equal(config.schedule.nextRunAt.endsWith(":00.000Z"), true);
    assert.equal(config.schedule.previewNextRunAt.label.length > 0, true);

    // 下一次执行必须落在未来 15 分钟内
    const delta = next - Date.now();

    assert.equal(delta > 0, true);
    assert.equal(delta <= 15 * 60 * 1000 + 5000, true);
  });

  test("停止定时器后不再计划下一次执行", async () => {
    const response = await fetch(`${baseUrl}/api/admin/schedule`, {
      method: "PUT",
      headers: adminHeaders(),
      body: JSON.stringify({ cron: "*/15 * * * *", enabled: false })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.schedule.enabled, false);
    assert.equal(payload.schedule.nextRunAt, "");
  });
});
