"use strict";

const fs = require("fs/promises");
const path = require("path");
const YAML = require("yaml");
const { DEFAULT_RUNTIME_PATH, RUNTIME_VERSION } = require("./constants");

function expand_user_path(raw_path) {
  if (!raw_path) return raw_path;
  const text = String(raw_path);
  if (!text.startsWith("~")) return text;
  const home_dir = process.env.HOME;
  if (!home_dir) return text;
  if (text === "~") return home_dir;
  if (text.startsWith("~/")) return path.join(home_dir, text.slice(2));
  return text;
}

function resolve_runtime_path(raw_path) {
  return path.resolve(expand_user_path(raw_path || DEFAULT_RUNTIME_PATH));
}

function normalize_runtime_data(raw_data) {
  const data = raw_data && typeof raw_data === "object" ? { ...raw_data } : {};
  data.version = Number(data.version) || RUNTIME_VERSION;
  if (!data.platform || typeof data.platform !== "object") data.platform = {};
  return data;
}

async function read_runtime_config(runtime_path) {
  const resolved = resolve_runtime_path(runtime_path);
  try {
    const raw_text = await fs.readFile(resolved, "utf8");
    return {
      path: resolved,
      data: normalize_runtime_data(YAML.parse(raw_text) || {}),
      exists: true,
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        path: resolved,
        data: normalize_runtime_data({}),
        exists: false,
      };
    }
    throw error;
  }
}

async function write_runtime_config(runtime_path, data, options = {}) {
  const resolved = resolve_runtime_path(runtime_path);
  const payload = normalize_runtime_data(data);
  payload.version = RUNTIME_VERSION;
  payload.updated_at = new Date().toISOString();
  if (options.dry_run) {
    return { path: resolved, dry_run: true, data: payload };
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const text = YAML.stringify(payload);
  await fs.writeFile(resolved, text, "utf8");
  return { path: resolved, dry_run: false, data: payload };
}

function get_platform_runtime(runtime_data, platform_key) {
  if (!runtime_data || typeof runtime_data !== "object") return null;
  const platform_map = runtime_data.platform;
  if (!platform_map || typeof platform_map !== "object") return null;
  const entry = platform_map[platform_key];
  if (!entry || typeof entry !== "object") return null;
  return entry;
}

function set_platform_runtime(runtime_data, platform_key, patch) {
  const data = normalize_runtime_data(runtime_data);
  data.platform[platform_key] = {
    ...(data.platform[platform_key] || {}),
    ...patch,
  };
  return data;
}

function get_cookies_from_browser(runtime_data, platform_key) {
  const entry = get_platform_runtime(runtime_data, platform_key);
  if (!entry) return "";
  if (entry.cookies_from_browser)
    return String(entry.cookies_from_browser).trim();
  if (entry.chrome_profile)
    return `chrome:${String(entry.chrome_profile).trim()}`;
  return "";
}

function get_cookies_file(runtime_data, platform_key) {
  const entry = get_platform_runtime(runtime_data, platform_key);
  if (!entry || !entry.cookies_file) return "";
  return path.resolve(expand_user_path(String(entry.cookies_file).trim()));
}

module.exports = {
  expand_user_path,
  resolve_runtime_path,
  normalize_runtime_data,
  read_runtime_config,
  write_runtime_config,
  get_platform_runtime,
  set_platform_runtime,
  get_cookies_from_browser,
  get_cookies_file,
};
