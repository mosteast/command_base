"use strict";

const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { DEFAULT_CHROME_USER_DATA, HOST_PATTERNS } = require("./constants");

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

function resolve_chrome_user_data_dir(raw_path) {
  return path.resolve(
    expand_user_path(raw_path || DEFAULT_CHROME_USER_DATA),
  );
}

async function path_exists(target_path) {
  try {
    await fs.access(target_path);
    return true;
  } catch (_error) {
    return false;
  }
}

function run_command(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env || process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        exit_code: 1,
        stdout,
        stderr: stderr || error.message,
        error,
      });
    });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        exit_code: typeof code === "number" ? code : 1,
        stdout,
        stderr,
      });
    });
  });
}

async function list_chrome_profiles(user_data_dir, options = {}) {
  const root = resolve_chrome_user_data_dir(user_data_dir);
  const local_state_path = path.join(root, "Local State");
  if (!(await path_exists(local_state_path))) {
    return { root, profiles: [], error: `Chrome Local State missing: ${local_state_path}` };
  }

  let local_state;
  try {
    const raw_text = await fs.readFile(local_state_path, "utf8");
    local_state = JSON.parse(raw_text);
  } catch (error) {
    return {
      root,
      profiles: [],
      error: `Unable to parse Chrome Local State: ${error.message}`,
    };
  }

  const info_cache =
    local_state &&
    local_state.profile &&
    typeof local_state.profile.info_cache === "object"
      ? local_state.profile.info_cache
      : {};

  const profiles = [];
  for (const [directory, info] of Object.entries(info_cache)) {
    const active_time = Number(
      (info && (info.active_time || info.last_active_time)) || 0,
    );
    profiles.push({
      directory,
      name: String((info && info.name) || directory),
      active_time: Number.isFinite(active_time) ? active_time : 0,
      cookies_path: path.join(root, directory, "Cookies"),
    });
  }

  profiles.sort((left, right) => right.active_time - left.active_time);

  if (options.chrome_profile) {
    const wanted = String(options.chrome_profile).trim();
    return {
      root,
      profiles: profiles.filter(
        (profile) =>
          profile.directory === wanted ||
          profile.name.toLowerCase() === wanted.toLowerCase(),
      ),
    };
  }

  return { root, profiles };
}

function host_matches_patterns(host_key, patterns) {
  const host = String(host_key || "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  if (!host) return false;
  return patterns.some((pattern) => {
    const needle = String(pattern || "")
      .trim()
      .toLowerCase();
    if (!needle) return false;
    return host === needle || host.endsWith(`.${needle}`);
  });
}

async function read_cookie_hosts(cookies_path, options = {}) {
  const sqlite3_command = options.sqlite3_command || "sqlite3";
  const copy_path = `${cookies_path}.gather_setup_copy`;
  let used_copy = false;

  async function query(db_path) {
    const result = await run_command(sqlite3_command, [
      db_path,
      "SELECT DISTINCT host_key FROM cookies;",
    ]);
    if (!result.ok) {
      return {
        ok: false,
        hosts: [],
        error: result.stderr.trim() || result.stdout.trim() || "sqlite3 query failed",
        locked: /locked|busy/i.test(`${result.stderr}\n${result.stdout}`),
      };
    }
    const hosts = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return { ok: true, hosts, error: "", locked: false };
  }

  try {
    await fs.copyFile(cookies_path, copy_path);
    used_copy = true;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { ok: false, hosts: [], error: `Cookies DB missing: ${cookies_path}` };
    }
    const direct = await query(cookies_path);
    if (direct.ok) return direct;
    return {
      ok: false,
      hosts: [],
      error:
        `Unable to copy locked Chrome Cookies DB (${error.message}). Quit Chrome and retry.`,
      locked: true,
    };
  }

  try {
    return await query(copy_path);
  } finally {
    if (used_copy) {
      try {
        await fs.unlink(copy_path);
      } catch (_error) {
        // Ignore cleanup failures for temporary copies.
      }
    }
  }
}

async function scan_chrome_hosts(options = {}) {
  const listed = await list_chrome_profiles(
    options.chrome_user_data_dir,
    options,
  );
  if (listed.error) {
    return { ...listed, scans: [] };
  }

  const scans = [];
  for (const profile of listed.profiles) {
    const has_cookies = await path_exists(profile.cookies_path);
    if (!has_cookies) {
      scans.push({
        ...profile,
        ok: false,
        hosts: [],
        error: `Cookies DB missing: ${profile.cookies_path}`,
      });
      continue;
    }
    const host_result = await read_cookie_hosts(profile.cookies_path, options);
    scans.push({
      ...profile,
      ok: host_result.ok,
      hosts: host_result.hosts,
      error: host_result.error,
      locked: Boolean(host_result.locked),
    });
  }

  return { root: listed.root, profiles: listed.profiles, scans };
}

function profiles_with_platform_hosts(scans, platform_key) {
  const patterns = HOST_PATTERNS[platform_key] || [];
  const matches = [];
  for (const scan of scans || []) {
    if (!scan || !scan.ok) continue;
    const matched_hosts = (scan.hosts || []).filter((host) =>
      host_matches_patterns(host, patterns),
    );
    if (matched_hosts.length === 0) continue;
    matches.push({
      directory: scan.directory,
      name: scan.name,
      active_time: scan.active_time,
      matched_hosts,
    });
  }
  matches.sort((left, right) => right.active_time - left.active_time);
  return matches;
}

function pick_best_profile(matches) {
  if (!matches || matches.length === 0) return null;
  return matches[0];
}

module.exports = {
  resolve_chrome_user_data_dir,
  list_chrome_profiles,
  read_cookie_hosts,
  scan_chrome_hosts,
  host_matches_patterns,
  profiles_with_platform_hosts,
  pick_best_profile,
  run_command,
};
