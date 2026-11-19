const BASE = window.__CHECK_BASE_PATH__ === "/" ? "" : window.__CHECK_BASE_PATH__;

const state = {
  password: sessionStorage.getItem("checkAdminPassword") || "",
  config: null,
  tab: sessionStorage.getItem("checkAdminTab") || "schedule",
  records: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
  pollTimer: null,
  cronPreviewTimer: null
};

const elements = {
  loginPanel: document.querySelector("#loginPanel"),
  passwordInput: document.querySelector("#passwordInput"),
  loginButton: document.querySelector("#loginButton"),
  message: document.querySelector("#message"),
  adminTabs: document.querySelector("#adminTabs"),
  tabButtons: [...document.querySelectorAll(".tab-button")],
  tabPanels: [...document.querySelectorAll(".tab-page")],

  scheduleStateText: document.querySelector("#scheduleStateText"),
  cronInput: document.querySelector("#cronInput"),
  cronEnabledInput: document.querySelector("#cronEnabledInput"),
  cronDescribeText: document.querySelector("#cronDescribeText"),
  cronTimezoneText: document.querySelector("#cronTimezoneText"),
  cronNextText: document.querySelector("#cronNextText"),
  cronLastText: document.querySelector("#cronLastText"),
  saveScheduleButton: document.querySelector("#saveScheduleButton"),
  runNowButton: document.querySelector("#runNowButton"),

  questionRows: document.querySelector("#questionRows"),
  systemPromptInput: document.querySelector("#systemPromptInput"),
  savePromptButton: document.querySelector("#savePromptButton"),
  resetPromptButton: document.querySelector("#resetPromptButton"),
  addQuestionButton: document.querySelector("#addQuestionButton"),
  reloadQuestionsButton: document.querySelector("#reloadQuestionsButton"),
  saveQuestionsButton: document.querySelector("#saveQuestionsButton"),

  groupRows: document.querySelector("#groupRows"),
  addGroupButton: document.querySelector("#addGroupButton"),
  reloadGroupsButton: document.querySelector("#reloadGroupsButton"),
  saveGroupsButton: document.querySelector("#saveGroupsButton"),

  recordsMetaText: document.querySelector("#recordsMetaText"),
  recordSearchInput: document.querySelector("#recordSearchInput"),
  recordGroupFilter: document.querySelector("#recordGroupFilter"),
  recordQuestionFilter: document.querySelector("#recordQuestionFilter"),
  recordStatusFilter: document.querySelector("#recordStatusFilter"),
  recordPageSize: document.querySelector("#recordPageSize"),
  recordList: document.querySelector("#recordList"),
  recordPager: document.querySelector("#recordPager"),

  systemRefreshText: document.querySelector("#systemRefreshText"),
  systemGrid: document.querySelector("#systemGrid"),
  roundList: document.querySelector("#roundList"),
  reloadSystemButton: document.querySelector("#reloadSystemButton")
};

boot();

