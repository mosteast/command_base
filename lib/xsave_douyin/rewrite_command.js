"use strict";

const F2_MODE_TO_SOURCE = {
  like: "like",
  post: "post",
  collection: "collection",
  one: "video",
};
const ALLOWED_SOURCES = ["like", "post", "collection", "video"];

function tokenize_command(text) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(text || ""))))
    tokens.push(match[1] || match[2] || match[3]);
  return tokens;
}

function quote_token(token) {
  const text = String(token);
  if (/[\s"']/.test(text)) return `"${text.replace(/"/g, '\\"')}"`;
  return text;
}

function rewrite_xsave_douyin_command_text(command_text) {
  const text = String(command_text || "").trim();
  const tokens = tokenize_command(text);
  if (tokens.length === 0) return text;

  let start = 0;
  if (tokens[0] === "f2" || tokens[0] === "f2_compat") {
    if (tokens[1] === "dy") start = 2;
    else if (tokens[0] === "f2") return `f2_compat${text.slice(2)}`;
    else return text;
  } else if (tokens[0] === "xsave_douyin") {
    start = 1;
  } else {
    return text;
  }

  const rest = tokens.slice(start);
  let source = "";
  let url = "";
  const kept = [];
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (tok === "-M" || tok === "--mode") {
      const raw = rest[i + 1] || "";
      source = F2_MODE_TO_SOURCE[raw] || raw;
      i += 1;
      continue;
    }
    if (tok.startsWith("--mode=")) {
      const raw = tok.slice("--mode=".length);
      source = F2_MODE_TO_SOURCE[raw] || raw;
      continue;
    }
    if (tok === "-u" || tok === "--url") {
      url = rest[i + 1] || "";
      i += 1;
      continue;
    }
    if (tok.startsWith("--url=")) {
      url = tok.slice("--url=".length);
      continue;
    }
    if (tok === "-p" || tok === "--path") {
      kept.push("--output", rest[i + 1] || "");
      i += 1;
      continue;
    }
    if (tok.startsWith("--path=")) {
      kept.push(`--output=${tok.slice("--path=".length)}`);
      continue;
    }
    if (tok === "--check-all") {
      kept.push("--full-scan");
      continue;
    }
    kept.push(tok);
  }

  if (!source && ALLOWED_SOURCES.includes(kept[0])) source = kept.shift();
  if (!url) {
    const index = kept.findIndex((token) =>
      /douyin\.com|https?:\/\//i.test(token),
    );
    if (index >= 0) url = kept.splice(index, 1)[0];
  }

  const out = ["xsave_douyin"];
  if (source) out.push(source);
  if (url) out.push(url);
  for (const token of kept) out.push(quote_token(token));
  return out.join(" ");
}

module.exports = {
  rewrite_xsave_douyin_command_text,
  tokenize_command,
};
