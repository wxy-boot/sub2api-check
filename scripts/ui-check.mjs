// 用 Edge/Chrome 的 DevTools 协议截图并收集控制台错误，仅用于本地自测。
// 用法：node scripts/ui-check.mjs [baseUrl]
// 依赖：本机已安装 Edge 或 Chrome（headless），Node >= 22（内置 WebSocket）。

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const BASE = (process.argv[2] || "http://127.0.0.1:8799").replace(/\/+$/, "");
const PORT = 9333;
const OUT_DIR = path.join(repoRoot, "picture");
const ADMIN_PASSWORD = process.env.DEMO_PASSWORD || "demo-password";

const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
];

async function pickBrowser() {
  const { existsSync } = await import("node:fs");

  for (const candidate of BROWSERS) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("没有找到 Edge/Chrome 可执行文件");
}

async function waitForDevTools(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);

      if (response.ok) {
        return;
      }
    } catch {
      // 还没起来
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error("DevTools 端口没有就绪");
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await pickBrowser();
  const profile = path.join(process.env.TEMP || "/tmp", `check-ui-${Date.now()}`);
  const child = spawn(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "about:blank"
    ],
    { stdio: "ignore" }
  );

  await waitForDevTools();

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");

  if (!page) {
    throw new Error("没有可用的页面 target");
  }

  const client = await connect(page.webSocketDebuggerUrl);
  const problems = [];

  client.on("Runtime.exceptionThrown", (params) => {
    problems.push(`exception: ${params.exceptionDetails?.text} ${params.exceptionDetails?.exception?.description || ""}`);
  });
  client.on("Runtime.consoleAPICalled", (params) => {
    if (params.type === "error") {
      problems.push(`console.error: ${params.args.map((arg) => arg.value ?? arg.description).join(" ")}`);
    }
  });
  client.on("Log.entryAdded", (params) => {
    if (params.entry.level === "error") {
      problems.push(`log: ${params.entry.text} ${params.entry.url || ""}`);
    }
  });

  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Log.enable");

  async function shoot(name, url, options = {}) {
    const width = options.width || 1636;
    const height = options.height || 1100;

    await client.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
    await client.send("Page.navigate", { url });
    await client.send("Runtime.evaluate", {
      expression: `sessionStorage.setItem("checkAdminPassword", ${JSON.stringify(ADMIN_PASSWORD)});`
    }).catch(() => {});
    await sleep(options.settleMs || 2500);

    await client.send("Runtime.evaluate", {
      expression: `window.scrollTo(0, ${options.scrollY || 0});`
    });
    // 缩略图是 loading="lazy" 的 iframe，滚动后要留时间等它们加载完再截图。
    await sleep(options.scrollY ? 1600 : 400);

    if (options.clickSelector) {
      await client.send("Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(options.clickSelector)})?.click();`
      });
      await sleep(900);
    }

    if (options.evaluate) {
      await client.send("Runtime.evaluate", { expression: options.evaluate });
      await sleep(options.afterEvaluateMs || 1200);
    }

    const result = await client.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false
    });

    await writeFile(path.join(OUT_DIR, `${name}.png`), Buffer.from(result.data, "base64"));
    console.log(`saved picture/${name}.png`);
  }

  // 先在同一 origin 下写入 admin 密码，后续 admin 页面自动登录。
  await client.send("Page.navigate", { url: `${BASE}/` });
  await sleep(1200);
  await client.send("Runtime.evaluate", {
    expression: `sessionStorage.setItem("checkAdminPassword", ${JSON.stringify(ADMIN_PASSWORD)});`
  });

  await shoot("board", `${BASE}/`, { settleMs: 3500 });
  await shoot("board-records", `${BASE}/`, { settleMs: 2500, scrollY: 700 });
  await shoot("board-modal", `${BASE}/`, {
    settleMs: 3000,
    evaluate: `document.querySelector('.frame[data-frame="1"]')?.click();`,
    afterEvaluateMs: 2500
  });
  await shoot("board-mobile", `${BASE}/`, { width: 430, height: 1000, settleMs: 3000 });
  await shoot("admin-schedule", `${BASE}/admin/`, { width: 1456, height: 1150, settleMs: 3000 });
  await shoot("admin-questions", `${BASE}/admin/`, {
    width: 1456,
    height: 1200,
    settleMs: 2500,
    clickSelector: '[data-tab="questions"]'
  });
  await shoot("admin-groups", `${BASE}/admin/`, {
    width: 1456,
    height: 1400,
    settleMs: 2500,
    clickSelector: '[data-tab="groups"]'
  });
  // 演示「上移」后的行顺序（未保存，只验证交互）
  await shoot("admin-groups-sorted", `${BASE}/admin/`, {
    width: 1456,
    height: 780,
    settleMs: 2500,
    clickSelector: '[data-tab="groups"]',
    evaluate: `document.querySelectorAll('#groupRows .edit-row')[2]?.querySelector('.move-up')?.click();`,
    afterEvaluateMs: 900
  });
  await shoot("admin-records", `${BASE}/admin/`, {
    width: 1456,
    height: 1500,
    settleMs: 2500,
    clickSelector: '[data-tab="records"]'
  });
  await shoot("admin-login", `${BASE}/admin/`, {
    width: 1456,
    height: 820,
    settleMs: 2000,
    evaluate: `sessionStorage.removeItem("checkAdminPassword"); location.reload();`,
    afterEvaluateMs: 2500
  });

  if (problems.length > 0) {
    console.log("\n前端错误：");
    for (const problem of [...new Set(problems)]) {
      console.log(` - ${problem}`);
    }
  } else {
    console.log("\n前端无 console/页面错误。");
  }

  client.close();
  child.kill("SIGTERM");
  await sleep(400);
  process.exit(0);

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 1;

    const client = {
      send(method, params = {}) {
        const id = nextId;

        nextId += 1;
        socket.send(JSON.stringify({ id, method, params }));

        return new Promise((resolveSend, rejectSend) => {
          pending.set(id, { resolve: resolveSend, reject: rejectSend });
        });
      },
      on(event, handler) {
        listeners.set(event, handler);
      },
      close() {
        socket.close();
      }
    };

    socket.addEventListener("open", () => resolve(client));
    socket.addEventListener("error", (event) => reject(new Error(`WebSocket 连接失败：${event.message || ""}`)));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);

      if (message.id && pending.has(message.id)) {
        const { resolve: resolveSend, reject: rejectSend } = pending.get(message.id);

        pending.delete(message.id);

        if (message.error) {
          rejectSend(new Error(`${message.method || "CDP"} 失败：${message.error.message}`));
          return;
        }

        resolveSend(message.result);
        return;
      }

      const handler = listeners.get(message.method);

      if (handler) {
        handler(message.params);
      }
    });
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
