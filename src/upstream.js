import { httpError } from "./http.js";

const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high"]);

export function createUpstream(config) {
  /**
   * 以 OpenAI Chat Completions 协议调用一个分组。
   * 返回 { status, durationMs, content, raw, usage, model }。
   */
  async function runChatCompletion(group, prompt, options = {}) {
    const endpoint = buildEndpoint(group);
    const timeoutMs = Math.max(5000, Number(options.timeoutMs) || config.requestTimeoutMs);
    const body = buildBody(group, prompt);
    const startedAt = Date.now();
    let response;

    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(group.apiKey ? { Authorization: `Bearer ${group.apiKey}` } : {})
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";

      throw httpError(
        timedOut ? 504 : 502,
        timedOut ? "upstream_timeout" : "upstream_unreachable",
        timedOut
          ? `上游 ${Math.round(timeoutMs / 1000)} 秒没有返回，已中断本次请求。`
          : `无法连接上游接口：${error?.message || "网络错误"}`,
        { durationMs, endpoint }
      );
    }

    const text = await response.text();
    const durationMs = Date.now() - startedAt;
    let payload = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      throw httpError(
        response.status === 401 || response.status === 403 ? 401 : 502,
        "upstream_error",
        describeUpstreamError(response.status, payload, text),
        {
          durationMs,
          endpoint,
          upstreamStatus: response.status,
          raw: truncateRaw(text)
        }
      );
    }

    const content = extractContent(payload, text);

    if (!content) {
      throw httpError(502, "empty_response", "上游返回成功但没有可用的正文内容。", {
        durationMs,
        endpoint,
        raw: truncateRaw(text)
      });
    }

    return {
      status: "ok",
      durationMs,
      content,
      raw: truncateRaw(text),
      usage: payload?.usage || null,
      model: String(payload?.model || body.model || "")
    };
  }

  function buildEndpoint(group) {
    const baseUrl = String(group.baseUrl || "").trim();

    if (!baseUrl) {
      throw httpError(400, "missing_base_url", "分组还没有配置 API 地址。");
    }

    const protocol = normalizeProtocol(group.protocol);
    let origin = baseUrl.replace(/\/+$/, "");
    let suffix = protocol;

    // 用户可能填 https://host 也可能填 https://host/v1，避免拼出 /v1/v1。
    if (/\/v1$/i.test(origin) && /^\/v1\//i.test(suffix)) {
      suffix = suffix.slice(3);
    }

    if (/^https?:\/\//i.test(protocol)) {
      return protocol;
    }

    return `${origin}${suffix}`;
  }

  function buildBody(group, prompt) {
    const body = {
      model: String(group.model || "").trim(),
      messages: [{ role: "user", content: prompt }],
      stream: false
    };

    if (!body.model) {
      throw httpError(400, "missing_model", "分组还没有配置模型名称。");
    }

    if (config.sendReasoningEffort && REASONING_EFFORTS.has(String(group.reasoning).toLowerCase())) {
      body.reasoning_effort = String(group.reasoning).toLowerCase();
    }

    return body;
  }

  return { runChatCompletion };
}

function normalizeProtocol(value) {
  const text = String(value || "/v1/chat/completions").trim();

  if (!text) {
    return "/v1/chat/completions";
  }

  if (/^https?:\/\//i.test(text)) {
    return text;
  }

  return text.startsWith("/") ? text : `/${text}`;
}

function extractContent(payload, rawText) {
  if (!payload) {
    return "";
  }

  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const candidates = [
    choice?.message?.content,
    choice?.delta?.content,
    choice?.text,
    payload?.output_text,
    payload?.content,
    payload?.data?.content,
    payload?.data?.choices?.[0]?.message?.content
  ];

  for (const candidate of candidates) {
    const text = normalizeContent(candidate);

    if (text) {
      return text;
    }
  }

  return rawText && !rawText.trim().startsWith("{") ? rawText : "";
}

function normalizeContent(value) {
  if (typeof value === "string") {
    return value.trim() ? value : "";
  }

  if (Array.isArray(value)) {
    const joined = value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        return part?.text ?? part?.content ?? "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();

    return joined;
  }

  if (value && typeof value === "object") {
    return normalizeContent(value.text ?? value.content ?? "");
  }

  return "";
}

function describeUpstreamError(status, payload, rawText) {
  const upstreamMessage = String(
    payload?.error?.message ?? payload?.message ?? payload?.error ?? rawText ?? ""
  )
    .replace(/\s+/g, " ")
    .slice(0, 300);

  const prefix =
    status === 401 || status === 403
      ? `上游鉴权失败（HTTP ${status}），请检查 API Key 与访问权限`
      : status === 404
        ? `上游接口不存在（HTTP 404），请检查 API 地址与协议路径`
        : status === 429
          ? `上游限流（HTTP 429），稍后再试或降低检测频率`
          : `上游返回异常（HTTP ${status}）`;

  return upstreamMessage ? `${prefix}：${upstreamMessage}` : prefix;
}

function truncateRaw(text) {
  const value = String(text || "");
  return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
}
