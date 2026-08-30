"use strict";

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

function rewrite_xsave_instagram_command_text(command_text) {
  const text = String(command_text || "").trim();
  const tokens = tokenize_command(text);
  if (tokens.length === 0) return text;
  if (tokens[0] !== "xsave_instagram") return text;

  const rest = tokens.slice(1);
  let source = "";
  let url = "";
  const kept = [];
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (ALLOWED_SOURCES.includes(tok) && !source) {
      source = tok;
      continue;
    }
    if (!url && /instagram\.com|instagr\.am|https?:\/\//i.test(tok)) {
      url = tok;
      continue;
    }
    kept.push(tok);
  }

  const out = ["xsave_instagram"];
  if (source) out.push(source);
  if (url) out.push(url);
  for (const token of kept) out.push(quote_token(token));
  return out.join(" ");
}

module.exports = {
  rewrite_xsave_instagram_command_text,
  tokenize_command,
};
