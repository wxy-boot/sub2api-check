const BASE = window.__CHECK_BASE_PATH__ === "/" ? "" : window.__CHECK_BASE_PATH__;

const state = {
  board: null,
  questionId: "",
  groupId: "",
  page: 1,
  // 0 表示沿用服务端的 board_page_size，用户手动改过之后才下传。
  pageSize: 0,
  loading: false,
  pollTimer: null
};

const elements = {
  refreshButton: document.querySelector("#refreshButton"),
  board: document.querySelector("#board"),
  boardPager: document.querySelector("#boardPager"),
  questionSelect: document.querySelector("#questionSelect"),
  groupSelect: document.querySelector("#groupSelect"),
  examPrompt: document.querySelector("#examPrompt"),
  examMeta: Array.from(document.querySelectorAll(".exam-meta span")),
  cronText: document.querySelector("#cronText"),
  lastRunText: document.querySelector("#lastRunText"),
  nextRunText: document.querySelector("#nextRunText"),
  runBadge: document.querySelector("#runBadge"),
  runBadgeText: document.querySelector("#runBadgeText"),
  previewModal: document.querySelector("#previewModal"),
  previewTitle: document.querySelector("#previewTitle"),
  previewEyebrow: document.querySelector("#previewEyebrow"),
  previewMeta: document.querySelector("#previewMeta"),
  previewBody: document.querySelector("#previewBody"),
  previewCloseButton: document.querySelector("#previewCloseButton")
};

boot();

function boot() {
  elements.refreshButton.addEventListener("click", () => void load({ manual: true }));
  elements.questionSelect.addEventListener("change", () => {
    state.questionId = elements.questionSelect.value;
    state.page = 1;
    void load();
  });
  elements.groupSelect.addEventListener("change", () => {
    state.groupId = elements.groupSelect.value;
    state.page = 1;
    void load();
  });
  elements.previewCloseButton.addEventListener("click", closePreview);
  elements.previewModal.querySelector("[data-close-preview]").addEventListener("click", closePreview);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.previewModal.hidden) {
      closePreview();
    }
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitFrames, 120);
  });

  void load();
}

