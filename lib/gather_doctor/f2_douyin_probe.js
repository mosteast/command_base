"use strict";

const fs = require("fs/promises");
const path = require("path");
const cookie_export = require("./cookie_export");

const DOUYIN_PROBE_TIMEOUT_MS = 90000;
const F2_COMPAT_DIR = path.join(__dirname, "..", "..", "utility", "f2_compat");
const DOUYIN_AUTH_FIX = "gather doctor fix --platform douyin";

function probe_script_path() {
  return path.join(
    __dirname,
    "..",
    "..",
    "utility",
    "f2_compat",
    "f2_douyin_probe.py",
  );
}

function is_douyin_user_probe_url(raw_url) {
  try {
    const parsed = new URL(String(raw_url || "").trim());
    const host = String(parsed.hostname || "").replace(/^www\./i, "").toLowerCase();
    if (host === "v.douyin.com" || host.endsWith(".v.douyin.com")) return true;
    if (host === "douyin.com" || host.endsWith(".douyin.com"))
      return /\/(user|share\/user)\//i.test(parsed.pathname);
    return false;
  } catch (_error) {
    return false;
  }
}

async function resolve_f2_python(f2_path) {
  const resolved = String(f2_path || "").trim();
  if (!resolved) return "python3";
  try {
    const text = await fs.readFile(resolved, "utf8");
    const shebang = String(text.split("\n")[0] || "");
    const match = shebang.match(/^#!\s*(\S*python\S*)/i);
    if (match) return match[1];
  } catch (_error) {
    // fall through to python3
  }
  return "python3";
}

function parse_probe_json(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_error) {
      // try previous line
    }
  }
  return null;
}

function classify_side(side, label) {
  const item = side && typeof side === "object" ? side : {};
  const status = String(item.status || "");
  const http_status = Number(item.http_status) || 0;
  const count = Number(item.count) || 0;
  if (status === "http_error" && (http_status === 403 || http_status === 401)) {
    return {
      status: "fail",
      detail: `${label} HTTP ${http_status}`,
      next_command: DOUYIN_AUTH_FIX,
    };
  }
  if (status === "http_error") {
    return {
      status: "warn",
      detail: `${label} HTTP ${http_status || "error"}`,
      next_command: "",
    };
  }
  if (status === "ok" && count > 0) {
    return {
      status: "ok",
      detail: `${label} ${count} item(s)`,
      next_command: "",
    };
  }
  if (status === "empty" || (status === "ok" && count === 0)) {
    return {
      status: "warn",
      detail: `${label} empty (0 items)`,
      next_command: "",
    };
  }
  return {
    status: "warn",
    detail: `${label} probe failed`,
    next_command: "",
  };
}

function worse_result(left, right) {
  const rank = { ok: 0, warn: 1, fail: 2 };
  return (rank[left.status] || 0) >= (rank[right.status] || 0) ? left : right;
}

function classify_douyin_api_probe({ stdout, stderr, timed_out } = {}) {
  if (timed_out) {
    return {
      status: "warn",
      detail: "douyin API probe timed out",
      next_command: "",
    };
  }

  const parsed = parse_probe_json(stdout);
  if (!parsed) {
    if (/403/.test(`${stdout}\n${stderr}`)) {
      return {
        status: "fail",
        detail: "like HTTP 403",
        next_command: DOUYIN_AUTH_FIX,
      };
    }
    return {
      status: "warn",
      detail: "douyin API probe failed",
      next_command: "",
    };
  }

  if (parsed.error === "missing_cookie") {
    return {
      status: "fail",
      detail: "f2 douyin cookie missing",
      next_command: DOUYIN_AUTH_FIX,
    };
  }

  const post = classify_side(parsed.post, "post");
  const like = classify_side(parsed.like, "like");
  if (post.status === "ok" && like.status === "ok") {
    return {
      status: "ok",
      detail: "post and like APIs returned items",
      next_command: "",
    };
  }
  if (
    post.status === "warn" &&
    like.status === "warn" &&
    /empty/.test(post.detail) &&
    /empty/.test(like.detail)
  ) {
    return {
      status: "warn",
      detail: "post empty (0 items); like empty (0 items)",
      next_command: "",
    };
  }
  const worst = worse_result(post, like);
  return {
    status: worst.status,
    detail: `${post.detail}; ${like.detail}`,
    next_command: worst.next_command,
  };
}

function is_chrome_like_ok(chrome_like) {
  if (!chrome_like || typeof chrome_like !== "object") return false;
  const list = Array.isArray(chrome_like.aweme_list)
    ? chrome_like.aweme_list
    : [];
  return Number(chrome_like.status_code) === 0 && list.length > 0;
}

function apply_chrome_like_override(classified, chrome_like) {
  if (!classified || classified.status !== "fail") return classified;
  if (!/403/.test(String(classified.detail || ""))) return classified;
  if (!is_chrome_like_ok(chrome_like)) return classified;
  const count = chrome_like.aweme_list.length;
  return {
    status: "ok",
    detail: `${classified.detail}; Chrome like ${count} item(s)`,
    next_command: "",
  };
}

function build_probe_env({ chrome_profile } = {}) {
  const pythonpath = process.env.PYTHONPATH
    ? `${F2_COMPAT_DIR}${path.delimiter}${process.env.PYTHONPATH}`
    : F2_COMPAT_DIR;
  const env = {
    ...process.env,
    COMMAND_BASE_F2_PATCH: "1",
    COMMAND_BASE_F2_LIKE_LIMIT: process.env.COMMAND_BASE_F2_LIKE_LIMIT || "20",
    PYTHONPATH: pythonpath,
  };
  const profile = String(chrome_profile || "").trim();
  if (profile) env.COMMAND_BASE_F2_CHROME_PROFILE = profile;
  return env;
}

async function run_douyin_api_probe({
  f2_path,
  url,
  f2_config_path,
  chrome_profile,
  probe_chrome_like,
} = {}) {
  const python = await resolve_f2_python(f2_path);
  const args = [probe_script_path(), "--url", String(url || "")];
  if (f2_config_path) args.push("--f2-config", String(f2_config_path));
  const probe = await cookie_export.run_command(python, args, {
    timeout_ms: DOUYIN_PROBE_TIMEOUT_MS,
    env: build_probe_env({ chrome_profile }),
  });
  const classified = classify_douyin_api_probe(probe);
  if (classified.status !== "fail" || !/403/.test(classified.detail || ""))
    return classified;
  try {
    const prober =
      probe_chrome_like ||
      require("../xsave_douyin/chrome_client").probe_chrome_like;
    const chrome_like = await prober({
      url,
      chrome_profile,
      limit: 1,
    });
    return apply_chrome_like_override(classified, chrome_like);
  } catch (_error) {
    return classified;
  }
}

module.exports = {
  DOUYIN_PROBE_TIMEOUT_MS,
  apply_chrome_like_override,
  build_probe_env,
  classify_douyin_api_probe,
  is_douyin_user_probe_url,
  probe_script_path,
  resolve_f2_python,
  run_douyin_api_probe,
};
