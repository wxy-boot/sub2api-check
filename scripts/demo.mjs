// 本地演示脚本：起一个假的 OpenAI 兼容上游 + 真实服务，灌两轮作品，方便看界面效果。
// 用法：node scripts/demo.mjs
// 看板：http://127.0.0.1:8799/   后台：http://127.0.0.1:8799/admin/（密码 demo-password）

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const PORT = Number(process.env.DEMO_PORT || 8799);
const UPSTREAM_PORT = Number(process.env.DEMO_UPSTREAM_PORT || 8801);
const PASSWORD = process.env.DEMO_PASSWORD || "demo-password";
const DB_FILE = path.join(repoRoot, "data", "demo.db");
const BASE = `http://127.0.0.1:${PORT}`;

const VARIANTS = {
  "gpt-6.1-sol": { sky: "#f6e3c5", sand: "#e9c893", sun: "#f7c96b", fox: "#e2643a", blanket: "#2f7f8a" },
  "gpt-6.1-terra": { sky: "#f3ddc0", sand: "#e3bd85", sun: "#f5c168", fox: "#dd5b32", blanket: "#4a7f6f" },
  "claude-opus-4.5": { sky: "#f7e8cc", sand: "#edcfa0", sun: "#ffcf7a", fox: "#d9552c", blanket: "#3c6f8f" }
};

