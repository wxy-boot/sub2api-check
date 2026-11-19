const FENCE_PATTERN = /```([a-zA-Z0-9_-]*)\s*\r?\n([\s\S]*?)```/g;

const MARKUP_PATTERN = /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<svg[\s>]|<canvas[\s>]|<div[\s>]|<style[\s>]/i;

const DOC_PATTERN = /<!doctype\s+html|<html[\s>]/i;

const BASE_STYLE = [
  "<style>",
  "html,body{margin:0;padding:0;min-height:100%;}",
  "body{font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;}",
  "</style>"
].join("");

/**
 * 把模型输出整理成可以直接渲染的作品。
 * - 去掉 Markdown 代码围栏与开头寒暄
 * - 缺少 <html> 的片段补成完整文档
 * - 完全不是标记语言时按纯文本保存
 */
export function extractArtifact(content, options = {}) {
  const maxChars = Number(options.maxChars) || 200000;
  const text = String(content ?? "").replace(/^\uFEFF/, "").trim();
  const fenced = pickFencedBlock(text);
  const body = fenced || text;

  if (!body) {
    return { kind: "text", html: "", text: "", charCount: 0, truncated: false };
  }

  if (!MARKUP_PATTERN.test(body)) {
    const plain = truncate(body, maxChars);
    return {
      kind: "text",
      html: "",
      text: plain.value,
      charCount: plain.value.length,
      truncated: plain.truncated
    };
  }

  const trimmed = stripLeadingProse(body);
  const document = DOC_PATTERN.test(trimmed) ? trimmed : wrapDocument(trimmed);
  const limited = truncate(document, maxChars);

  return {
    kind: "html",
    html: limited.value,
    text: "",
    charCount: limited.value.length,
    truncated: limited.truncated
  };
}

function pickFencedBlock(text) {
  const blocks = [...text.matchAll(FENCE_PATTERN)].map((match) => ({
    language: String(match[1] || "").toLowerCase(),
    code: match[2].trim()
  }));

  if (blocks.length === 0) {
    return "";
  }

  const ranked = blocks
    .map((block) => ({
      ...block,
      score: (MARKUP_PATTERN.test(block.code) ? 2 : 0) + (block.code.length > 0 ? 1 : 0)
    }))
    .sort((left, right) => right.score - left.score || right.code.length - left.code.length);

  return ranked[0].code;
}

// 「下面是代码：\n<!doctype html>…」这类输出只保留真正的文档部分。
function stripLeadingProse(text) {
  const matches = [...text.matchAll(/<!doctype\s+html|<html[\s>]|<svg[\s>]/gi)];

  if (matches.length === 0) {
    return text;
  }

  const first = matches[0].index || 0;

  if (first === 0) {
    return text;
  }

  const prefix = text.slice(0, first).trim();
  const looksLikeProse = /[:：]$|。$|如下|代码|html/i.test(prefix) && prefix.length < 400;

  if (!looksLikeProse) {
    return text;
  }

  const sliced = text.slice(first).trim();

  // 还残留围栏尾巴时一并去掉。
  return sliced.replace(/\s*```\s*$/, "").trim();
}

function wrapDocument(body) {
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    BASE_STYLE.replace(/<\/?style>/g, "").length > 0 ? BASE_STYLE : "",
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>"
  ].join("\n");
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) {
    return { value: text, truncated: false };
  }

  return {
    value: `${text.slice(0, maxChars)}\n<!-- 内容超过 ${maxChars} 字符，已截断 -->`,
    truncated: true
  };
}
