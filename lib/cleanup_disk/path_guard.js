"use strict";

const path = require("path");

function normalize_for_compare(target_path) {
  const resolved = path.resolve(String(target_path));
  if (resolved === "/") {
    return "/";
  }
  return resolved.replace(/\/+$/, "");
}

function is_dangerous_path(resolved_path, { home }) {
  const target = normalize_for_compare(resolved_path);
  const home_n = normalize_for_compare(home);
  const blocked = ["/", "/Users", "/System", "/private/var/folders", home_n];
  return blocked.some((entry) => target === normalize_for_compare(entry));
}

function assert_safe_path(resolved_path, options) {
  if (is_dangerous_path(resolved_path, options)) {
    throw new Error(`Refusing dangerous path: ${resolved_path}`);
  }
}

module.exports = {
  is_dangerous_path,
  assert_safe_path,
};