function artwork(model, round) {
  const palette = VARIANTS[model] || VARIANTS["gpt-6.1-sol"];
  const season = round % 2 === 0 ? "A LITTLE DESERT JOURNEY" : "SLOW RIDE, LONG WAY";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>狐狸骑骆驼</title>
<style>
  html, body { margin: 0; height: 100%; background: ${palette.sky}; }
  .scene { position: relative; width: 100%; height: 100%; overflow: hidden; font-family: "PingFang SC", "Microsoft YaHei", sans-serif; }
  .sun { position: absolute; left: 74%; top: 16%; width: 92px; height: 92px; border-radius: 50%;
         background: radial-gradient(circle at 40% 38%, #fff3cf, ${palette.sun}); box-shadow: 0 0 70px rgba(247,201,107,.55); }
  .dune { position: absolute; left: -10%; width: 120%; border-radius: 50% 50% 0 0; }
  .d1 { bottom: 24%; height: 34%; background: ${palette.sand}; opacity: .75; }
  .d2 { bottom: 12%; height: 30%; background: ${palette.sand}; }
  .d3 { bottom: 0; height: 22%; background: #d9b278; }
  .cactus { position: absolute; right: 12%; bottom: 20%; width: 8px; height: 46px; border-radius: 4px; background: #a8b06a; }
  .cactus::before, .cactus::after { content: ""; position: absolute; width: 6px; height: 20px; border-radius: 4px;
         background: #a8b06a; }
  .cactus::before { left: -10px; top: 12px; transform: rotate(-32deg); }
  .cactus::after { right: -9px; top: 18px; transform: rotate(28deg); }
  .title { position: absolute; left: 6%; top: 12%; color: #8a6134; }
  .title small { display: block; font-size: 11px; letter-spacing: .34em; opacity: .62; }
  .title h1 { margin: 10px 0 0; font-size: 30px; letter-spacing: .04em; color: #6d4a22; }
  .title p { margin: 8px 0 0; font-size: 12px; color: #a07d4e; letter-spacing: .12em; }
  .rider { position: absolute; left: 50%; bottom: 18%; width: 420px; transform: translateX(-50%); }
  .bob { animation: bob 2.6s ease-in-out infinite; }
  .leg-front { transform-origin: 196px 150px; animation: step 1.3s ease-in-out infinite; }
  .leg-back { transform-origin: 92px 148px; animation: step 1.3s ease-in-out infinite reverse; }
  .tail { transform-origin: 60px 96px; animation: wag 2.1s ease-in-out infinite; }
  .scarf { transform-origin: 214px 52px; animation: flap 1.9s ease-in-out infinite; }
  @keyframes bob { 50% { transform: translateY(-7px); } }
  @keyframes step { 50% { transform: rotate(9deg); } }
  @keyframes wag { 50% { transform: rotate(-12deg); } }
  @keyframes flap { 50% { transform: rotate(-8deg) translateX(-4px); } }
  .stamp { position: absolute; right: 5%; bottom: 6%; padding: 5px 12px; border: 1px solid rgba(138,97,52,.35);
           border-radius: 999px; color: #8a6134; font-size: 10px; letter-spacing: .22em; }
</style>
</head>
<body>
<div class="scene">
  <div class="sun"></div>
  <div class="dune d1"></div>
  <div class="dune d2"></div>
  <div class="dune d3"></div>
  <div class="cactus"></div>
  <div class="title">
    <small>${season}</small>
    <h1>慢慢走，去远方。</h1>
    <p>一只狐狸 · 一匹骆驼 · 一段好风景</p>
  </div>
  <svg class="rider" viewBox="0 0 300 200" aria-label="狐狸骑骆驼">
    <g class="bob">
      <path class="leg-back" d="M96 148 q-6 24 -2 36 h10 q2 -20 6 -34 z" fill="${palette.fox}" opacity=".92" />
      <path d="M78 92 q-16 30 -10 60 h22 q-2 -30 8 -52 z" fill="${palette.sand}" stroke="#c99a5c" stroke-width="2" />
      <ellipse cx="150" cy="96" rx="72" ry="34" fill="${palette.sand}" stroke="#c99a5c" stroke-width="2" />
      <path class="tail" d="M80 92 q-18 4 -20 22 q10 -8 22 -6 z" fill="#c99a5c" />
      <path d="M206 78 q16 -30 8 -44 q-6 -10 -16 -4 q-6 8 2 14 q6 6 6 34 z" fill="${palette.sand}" stroke="#c99a5c" stroke-width="2" />
      <ellipse cx="196" cy="40" rx="20" ry="13" fill="${palette.sand}" stroke="#c99a5c" stroke-width="2" />
      <circle cx="186" cy="36" r="2.6" fill="#7a5a33" />
      <path class="leg-front" d="M198 148 q4 24 0 36 h10 q6 -20 6 -34 z" fill="${palette.fox}" opacity=".92" />
      <path d="M150 62 q34 -6 40 16 q-20 10 -40 6 z" fill="${palette.blanket}" opacity=".92" />
      <path d="M148 60 l4 24 M170 58 l4 26" stroke="#f6efe0" stroke-width="2" opacity=".7" />
      <g>
        <path class="scarf" d="M214 52 q22 6 30 -4 q-6 16 -30 10 z" fill="${palette.fox}" />
        <ellipse cx="206" cy="44" rx="16" ry="13" fill="${palette.fox}" />
        <path d="M196 32 l-4 -12 l12 8 z" fill="${palette.fox}" />
        <path d="M216 30 l6 -12 l2 14 z" fill="${palette.fox}" />
        <path d="M212 42 q10 -4 16 2 q-8 8 -16 4 z" fill="#fff" opacity=".92" />
        <circle cx="214" cy="44" r="2.2" fill="#3c2a1c" />
      </g>
    </g>
  </svg>
  <div class="stamp">SVG · 2D 动画</div>
</div>
</body>
</html>`;
}

async function startStub() {
  let round = 0;
  const server = createServer(async (req, res) => {
    let body = "";

    for await (const chunk of req) {
      body += chunk;
    }

    if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
      res.writeHead(404).end('{"error":{"message":"not found"}}');
      return;
    }

    const payload = JSON.parse(body || "{}");
    round += 1;
    await new Promise((resolve) => setTimeout(resolve, 600 + (round % 3) * 250));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: `demo-${round}`,
        model: payload.model,
        choices: [{ index: 0, message: { role: "assistant", content: artwork(payload.model, round) } }],
        usage: { prompt_tokens: 88, completion_tokens: 1420, total_tokens: 1508 }
      })
    );
  });

  await new Promise((resolve) => server.listen(UPSTREAM_PORT, "127.0.0.1", resolve));
  return server;
}

async function main() {
  await mkdir(path.join(repoRoot, "data"), { recursive: true });
  await rm(DB_FILE, { force: true });
  await rm(`${DB_FILE}-wal`, { force: true });
  await rm(`${DB_FILE}-shm`, { force: true });

  const stub = await startStub();
  const child = spawn(process.execPath, [path.join(repoRoot, "src", "server.js")], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(PORT),
      PUBLIC_BASE_PATH: "/",
      CHECK_DB_FILE: DB_FILE,
      CHECK_ADMIN_PASSWORD: PASSWORD,
      CHECK_DISABLE_SCHEDULER: "true",
      CHECK_CRON: "*/30 * * * *"
    }
  });

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Check-Admin-Password": PASSWORD
  };

  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/healthz`);

      if (response.ok) {
        break;
      }
    } catch {
      // 还没起来
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const config = await (await fetch(`${BASE}/api/admin/config`, { headers })).json();
  const definitions = [
    { name: "PRO1", model: "gpt-6.1-sol", reasoning: "low" },
    { name: "PRO2", model: "gpt-6.1-terra", reasoning: "low" },
    { name: "PRO3", model: "claude-opus-4.5", reasoning: "high" }
  ];

  const groups = config.groups.map((group, index) => ({
    id: group.id,
    name: definitions[index]?.name || group.name,
    baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}`,
    apiKey: `sk-demo-${index + 1}`,
    model: definitions[index]?.model || group.model,
    reasoning: definitions[index]?.reasoning || "",
    protocol: "/v1/chat/completions",
    enabled: true
  }));

  await fetch(`${BASE}/api/admin/groups`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ groups })
  });

  await fetch(`${BASE}/api/admin/schedule`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ cron: "*/30 * * * *", enabled: true })
  });

  for (let roundIndex = 0; roundIndex < 2; roundIndex += 1) {
    await fetch(`${BASE}/api/admin/run`, { method: "POST", headers });

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const state = await (await fetch(`${BASE}/api/admin/config`, { headers })).json();

      if (!state.schedule.running) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  console.log(`\n演示已就绪：\n  看板 ${BASE}/\n  后台 ${BASE}/admin/  （密码 ${PASSWORD}）\n按 Ctrl+C 退出。\n`);

  const shutdown = async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => stub.close(resolve));
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  child.on("exit", async (code) => {
    await new Promise((resolve) => stub.close(resolve));
    process.exit(code ?? 0);
  });
}

void main();