async function load(options = {}) {
  if (state.loading) {
    return;
  }

  state.loading = true;
  clearTimeout(state.pollTimer);

  if (options.manual) {
    elements.refreshButton.classList.add("is-spinning");
    elements.refreshButton.disabled = true;
  }

  try {
    const params = new URLSearchParams();

    if (state.questionId) {
      params.set("questionId", state.questionId);
    }

    if (state.groupId) {
      params.set("groupId", state.groupId);
    }

    params.set("page", String(state.page));

    if (state.pageSize > 0) {
      params.set("pageSize", String(state.pageSize));
    }

    const response = await fetch(`${BASE}/api/board?${params.toString()}`, {
      headers: { Accept: "application/json" }
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload.ok === false) {
      throw new Error(payload.message || "看板数据读取失败");
    }

    state.board = payload;
    state.questionId = payload.selected.questionId || "";
    state.groupId = payload.selected.groupId || "";
    state.page = payload.paging.page || 1;
    state.pageSize = payload.paging.pageSize || 0;
    render();
  } catch (error) {
    renderError(error.message);
  } finally {
    state.loading = false;
    elements.refreshButton.classList.remove("is-spinning");
    elements.refreshButton.disabled = false;
  }
}

function schedulePoll() {
  clearTimeout(state.pollTimer);

  if (!state.board?.schedule?.running) {
    return;
  }

  state.pollTimer = setTimeout(() => void load(), 5000);
}

function render() {
  const board = state.board;

  renderExam(board);
  renderQuestionSelect(board);
  renderGroupSelect(board);
  renderBoard(board);
  schedulePoll();
}

function renderExam(board) {
  const question = board.question;

  elements.examPrompt.textContent = question?.prompt || "还没有启用的检测题目。";
  elements.cronText.textContent = board.schedule.describe;
  elements.lastRunText.textContent = board.schedule.lastRunAtLabel
    ? `最近 ${board.schedule.lastRunAtLabel}`
    : "最近 -";
  elements.nextRunText.textContent = board.schedule.enabled
    ? board.schedule.nextRunAtLabel
      ? `下次检测 ${board.schedule.nextRunAtLabel}`
      : "下次检测 -"
    : "定时检测已关闭";

  if (board.schedule.running) {
    setBadge("running", "正在检测中…");
  } else if (board.schedule.enabled) {
    setBadge("on", "定时检测已开启");
  } else {
    setBadge("off", "定时检测已关闭");
  }
}

function setBadge(tone, text) {
  elements.runBadge.dataset.state = tone;
  elements.runBadgeText.textContent = text;
}

function renderQuestionSelect(board) {
  const options = board.questions.map((question) => ({
    value: question.id,
    label: question.label
  }));

  fillSelect(elements.questionSelect, options, board.selected.questionId, "暂无题目");
}

function renderGroupSelect(board) {
  const options = [
    { value: "", label: "全部分组" },
    ...board.groups.map((group) => ({ value: group.id, label: group.name }))
  ];

  fillSelect(elements.groupSelect, options, board.selected.groupId, "全部分组");
}

function fillSelect(select, options, value, emptyLabel) {
  const signature = JSON.stringify(options.map((option) => [option.value, option.label]));

  if (select.dataset.signature !== signature) {
    select.textContent = "";

    if (options.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = emptyLabel;
      select.append(option);
    }

    for (const item of options) {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      select.append(option);
    }

    select.dataset.signature = signature;
  }

  select.value = value && options.some((option) => option.value === value) ? value : options[0]?.value || "";
}

function renderBoard(board) {
  elements.board.textContent = "";

  if (board.columns.length === 0) {
    elements.board.append(createEmpty("还没有配置检测分组，请先到后台添加分组。"));
    elements.boardPager.hidden = true;
    return;
  }

  for (const column of board.columns) {
    elements.board.append(renderColumn(column));
  }

  renderBoardPager(board.paging);
  fitFrames();
}

function renderColumn(column) {
  const article = document.createElement("article");
  const stateMeta = roundStateMeta(column.round);
  const header = document.createElement("header");

  article.className = "group-column";
  header.className = "column-head";
  header.innerHTML = `
    <div class="column-title">
      <h3>${escapeHtml(column.group.name)}</h3>
      <span class="column-state" data-tone="${stateMeta.tone}">${escapeHtml(stateMeta.badge)}</span>
    </div>
    ${stateMeta.note ? `<p class="column-note">${escapeHtml(stateMeta.note)}</p>` : ""}
    ${stateMeta.error ? `<p class="column-note is-error">${escapeHtml(stateMeta.error)}</p>` : ""}
    ${
      column.round.startedAtLabel
        ? `<p class="column-note">本轮检测：${escapeHtml(column.round.startedAtLabel)}</p>`
        : ""
    }
  `;
  article.append(header);

  const body = document.createElement("div");

  body.className = "column-body";

  if (column.artifacts.length === 0) {
    body.append(createEmpty(`「${column.group.name}」还没有作品，等待下一轮检测。`));
  } else {
    for (const artifact of column.artifacts) {
      body.append(renderArtifact(artifact, column));
    }
  }

  article.append(body);
  article.append(renderColumnFoot(column));

  return article;
}

function roundStateMeta(round) {
  switch (round.state) {
    case "ok":
      return { tone: "ok", badge: "已更新", note: "", error: "" };
    case "running":
      return { tone: "running", badge: "检测中", note: "本轮正在生成，作品完成后自动刷新。", error: "" };
    case "error":
      return {
        tone: "error",
        badge: "本轮失败",
        note: "本轮生成失败，保留上次作品。",
        error: round.error || ""
      };
    case "missing":
      return { tone: "idle", badge: "无新作品", note: "本轮作品暂未展示，保留上次作品。", error: "" };
    default:
      return { tone: "idle", badge: "未检测", note: "还没有跑过检测，可到后台点「立即检测一轮」。", error: "" };
  }
}

function renderArtifact(artifact, column) {
  const wrapper = document.createElement("div");
  const scaleLabel = column.group.label || artifact.modelLabel || "";

  wrapper.className = "artifact";
  wrapper.innerHTML = `
    <div class="artifact-time">${escapeHtml(artifact.createdAtLabel)}</div>
  `;

  const frame = document.createElement("div");

  frame.className = "frame";

  if (artifact.status === "ok" && artifact.charCount > 0) {
    const iframe = document.createElement("iframe");
    iframe.src = `${BASE}/api/artifact/${encodeURIComponent(artifact.id)}/html`;
    iframe.title = `${column.group.name} ${artifact.createdAtLabel} 作品`;
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("loading", "lazy");
    iframe.setAttribute("scrolling", "no");
    frame.append(iframe);
    frame.dataset.frame = "1";
    frame.title = "点击放大预览";
    frame.addEventListener("click", () => void openPreview(artifact));
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = `frame-placeholder${artifact.status === "error" ? " is-error" : ""}`;
    placeholder.textContent =
      artifact.status === "error" ? `${artifact.error || "本次调用失败"}` : "本次没有可用正文";
    frame.append(placeholder);
  }

  wrapper.append(frame);

  const foot = document.createElement("div");

  foot.className = "artifact-foot";
  foot.innerHTML = `
    <span class="model-tag">${escapeHtml(scaleLabel)}</span>
    <span class="duration-tag">${formatDuration(artifact.durationMs)}</span>
  `;
  wrapper.append(foot);
  wrapper.append(renderPromptToggle(artifact));

  return wrapper;
}

function renderPromptToggle(artifact) {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const pre = document.createElement("pre");

  details.className = "prompt-toggle";
  summary.textContent = "本次实际提示词";
  pre.textContent = "展开后加载…";
  details.append(summary, pre);

  details.addEventListener(
    "toggle",
    () => {
      if (!details.open || details.dataset.loaded === "1") {
        return;
      }

      details.dataset.loaded = "1";
      void loadArtifactDetail(artifact.id).then((detail) => {
        pre.textContent = detail.prompt || "（没有记录提示词）";
      });
    },
    { once: false }
  );

  return details;
}

function renderColumnFoot(column) {
  const foot = document.createElement("div");

  foot.className = "column-pager";
  foot.innerHTML = `
    <span>共 ${column.total} 件作品</span>
    <span>第 ${column.page} / ${column.totalPages} 页</span>
  `;

  return foot;
}

function renderBoardPager(paging) {
  const totalPages = Math.max(1, paging.totalPages);

  elements.boardPager.textContent = "";
  elements.boardPager.hidden = paging.total === 0 && totalPages <= 1;

  if (elements.boardPager.hidden) {
    return;
  }

  const sizeField = document.createElement("label");
  sizeField.className = "pager-size";
  sizeField.innerHTML = `
    <span>每页</span>
    <select id="boardPageSize">
      ${[1, 3, 5, 10]
        .map(
          (size) =>
            `<option value="${size}" ${size === paging.pageSize ? "selected" : ""}>${size}</option>`
        )
        .join("")}
    </select>
  `;
  sizeField.querySelector("select").addEventListener("change", (event) => {
    state.pageSize = Number(event.target.value) || 3;
    state.page = 1;
    void load();
  });

  const controls = document.createElement("div");
  const pages = pageWindow(paging.page, totalPages);

  controls.className = "pager-buttons";
  controls.append(createPagerButton("‹", paging.page <= 1, () => goPage(paging.page - 1)));

  for (const item of pages) {
    if (item === "…") {
      const gap = document.createElement("span");
      gap.textContent = "…";
      controls.append(gap);
      continue;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = String(item);
    button.classList.toggle("is-current", item === paging.page);
    button.addEventListener("click", () => goPage(item));
    controls.append(button);
  }

  controls.append(
    createPagerButton("›", paging.page >= totalPages, () => goPage(paging.page + 1))
  );

  const total = document.createElement("span");
  total.textContent = `共 ${paging.total} 件作品`;

  elements.boardPager.append(sizeField, controls, total);
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

function goPage(page) {
  if (page < 1 || state.loading) {
    return;
  }

  state.page = page;
  void load();
  window.scrollTo({ top: elements.board.offsetTop - 80, behavior: "smooth" });
}

function renderError(message) {
  elements.board.textContent = "";
  elements.board.append(createEmpty(`看板加载失败：${message}`));
  elements.boardPager.hidden = true;
  setBadge("off", "数据读取失败");
}

function createEmpty(text) {
  const paragraph = document.createElement("p");

  paragraph.className = "empty";
  paragraph.textContent = text;
  return paragraph;
}

// ---------- 预览 ----------

async function openPreview(artifact) {
  elements.previewModal.hidden = false;
  elements.previewTitle.textContent = `${artifact.groupName || "作品"} · ${artifact.createdAtLabel}`;
  elements.previewEyebrow.textContent = artifact.questionTitle
    ? `检测题目：${artifact.questionTitle}${artifact.questionNote ? ` · ${artifact.questionNote}` : ""}`
    : "作品预览";
  elements.previewMeta.textContent = `${artifact.modelLabel || "-"} · ${formatDuration(artifact.durationMs)}`;
  elements.previewBody.textContent = "";

  const frame = document.createElement("div");
  const iframe = document.createElement("iframe");

  frame.className = "preview-frame";
  iframe.src = `${BASE}/api/artifact/${encodeURIComponent(artifact.id)}/html`;
  iframe.title = elements.previewTitle.textContent;
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  frame.append(iframe);
  elements.previewBody.append(frame);

  if (artifact.status === "error") {
    const error = document.createElement("p");

    error.className = "preview-error";
    error.textContent = artifact.error || "本次调用失败";
    elements.previewBody.append(error);
  }

  const promptBlock = document.createElement("details");

  promptBlock.className = "preview-block";
  promptBlock.innerHTML = "<summary>本次实际提示词</summary><pre>加载中…</pre>";
  elements.previewBody.append(promptBlock);

  try {
    const detail = await loadArtifactDetail(artifact.id);

    promptBlock.querySelector("pre").textContent = detail.prompt || "（没有记录提示词）";
  } catch (error) {
    promptBlock.querySelector("pre").textContent = error.message;
  }
}

function closePreview() {
  elements.previewModal.hidden = true;
  elements.previewBody.textContent = "";
}

const detailCache = new Map();

async function loadArtifactDetail(id) {
  if (detailCache.has(id)) {
    return detailCache.get(id);
  }

  const response = await fetch(`${BASE}/api/artifact/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" }
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || "作品详情读取失败");
  }

  detailCache.set(id, payload.artifact);
  return payload.artifact;
}

// ---------- 缩略图缩放 ----------

function fitFrames() {
  for (const frame of document.querySelectorAll('.frame[data-frame="1"]')) {
    const iframe = frame.querySelector("iframe");

    if (!iframe) {
      continue;
    }

    const scale = frame.clientWidth > 0 ? frame.clientWidth / 1280 : 0;

    if (scale > 0) {
      iframe.style.transform = `scale(${scale})`;
    }
  }
}

// ---------- 工具 ----------

function formatDuration(durationMs) {
  const value = Number(durationMs) || 0;

  if (value <= 0) {
    return "-";
  }

  if (value < 1000) {
    return `${value} ms`;
  }

  return `${(value / 1000).toFixed(1)} s`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
