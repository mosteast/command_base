"use strict";

const fs = require("fs/promises");
const path = require("path");
const YAML = require("yaml");
const { expand_user_path } = require("./runtime_config");

function default_f2_app_config_path() {
  const home = process.env.HOME || "";
  return path.join(
    home,
    ".local",
    "pipx",
    "venvs",
    "f2",
    "lib",
    "python3.13",
    "site-packages",
    "f2",
    "conf",
    "app.yaml",
  );
}

async function resolve_f2_app_config_path(options = {}) {
  if (options.f2_config_path) {
    return path.resolve(expand_user_path(options.f2_config_path));
  }
  if (process.env.GATHER_SETUP_F2_APP_CONFIG) {
    return path.resolve(
      expand_user_path(process.env.GATHER_SETUP_F2_APP_CONFIG),
    );
  }

  const candidates = [
    default_f2_app_config_path(),
    path.join(
      process.env.HOME || "",
      ".local",
      "pipx",
      "venvs",
      "f2",
      "lib",
      "python3.12",
      "site-packages",
      "f2",
      "conf",
      "app.yaml",
    ),
    path.join(
      process.env.HOME || "",
      ".local",
      "pipx",
      "venvs",
      "f2",
      "lib",
      "python3.11",
      "site-packages",
      "f2",
      "conf",
      "app.yaml",
    ),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (_error) {
      // try next
    }
  }

  return candidates[0];
}

function f2_app_key_for_platform(platform_key) {
  if (platform_key === "douyin") return "douyin";
  if (platform_key === "x_f2") return "twitter";
  return "";
}

async function read_f2_cookie_presence(platform_key, options = {}) {
  const config_path = await resolve_f2_app_config_path(options);
  const app_key = f2_app_key_for_platform(platform_key);
  if (!app_key) {
    return { ok: false, present: false, config_path, error: "unsupported platform" };
  }
  try {
    const raw_text = await fs.readFile(config_path, "utf8");
    const parsed = YAML.parse(raw_text) || {};
    const section = parsed[app_key] || {};
    const cookie_text = String(section.cookie || "").trim();
    return {
      ok: true,
      present: cookie_text.length > 0,
      config_path,
      cookie_length: cookie_text.length,
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        ok: false,
        present: false,
        config_path,
        error: `f2 app config missing: ${config_path}`,
      };
    }
    return {
      ok: false,
      present: false,
      config_path,
      error: error.message,
    };
  }
}

async function write_f2_cookie(platform_key, cookie_header, options = {}) {
  const config_path = await resolve_f2_app_config_path(options);
  const app_key = f2_app_key_for_platform(platform_key);
  if (!app_key) {
    return { ok: false, config_path, error: "unsupported platform" };
  }
  if (options.dry_run) {
    return { ok: true, dry_run: true, config_path, app_key };
  }

  let parsed = {};
  try {
    const raw_text = await fs.readFile(config_path, "utf8");
    parsed = YAML.parse(raw_text) || {};
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    parsed = {};
  }

  if (!parsed[app_key] || typeof parsed[app_key] !== "object") {
    parsed[app_key] = {};
  }
  parsed[app_key].cookie = String(cookie_header || "");

  await fs.mkdir(path.dirname(config_path), { recursive: true });
  await fs.writeFile(config_path, YAML.stringify(parsed), "utf8");
  return { ok: true, dry_run: false, config_path, app_key };
}

module.exports = {
  default_f2_app_config_path,
  resolve_f2_app_config_path,
  f2_app_key_for_platform,
  read_f2_cookie_presence,
  write_f2_cookie,
};