function boot() {
  elements.passwordInput.value = state.password;
  elements.loginButton.addEventListener("click", () => void login());
  elements.passwordInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      void login();
    }
  });

  for (const button of elements.tabButtons) {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  }

  elements.saveScheduleButton.addEventListener("click", () => void saveSchedule());
  elements.runNowButton.addEventListener("click", () => void runNow());
  elements.cronInput.addEventListener("input", () => previewCron());
  elements.cronEnabledInput.addEventListener("change", () => previewCron());

  elements.addQuestionButton.addEventListener("click", () => {
    addQuestionRow({
      id: `question-${Date.now()}`,
      title: "新题目",
      note: "",
      prompt: "",
      enabled: true
    });
  });
  elements.reloadQuestionsButton.addEventListener("click", () => void loadConfig());
  elements.saveQuestionsButton.addEventListener("click", () => void saveQuestions());
  elements.savePromptButton.addEventListener("click", () => void saveSystemPrompt());
  elements.resetPromptButton.addEventListener("click", () => {
    elements.systemPromptInput.value = state.config?.defaultSystemPrompt || "";
    showMessage("已填入默认前置提示，记得点「保存前置提示」。", "success");
  });

  elements.addGroupButton.addEventListener("click", () => {
    addGroupRow({
      id: `group-${Date.now()}`,
      name: `PRO${elements.groupRows.children.length + 1}`,
      baseUrl: "",
      apiKey: "",
      apiKeyMasked: "",
      hasApiKey: false,
      model: "",
      reasoning: "",
      protocol: "/v1/chat/completions",
      enabled: true
    });
  });
  elements.reloadGroupsButton.addEventListener("click", () => void loadConfig());
  elements.saveGroupsButton.addEventListener("click", () => void saveGroups());

  elements.recordSearchInput.addEventListener("input", debounce(() => {
    state.records.page = 1;
    void loadRecords();
  }, 320));
  elements.recordGroupFilter.addEventListener("change", () => {
    state.records.page = 1;
    void loadRecords();
  });
  elements.recordQuestionFilter.addEventListener("change", () => {
    state.records.page = 1;
    void loadRecords();
  });
  elements.recordStatusFilter.addEventListener("change", () => {
    state.records.page = 1;
    void loadRecords();
  });
  elements.recordPageSize.addEventListener("change", () => {
    state.records.pageSize = Number(elements.recordPageSize.value) || 20;
    state.records.page = 1;
    void loadRecords();
  });
  elements.reloadSystemButton.addEventListener("click", () => void loadConfig());

  if (state.password) {
    void loadConfig();
  }
}

async function login() {
  state.password = elements.passwordInput.value.trim();
  sessionStorage.setItem("checkAdminPassword", state.password);
  await loadConfig();
}

async function loadConfig(options = {}) {
  try {
    const data = await adminFetch("/api/admin/config");
    state.config = data;
    renderAll(data);

    if (!options.quiet) {
      showMessage("配置已加载。", "success");
    }

    if (data.schedule.running) {
      scheduleRefresh();
    }

    await loadRecords();
  } catch (error) {
    if (error.status === 401) {
      elements.loginPanel.hidden = false;
      elements.adminTabs.hidden = true;
      hidePanels();
    }

    showMessage(error.message, "error");
  }
}

function renderAll(config) {
  elements.loginPanel.hidden = true;
  elements.adminTabs.hidden = false;
  renderSchedule(config);
  renderSystemPrompt(config);
  renderQuestions(config.questions);
  renderGroups(config.groups);
  renderFilters(config);
  renderSystem(config);
  activateTab(state.tab);
}

function renderSystemPrompt(config) {
  elements.systemPromptInput.value = config.systemPrompt || "";
  elements.systemPromptInput.placeholder = config.defaultSystemPrompt || "";
}

