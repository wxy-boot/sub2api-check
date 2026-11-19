function basePathOf(config) {
  return config.publicBasePath === "/" ? "" : config.publicBasePath;
}

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%232f6fed'/%3E%3Cpath d='M10 22l6-12 6 12' fill='none' stroke='%23fff' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

export function renderIndex(config) {
  const base = basePathOf(config);

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${escapeHtml(config.title)}</title>
    <link rel="icon" href="${FAVICON}" />
    <link rel="stylesheet" href="${base}/styles.css" />
    <script>window.__CHECK_BASE_PATH__ = ${JSON.stringify(config.publicBasePath)};</script>
    <script type="module" src="${base}/app.js"></script>
  </head>
  <body>
    <main class="shell">
      <header class="page-head">
        <div class="head-copy">
          <h1>${escapeHtml(config.title)}</h1>
          <p class="summary">${escapeHtml(config.subtitle)}</p>
        </div>
        <button class="ghost-button" id="refreshButton" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.34 5.66" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            <path d="M20 5v6h-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>刷新结果</span>
        </button>
      </header>

      <section class="panel exam-panel">
        <div class="exam-top">
          <span class="exam-label">固定试题</span>
          <span class="run-badge" id="runBadge" data-state="idle">
            <i class="dot" aria-hidden="true"></i>
            <span id="runBadgeText">正在读取定时状态…</span>
          </span>
        </div>
        <p class="exam-prompt" id="examPrompt">正在读取试题…</p>
        <div class="exam-meta">
          <span id="cronText">-</span>
          <span id="lastRunText">最近 -</span>
          <span id="nextRunText">下次检测 -</span>
        </div>
      </section>

      <section class="records">
        <header class="records-head">
          <div class="records-title">
            <h2>作品记录</h2>
            <p class="records-sub">各分组作品按实际时间排列，当前检测状态会单独标明。</p>
          </div>
          <div class="filters">
            <label class="filter-field" for="questionSelect">
              <span>检测题目</span>
              <select id="questionSelect"></select>
            </label>
            <label class="filter-field is-plain" for="groupSelect">
              <span class="visually-hidden">分组</span>
              <select id="groupSelect"></select>
            </label>
          </div>
        </header>

        <div class="board" id="board">
          <p class="empty">正在读取作品记录…</p>
        </div>
        <div class="board-pager" id="boardPager"></div>
      </section>

      <footer class="page-foot">
        <span id="footNote">数据来自各分组真实调用，作品由模型实时生成。</span>
      </footer>
    </main>

    <div class="preview-modal" id="previewModal" hidden>
      <div class="preview-backdrop" data-close-preview></div>
      <section class="preview-card" role="dialog" aria-modal="true" aria-labelledby="previewTitle">
        <header class="preview-head">
          <div>
            <p class="preview-eyebrow" id="previewEyebrow">作品预览</p>
            <h2 id="previewTitle">-</h2>
          </div>
          <div class="preview-head-actions">
            <span class="preview-meta" id="previewMeta"></span>
            <button class="ghost-button" id="previewCloseButton" type="button">关闭</button>
          </div>
        </header>
        <div class="preview-body" id="previewBody"></div>
      </section>
    </div>
  </body>
</html>`;
}

export function renderAdmin(config) {
  const base = basePathOf(config);

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${escapeHtml(config.title)} · 管理后台</title>
    <link rel="icon" href="${FAVICON}" />
    <link rel="stylesheet" href="${base}/admin.css" />
    <script>window.__CHECK_BASE_PATH__ = ${JSON.stringify(config.publicBasePath)};</script>
    <script type="module" src="${base}/admin.js"></script>
  </head>
  <body>
    <main class="admin-shell">
      <header class="page-head hero">
        <div>
          <p class="eyebrow">Model IQ Check</p>
          <h1>${escapeHtml(config.title)} · 管理后台</h1>
          <p class="summary">配置定时任务、检测题目与测试分组，并查看每轮作品记录。</p>
        </div>
        <div class="head-actions">
          <span class="pill">SQLite · 零依赖</span>
          <a class="ghost-button" href="${base}/">打开看板</a>
        </div>
      </header>

      <section class="panel login-panel" id="loginPanel">
        <label for="passwordInput">管理密码</label>
        <div class="login-row">
          <input id="passwordInput" type="password" autocomplete="current-password" placeholder="CHECK_ADMIN_PASSWORD" />
          <button id="loginButton" type="button">进入后台</button>
        </div>
        <p class="hint">分组 API Key 只保存在服务端，页面只显示掩码。</p>
      </section>

      <p class="message" id="message"></p>

      <nav class="admin-tabs" id="adminTabs" aria-label="管理端导航" hidden>
        <button class="tab-button" type="button" data-tab="schedule">定时任务</button>
        <button class="tab-button" type="button" data-tab="questions">检测题目</button>
        <button class="tab-button" type="button" data-tab="groups">测试分组</button>
        <button class="tab-button" type="button" data-tab="records">作品记录</button>
        <button class="tab-button" type="button" data-tab="system">系统信息</button>
      </nav>

      <section class="panel tab-page" id="schedulePanel" data-panel="schedule" hidden>
        <div class="panel-head">
          <div>
            <p class="eyebrow">Schedule</p>
            <h2>定时检测</h2>
          </div>
          <span class="panel-note" id="scheduleStateText">-</span>
        </div>

        <div class="form-grid">
          <label class="field-card" for="cronInput">
            <span>Cron 表达式</span>
            <input id="cronInput" type="text" spellcheck="false" placeholder="*/30 * * * *" />
            <small>5 段：分 时 日 月 周，按服务端时区解释，例如 <code>*/30 * * * *</code>（每 30 分钟）、<code>0 9 * * 1-5</code>（工作日 9:00）。</small>
          </label>
          <label class="toggle-card" for="cronEnabledInput">
            <span>启用定时检测</span>
            <input id="cronEnabledInput" type="checkbox" />
            <small>关闭后只能手动点“立即检测一轮”。</small>
          </label>
        </div>

        <div class="schedule-preview" id="schedulePreview">
          <div><span>解析结果</span><strong id="cronDescribeText">-</strong></div>
          <div><span>时区</span><strong id="cronTimezoneText">-</strong></div>
          <div><span>下一次执行</span><strong id="cronNextText">-</strong></div>
          <div><span>最近一次完成</span><strong id="cronLastText">-</strong></div>
        </div>

        <div class="actions">
          <button class="secondary" id="runNowButton" type="button">立即检测一轮</button>
          <button class="primary" id="saveScheduleButton" type="button">保存定时设置</button>
        </div>
      </section>

      <section class="panel tab-page" id="questionsPanel" data-panel="questions" hidden>
        <div class="panel-head">
          <div>
            <p class="eyebrow">Questions</p>
            <h2>检测题目</h2>
          </div>
          <div class="head-tools">
            <button class="secondary" id="reloadQuestionsButton" type="button">重新加载</button>
            <button id="addQuestionButton" type="button">新增题目</button>
          </div>
        </div>
        <p class="hint">每轮会把所有启用题目 × 所有启用分组各跑一次，题目越多样品越多。</p>

        <div class="question-rows" id="questionRows"></div>
        <div class="actions">
          <button class="primary" id="saveQuestionsButton" type="button">保存题目</button>
        </div>
      </section>

      <section class="panel tab-page" id="groupsPanel" data-panel="groups" hidden>
        <div class="panel-head">
          <div>
            <p class="eyebrow">Groups</p>
            <h2>测试分组</h2>
          </div>
          <div class="head-tools">
            <button class="secondary" id="reloadGroupsButton" type="button">重新加载</button>
            <button id="addGroupButton" type="button">新增分组</button>
          </div>
        </div>
        <p class="hint">
          协议固定按 OpenAI Chat Completions 调用：<code>{URL}{协议}</code>，请求头带 <code>Authorization: Bearer {API Key}</code>。
          URL 填 <code>https://host</code> 或 <code>https://host/v1</code> 都可以。每组右侧的「检测此分组」只跑该分组；
          用 <code>↑</code> <code>↓</code> 调整顺序，保存后看板的列顺序会跟着变。
        </p>
        <div class="group-rows" id="groupRows"></div>
        <div class="actions">
          <button class="primary" id="saveGroupsButton" type="button">保存分组</button>
        </div>
      </section>

      <section class="panel tab-page" id="recordsPanel" data-panel="records" hidden>
        <div class="panel-head">
          <div>
            <p class="eyebrow">Artifacts</p>
            <h2>作品记录</h2>
          </div>
          <span class="panel-note" id="recordsMetaText">-</span>
        </div>
        <div class="toolbar">
          <input id="recordSearchInput" type="search" placeholder="搜索分组、题目、模型或错误" />
          <select id="recordGroupFilter"></select>
          <select id="recordQuestionFilter"></select>
          <select id="recordStatusFilter">
            <option value="">全部状态</option>
            <option value="ok">成功</option>
            <option value="error">失败</option>
          </select>
          <select id="recordPageSize">
            <option value="10">每页 10 条</option>
            <option value="20" selected>每页 20 条</option>
            <option value="50">每页 50 条</option>
          </select>
        </div>
        <div class="record-list" id="recordList"></div>
        <div class="pager" id="recordPager"></div>
      </section>

      <section class="panel tab-page" id="systemPanel" data-panel="system" hidden>
        <div class="panel-head">
          <div>
            <p class="eyebrow">Runtime</p>
            <h2>系统信息</h2>
          </div>
          <span class="panel-note" id="systemRefreshText">-</span>
        </div>
        <div class="system-grid" id="systemGrid"></div>
        <div class="panel-head sub-head">
          <div>
            <p class="eyebrow">Rounds</p>
            <h2>最近轮次</h2>
          </div>
        </div>
        <div class="round-list" id="roundList"></div>
        <div class="actions">
          <button class="secondary" id="reloadSystemButton" type="button">刷新信息</button>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
