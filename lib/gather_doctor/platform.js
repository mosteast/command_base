"use strict";

const { PLATFORM_ALIASES, PLATFORM_KEYS } = require("./constants");

function normalize_platform_key(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase();
  if (!text) return "";
  return PLATFORM_ALIASES[text] || text;
}

function is_supported_platform(platform_key) {
  return PLATFORM_KEYS.includes(platform_key);
}

function normalize_platform_list(raw_values) {
  const list = Array.isArray(raw_values) ? raw_values : [raw_values];
  const normalized = [];
  for (const entry of list) {
    const text = String(entry || "").trim();
    if (!text) continue;
    for (const part of text.split(",").map((item) => item.trim())) {
      if (!part) continue;
      const platform_key = normalize_platform_key(part);
      if (!platform_key) continue;
      if (!is_supported_platform(platform_key)) {
        throw new Error(
          `Unsupported platform: ${part}. Supported: ${PLATFORM_KEYS.join(", ")}`,
        );
      }
      if (!normalized.includes(platform_key)) normalized.push(platform_key);
    }
  }
  return normalized;
}

function select_platforms(include_platforms, exclude_platforms) {
  let selected =
    include_platforms && include_platforms.length > 0
      ? [...include_platforms]
      : [...PLATFORM_KEYS];
  if (exclude_platforms && exclude_platforms.length > 0) {
    selected = selected.filter((key) => !exclude_platforms.includes(key));
  }
  return selected;
}

module.exports = {
  normalize_platform_key,
  is_supported_platform,
  normalize_platform_list,
  select_platforms,
};
