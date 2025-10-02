"use strict";

const html_entity_map = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#34;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&apos;": "'",
};

function decode_basic_html_entities(input_text) {
  return input_text.replace(/&(nbsp|amp|lt|gt|quot|apos|#34|#39|#x27);/gi, (match) => {
    if (Object.prototype.hasOwnProperty.call(html_entity_map, match)) {
      return html_entity_map[match];
    }
    const normalized_key = match.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(html_entity_map, normalized_key)) {
      return html_entity_map[normalized_key];
    }
    return match;
  });
}

function strip_markdown_fences(source_text) {
  return source_text.replace(/```(.*?)(\n)?([\s\S]*?)```/g, (match, info_string, _line_break, code_body) => {
    const trimmed_body = code_body ? code_body.trimEnd() : "";
    return trimmed_body ? `\n${trimmed_body}\n` : "\n";
  });
}

function convert_markdown_to_plain_text(markdown_input) {
  if (typeof markdown_input !== "string") {
    return "";
  }

  let normalized_text = markdown_input.replace(/\r\n?/g, "\n");

  normalized_text = normalized_text.replace(/^---\n[\s\S]*?\n---\n?/m, "");
  normalized_text = strip_markdown_fences(normalized_text);

  normalized_text = normalized_text.replace(/`([^`]+)`/g, (_match, code_text) => code_text);

  normalized_text = normalized_text.replace(/\!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt_text) => alt_text || "");

  normalized_text = normalized_text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, link_label, link_target) => {
    const label_text = link_label ? link_label.trim() : "";
    const target_text = link_target ? link_target.trim() : "";
    if (label_text && target_text) {
      return `${label_text} (${target_text})`;
    }
    return label_text || target_text;
  });

  normalized_text = normalized_text.replace(/^[ \t]*>+[ \t]?/gm, "");

  normalized_text = normalized_text.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  normalized_text = normalized_text.replace(/^[ \t]*\d+\.[ \t]+/gm, "");

  normalized_text = normalized_text.replace(/^[ \t]*(#{1,6})[ \t]+(.+)$/gm, (_match, _hashes, heading_text) => heading_text.trim());

  normalized_text = normalized_text.replace(/^(.*)\n={3,}\s*$/gm, (match, heading_text) => heading_text.trim());
  normalized_text = normalized_text.replace(/^(.*)\n-{3,}\s*$/gm, (match, heading_text) => heading_text.trim());

  normalized_text = normalized_text.replace(/^[ \t]*([-*_]){3,}[ \t]*$/gm, "");

  normalized_text = normalized_text.replace(/<[^>]+>/g, "");

  normalized_text = decode_basic_html_entities(normalized_text);

  normalized_text = normalized_text.replace(/[ \t]+$/gm, "");
  normalized_text = normalized_text.replace(/\n{3,}/g, "\n\n");

  return normalized_text.trim();
}

module.exports = {
  convert_markdown_to_plain_text,
};