async function saveSystemPrompt() {
  elements.savePromptButton.disabled = true;

  try {
    const data = await adminFetch("/api/admin/prompt", {
      method: "PUT",
      body: { systemPrompt: elements.systemPromptInput.value }
    });

    state.config = data;
    renderSystemPrompt(data);
    showMessage("前置提示已保存，下一轮生效。", "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    elements.savePromptButton.disabled = false;
  }
}

function hidePanels() {
  for (const panel of elements.tabPanels) {
    panel.hidden = true;
  }
}

// ---------- 定时任务 ----------

function renderSchedule(config) {
  const schedule = config.schedule;

  elements.cronInput.value = schedule.expression;
  elements.cronEnabledInput.checked = Boolean(schedule.enabled);
  elements.cronTimezoneText.textContent = config.timezone;
  elements.cronLastText.textContent = schedule.lastRunAtLabel || "-";

  elements.scheduleStateText.textContent = schedule.running
    ? "正在检测中…"
    : schedule.enabled
      ? "已启用"
      : "已停用";
  elements.runNowButton.disabled = Boolean(schedule.running);
  elements.runNowButton.textContent = schedule.running ? "正在检测…" : "立即检测一轮";

  previewCron({ describe: schedule.describe, next: schedule.previewNextRunAt });
}

async function previewCron(seed) {
  clearTimeout(state.cronPreviewTimer);

  if (seed?.describe) {
    elements.cronDescribeText.textContent = seed.describe;
    elements.cronNextText.textContent = seed.next?.label || "-";
    return;
  }

  const cron = elements.cronInput.value.trim();

  state.cronPreviewTimer = setTimeout(async () => {
    try {
      const data = await adminFetch(`/api/admin/cron-preview?cron=${encodeURIComponent(cron)}`);
      elements.cronDescribeText.textContent = data.describe;
      elements.cronNextText.textContent = elements.cronEnabledInput.checked
        ? data.nextLabel || "-"
        : "已停用";
      elements.cronDescribeText.style.color = data.valid ? "" : "var(--red)";
    } catch (error) {
      elements.cronDescribeText.textContent = error.message;
    }
  }, 260);
}

async function saveSchedule() {
  elements.saveScheduleButton.disabled = true;

  try {
    const data = await adminFetch("/api/admin/schedule", {
      method: "PUT",
      body: {
        cron: elements.cronInput.value.trim(),
        enabled: elements.cronEnabledInput.checked
      }
    });

    state.config = data;
    renderSchedule(data);
    showMessage("定时设置已保存。", "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    elements.saveScheduleButton.disabled = false;
  }
}

async function runNow() {
  elements.runNowButton.disabled = true;
  elements.runNowButton.textContent = "正在检测…";

  try {
    const data = await adminFetch("/api/admin/run", { method: "POST" });

    showMessage(`已开始本轮检测，共 ${data.totalCount} 个任务。`, "success");
    state.config = data.config;
    renderAll(data.config);
    scheduleRefresh();
  } catch (error) {
    showMessage(error.message, "error");
    elements.runNowButton.disabled = false;
    elements.runNowButton.textContent = "立即检测一轮";
  }
}

// 轮次跑完后自动刷新一次配置与记录。
function scheduleRefresh() {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(async () => {
    try {
      const config = await adminFetch("/api/admin/config");

      state.config = config;
      renderAll(config);
      await loadRecords();

      if (config.schedule.running) {
        scheduleRefresh();
      } else {
        showMessage("本轮检测已完成。", "success");
      }
    } catch {
      // 忽略轮询失败，下一次手动刷新会重新同步。
    }
  }, 2500);
}

// ---------- 检测题目 ----------

function renderQuestions(questions) {
  elements.questionRows.textContent = "";

  if (!Array.isArray(questions) || questions.length === 0) {
    elements.questionRows.append(createEmpty("还没有检测题目，点「新增题目」开始。"));
    return;
  }

  for (const question of questions) {
    addQuestionRow(question);
  }
}

function addQuestionRow(question) {
  const row = document.createElement("article");

  row.className = "edit-row";
  row.dataset.questionId = question.id || "";
  row.innerHTML = `
    <div class="edit-row-head">
      <label>
        <input class="q-enabled" type="checkbox" ${question.enabled ? "checked" : ""} />
        <span>启用</span>
      </label>
      <button class="remove-row" type="button" aria-label="删除题目">×</button>
    </div>
    <div class="row-fields cols-3">
      <label class="field">
        <span>题目名称</span>
        <input class="q-title" type="text" maxlength="80" value="${escapeAttr(question.title)}" placeholder="狐狸骑骆驼" />
      </label>
      <label class="field">
        <span>变体备注（可空，显示为「名称 · 备注」）</span>
        <input class="q-note" type="text" maxlength="24" value="${escapeAttr(question.note)}" placeholder="low" />
      </label>
    </div>
    <label class="field">
      <span>提示词</span>
      <textarea class="q-prompt" rows="4" maxlength="20000" placeholder="创建一个HTML，内容是…">${escapeHtml(question.prompt)}</textarea>
    </label>
  `;

  row.querySelector(".remove-row").addEventListener("click", () => {
    row.remove();

    if (elements.questionRows.querySelectorAll(".edit-row").length === 0) {
      elements.questionRows.append(createEmpty("还没有检测题目，点「新增题目」开始。"));
    }
  });

  clearEmpty(elements.questionRows);
  elements.questionRows.append(row);
}

function readQuestions() {
  return [...elements.questionRows.querySelectorAll(".edit-row")].map((row, index) => ({
    id: row.dataset.questionId || `question-${index + 1}`,
    title: row.querySelector(".q-title").value.trim(),
    note: row.querySelector(".q-note").value.trim(),
    prompt: row.querySelector(".q-prompt").value.trim(),
    enabled: row.querySelector(".q-enabled").checked
  }));
}

async function saveQuestions() {
  elements.saveQuestionsButton.disabled = true;

  try {
    const data = await adminFetch("/api/admin/questions", {
      method: "PUT",
      body: { questions: readQuestions() }
    });

    state.config = data;
    renderQuestions(data.questions);
    renderFilters(data);
    showMessage("题目已保存。", "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    elements.saveQuestionsButton.disabled = false;
  }
}

// ---------- 测试分组 ----------

function renderGroups(groups) {
  elements.groupRows.textContent = "";

  if (!Array.isArray(groups) || groups.length === 0) {
    elements.groupRows.append(createEmpty("还没有测试分组，点「新增分组」开始。"));
    return;
  }

  for (const group of groups) {
    addGroupRow(group);
  }
}

function addGroupRow(group) {
  const row = document.createElement("article");
  const keyHint = group.hasApiKey
    ? `已保存：${group.apiKeyMasked}（留空保持不变）`
    : "还没有保存 API Key。";

  row.className = "edit-row";
  row.dataset.groupId = group.id || "";
  row.dataset.hasKey = group.hasApiKey ? "1" : "0";
  row.innerHTML = `
    <div class="edit-row-head">
      <label>
        <input class="g-enabled" type="checkbox" ${group.enabled ? "checked" : ""} />
        <span>启用</span>
      </label>
      <button class="remove-row" type="button" aria-label="删除分组">×</button>
    </div>
    <div class="row-fields cols-3">
      <label class="field">
        <span>分组名称</span>
        <input class="g-name" type="text" maxlength="40" value="${escapeAttr(group.name)}" placeholder="PRO1" />
      </label>
      <label class="field">
        <span>模型</span>
        <input class="g-model" type="text" maxlength="120" value="${escapeAttr(group.model)}" placeholder="gpt-6.1-sol" />
      </label>
      <label class="field">
        <span>推理档位（可空，同时作为 reasoning_effort）</span>
        <input class="g-reasoning" type="text" maxlength="24" value="${escapeAttr(group.reasoning)}" placeholder="low" />
      </label>
    </div>
    <div class="row-fields cols-2">
      <label class="field">
        <span>API 地址</span>
        <input class="g-url" type="text" maxlength="400" value="${escapeAttr(group.baseUrl)}" placeholder="https://api.example.com" spellcheck="false" />
      </label>
      <label class="field">
        <span>协议路径</span>
        <input class="g-protocol" type="text" maxlength="200" value="${escapeAttr(group.protocol || "/v1/chat/completions")}" placeholder="/v1/chat/completions" spellcheck="false" />
      </label>
    </div>
    <div class="key-cell">
      <label class="field">
        <span>API Key</span>
        <input class="g-key" type="password" autocomplete="new-password" value="" placeholder="${escapeAttr(keyHint)}" />
      </label>
      ${
        group.hasApiKey
          ? `<label class="key-clear"><input class="g-clear" type="checkbox" /><span>清除已保存的 API Key</span></label>`
          : ""
      }
      <p class="key-hint">Key 只存在服务端，页面只显示掩码；留空表示不修改。</p>
    </div>
  `;

  row.querySelector(".remove-row").addEventListener("click", () => {
    row.remove();

    if (elements.groupRows.querySelectorAll(".edit-row").length === 0) {
      elements.groupRows.append(createEmpty("还没有测试分组，点「新增分组」开始。"));
    }
  });

  clearEmpty(elements.groupRows);
  elements.groupRows.append(row);
}

function readGroups() {
  return [...elements.groupRows.querySelectorAll(".edit-row")].map((row, index) => {
    const keyInput = row.querySelector(".g-key");
    const clearInput = row.querySelector(".g-clear");
    const typed = keyInput.value.trim();
    const group = {
      id: row.dataset.groupId || `group-${index + 1}`,
      name: row.querySelector(".g-name").value.trim(),
      baseUrl: row.querySelector(".g-url").value.trim(),
      model: row.querySelector(".g-model").value.trim(),
      reasoning: row.querySelector(".g-reasoning").value.trim(),
      protocol: row.querySelector(".g-protocol").value.trim(),
      enabled: row.querySelector(".g-enabled").checked
    };

    if (clearInput?.checked) {
      group.apiKey = "";
    } else if (typed) {
      group.apiKey = typed;
    }

    return group;
  });
}

async function saveGroups() {
  elements.saveGroupsButton.disabled = true;

  try {
    const data = await adminFetch("/api/admin/groups", {
      method: "PUT",
      body: { groups: readGroups() }
    });

    state.config = data;
    renderGroups(data.groups);
    renderFilters(data);
    showMessage("分组已保存。", "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    elements.saveGroupsButton.disabled = false;
  }
}

// ---------- 作品记录 ----------

function renderFilters(config) {
  fillOptions(
    elements.recordGroupFilter,
    [{ value: "", label: "全部分组" }, ...config.groups.map((group) => ({ value: group.id, label: group.name }))],
    elements.recordGroupFilter.value
  );
  fillOptions(
    elements.recordQuestionFilter,
    [
      { value: "", label: "全部题目" },
      ...config.questions.map((question) => ({
        value: question.id,
        label: question.note ? `${question.title} · ${question.note}` : question.title
      }))
    ],
    elements.recordQuestionFilter.value
  );
}

function fillOptions(select, options, current) {
  const signature = JSON.stringify(options.map((option) => [option.value, option.label]));

  if (select.dataset.signature === signature) {
    select.value = options.some((option) => option.value === current) ? current : "";
    return;
  }

  select.textContent = "";

  for (const option of options) {
    const item = document.createElement("option");
    item.value = option.value;
    item.textContent = option.label;
    select.append(item);
  }

  select.dataset.signature = signature;
  select.value = options.some((option) => option.value === current) ? current : "";
}

async function loadRecords() {
  const params = new URLSearchParams({
    page: String(state.records.page),
    pageSize: String(state.records.pageSize)
  });
  const query = elements.recordSearchInput.value.trim();
  const groupId = elements.recordGroupFilter.value;
  const questionId = elements.recordQuestionFilter.value;
  const status = elements.recordStatusFilter.value;

  if (query) {
    params.set("q", query);
  }

  if (groupId) {
    params.set("groupId", groupId);
  }

  if (questionId) {
    params.set("questionId", questionId);
  }

  if (status) {
    params.set("status", status);
  }

  try {
    const data = await adminFetch(`/api/admin/records?${params.toString()}`);

    state.records.page = data.page;
    state.records.total = data.total;
    state.records.totalPages = data.totalPages;
    renderRecords(data);
  } catch (error) {
    elements.recordList.textContent = "";
    elements.recordList.append(createEmpty(error.message));
    elements.recordPager.textContent = "";
  }
}

function renderRecords(data) {
  elements.recordsMetaText.textContent =
    data.total > 0
      ? `共 ${data.total} 件作品 · 第 ${data.page} / ${data.totalPages} 页`
      : "暂无作品";

  elements.recordList.textContent = "";

  if (data.records.length === 0) {
    elements.recordList.append(createEmpty("没有匹配的作品记录。"));
    elements.recordPager.textContent = "";
    return;
  }

  for (const record of data.records) {
    elements.recordList.append(renderRecord(record));
  }

  renderRecordPager();
}

function renderRecord(record) {
  const details = document.createElement("details");
  const isOk = record.status === "ok" && record.charCount > 0;

  details.className = "record";
  details.innerHTML = `
    <summary>
      <span class="cell-time">${escapeHtml(record.createdAtLabel)}</span>
      <span class="cell-group">${escapeHtml(record.groupName || record.groupId)}</span>
      <span class="cell-question">${escapeHtml(
        record.questionNote ? `${record.questionTitle} · ${record.questionNote}` : record.questionTitle
      )}</span>
      <span class="cell-model">${escapeHtml(record.modelLabel || "-")}</span>
      <span class="record-status" data-tone="${isOk ? "ok" : "error"}">${isOk ? "成功" : "失败"}</span>
      <span class="cell-duration">${formatDuration(record.durationMs)}</span>
    </summary>
    <div class="record-body"></div>
  `;

  const body = details.querySelector(".record-body");

  if (isOk) {
    const frame = document.createElement("div");
    const iframe = document.createElement("iframe");

    frame.className = "record-frame";
    iframe.src = `${BASE}/api/artifact/${encodeURIComponent(record.id)}/html`;
    iframe.title = `${record.groupName} ${record.createdAtLabel}`;
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("loading", "lazy");
    frame.append(iframe);
    body.append(frame);
  } else {
    const error = document.createElement("p");

    error.className = "record-error";
    error.textContent = record.error || "本次调用失败";
    body.append(error);
  }

  const promptBlock = document.createElement("details");

  promptBlock.className = "record-block";
  promptBlock.innerHTML = "<summary>本次实际提示词</summary><pre>展开后加载…</pre>";
  body.append(promptBlock);

  const actions = document.createElement("div");
  const openLink = document.createElement("a");
  const deleteButton = document.createElement("button");

  actions.className = "record-actions";
  openLink.href = `${BASE}/api/artifact/${encodeURIComponent(record.id)}/html`;
  openLink.target = "_blank";
  openLink.rel = "noreferrer";
  openLink.textContent = "新窗口打开";
  deleteButton.type = "button";
  deleteButton.className = "secondary";
  deleteButton.textContent = "删除";
  deleteButton.addEventListener("click", () => void deleteRecord(record.id));
  actions.append(openLink, deleteButton);
  body.append(actions);

  details.addEventListener("toggle", () => {
    if (!details.open || promptBlock.dataset.loaded === "1") {
      return;
    }

    promptBlock.dataset.loaded = "1";
    void adminFetch(`/api/admin/artifacts/${encodeURIComponent(record.id)}`)
      .then((payload) => {
        promptBlock.querySelector("pre").textContent = payload.artifact.prompt || "（没有记录提示词）";
      })
      .catch((error) => {
        promptBlock.querySelector("pre").textContent = error.message;
      });
  });

  return details;
}

async function deleteRecord(id) {
  if (!window.confirm("删除后该作品无法恢复，确定删除？")) {
    return;
  }

  try {
    const data = await adminFetch(`/api/admin/artifacts/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });

    state.records.page = data.records.page;
    renderRecords(data.records);
    showMessage("作品已删除。", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
}

function renderRecordPager() {
  const { page, totalPages } = state.records;

  elements.recordPager.textContent = "";

  if (totalPages <= 1) {
    return;
  }

  elements.recordPager.append(createPagerButton("‹", page <= 1, () => {
    state.records.page = page - 1;
    void loadRecords();
  }));

  for (const item of pageWindow(page, totalPages)) {
    if (item === "…") {
      const gap = document.createElement("span");
      gap.textContent = "…";
      elements.recordPager.append(gap);
      continue;
    }

    const button = createPagerButton(String(item), false, () => {
      state.records.page = item;
      void loadRecords();
    });

    button.classList.toggle("is-current", item === page);
    elements.recordPager.append(button);
  }

  elements.recordPager.append(createPagerButton("›", page >= totalPages, () => {
    state.records.page = page + 1;
    void loadRecords();
  }));
}

// ---------- 系统信息 ----------

function renderSystem(config) {
  const system = config.system;
  const stats = config.stats;

  elements.systemRefreshText.textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;

  const items = [
    ["数据库", system.dbFile],
    ["时区", system.timezone],
    ["监听端口", String(system.port)],
    ["公开路径", system.basePath],
    ["单次超时", `${system.requestTimeoutSeconds} 秒`],
    ["并发数", String(system.concurrency)],
    ["作品最大字符", String(system.maxOutputChars)],
    ["reasoning_effort", system.sendReasoningEffort ? "发送" : "不发送"],
    ["管理密码", system.adminConfigured ? "已配置" : "未配置"],
    ["Node", system.nodeVersion],
    ["运行时长", formatUptime(system.uptimeSeconds)],
    ["作品总数", String(stats.total)],
    ["启用题目 / 分组", `${stats.questionCount} / ${stats.groupCount}`],
    ["已配置分组", String(stats.configuredGroupCount)],
    ["成功 / 失败作品", `${stats.byStatus.ok || 0} / ${stats.byStatus.error || 0}`]
  ];

  elements.systemGrid.textContent = "";

  for (const [label, value] of items) {
    const item = document.createElement("article");

    item.className = "system-item";
    item.innerHTML = `<span>${escapeHtml(label)}</span><strong title="${escapeAttr(
      value || "-"
    )}">${escapeHtml(value || "-")}</strong>`;
    elements.systemGrid.append(item);
  }

  elements.roundList.textContent = "";

  if (config.rounds.length === 0) {
    elements.roundList.append(createEmpty("还没有执行过检测轮次。"));
    return;
  }

  for (const round of config.rounds) {
    const item = document.createElement("article");

    item.className = "round-item";
    item.innerHTML = `
      <span class="cell-time">${escapeHtml(round.startedAtLabel)}</span>
      <span class="round-status" data-tone="${round.status}">${escapeHtml(roundStatusText(round.status))}</span>
      <span>${escapeHtml(
        `${round.trigger === "cron" ? "定时" : "手动"} · 成功 ${round.okCount} / 失败 ${round.failedCount}${
          round.note ? ` · ${round.note}` : ""
        }`
      )}</span>
      <span class="cell-duration">${escapeHtml(round.finishedAtLabel || "进行中")}</span>
    `;
    elements.roundList.append(item);
  }
}

function roundStatusText(status) {
  switch (status) {
    case "done":
      return "完成";
    case "partial":
      return "部分失败";
    case "error":
      return "失败";
    case "running":
      return "进行中";
    default:
      return status;
  }
}

// ---------- 通用 ----------

async function adminFetch(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Check-Admin-Password": state.password
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.message || `请求失败（HTTP ${response.status}）`);

    error.status = response.status;
    throw error;
  }

  return payload;
}

function activateTab(tabName = "schedule") {
  const available = new Set(elements.tabButtons.map((button) => button.dataset.tab));
  const next = available.has(tabName) ? tabName : "schedule";

  state.tab = next;
  sessionStorage.setItem("checkAdminTab", next);

  for (const button of elements.tabButtons) {
    const active = button.dataset.tab === next;

    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  }

  for (const panel of elements.tabPanels) {
    panel.hidden = panel.dataset.panel !== next;
  }

  if (next === "records") {
    void loadRecords();
  }
}

function showMessage(text, tone = "info") {
  elements.message.textContent = text;
  elements.message.dataset.tone = tone;
}

function createEmpty(text) {
  const paragraph = document.createElement("p");

  paragraph.className = "empty";
  paragraph.textContent = text;
  return paragraph;
}

function clearEmpty(container) {
  for (const empty of container.querySelectorAll(":scope > .empty")) {
    empty.remove();
  }
}

function createPagerButton(label, disabled, onClick) {
  const button = document.createElement("button");

  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function pageWindow(current, totalPages) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (unused, index) => index + 1);
  }

  const pages = new Set([1, totalPages, current, current - 1, current + 1]);
  const sorted = [...pages].filter((page) => page >= 1 && page <= totalPages).sort((a, b) => a - b);
  const result = [];

  for (const [index, page] of sorted.entries()) {
    if (index > 0 && page - sorted[index - 1] > 1) {
      result.push("…");
    }

    result.push(page);
  }

  return result;
}

function debounce(fn, delay) {
  let timer = null;

  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function formatDuration(durationMs) {
  const value = Number(durationMs) || 0;

  if (value <= 0) {
    return "-";
  }

  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

function formatUptime(seconds) {
  const value = Number(seconds) || 0;
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);

  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分`;
  }

  return `${minutes} 分 ${value % 60} 秒`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
