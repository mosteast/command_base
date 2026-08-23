"use strict";

const { spawn } = require("child_process");
const { MINIMUM_GALLERY_DL_VERSION } = require("./constants");

function run_command(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: options.inherit
        ? "inherit"
        : ["ignore", "pipe", "pipe"],
      env: options.env || process.env,
    });
    let stdout = "";
    let stderr = "";
    if (!options.inherit) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }
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

function extract_semver(raw_text) {
  const text = String(raw_text || "");
  const match = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return "";
  return `${match[1]}.${match[2]}.${match[3] || "0"}`;
}

function version_is_less_than(left_version, right_version) {
  const left = extract_semver(left_version)
    .split(".")
    .map((part) => Number(part));
  const right = extract_semver(right_version)
    .split(".")
    .map((part) => Number(part));
  if (left.length !== 3 || right.length !== 3) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return true;
    if (left[index] > right[index]) return false;
  }
  return false;
}

async function which_command(command_name, options = {}) {
  const result = await run_command("which", [command_name], options);
  if (!result.ok) return "";
  return result.stdout.trim().split(/\r?\n/)[0] || "";
}

async function detect_tool_version(command_name, version_args, options = {}) {
  const result = await run_command(command_name, version_args, options);
  const combined = `${result.stdout}\n${result.stderr}`;
  return {
    ok: result.ok || Boolean(extract_semver(combined)),
    version: extract_semver(combined),
    raw: combined.trim(),
    path: options.resolved_path || "",
  };
}

async function ensure_brew_package({
  package_name,
  dry_run = false,
  upgrade = false,
  brew_command = "brew",
}) {
  const action = upgrade ? "upgrade" : "install";
  const args = [action, package_name];
  if (dry_run) {
    return {
      ok: true,
      dry_run: true,
      command: [brew_command, ...args],
    };
  }
  const result = await run_command(brew_command, args, { inherit: true });
  return {
    ok: result.ok,
    dry_run: false,
    command: [brew_command, ...args],
    error: result.ok
      ? ""
      : result.stderr.trim() || `brew ${action} ${package_name} failed`,
  };
}

async function check_gallery_dl(options = {}) {
  const command_name = options.command_name || "gallery-dl";
  const resolved = await which_command(command_name, options);
  if (!resolved) {
    return {
      ok: false,
      present: false,
      version: "",
      needs_install: true,
      needs_upgrade: false,
      minimum_version: MINIMUM_GALLERY_DL_VERSION,
      message: "gallery-dl not found on PATH",
      fix: "brew install gallery-dl",
    };
  }
  const version_info = await detect_tool_version(
    command_name,
    ["--version"],
    { ...options, resolved_path: resolved },
  );
  const needs_upgrade =
    !version_info.version ||
    version_is_less_than(version_info.version, MINIMUM_GALLERY_DL_VERSION);
  return {
    ok: !needs_upgrade,
    present: true,
    version: version_info.version,
    needs_install: false,
    needs_upgrade,
    minimum_version: MINIMUM_GALLERY_DL_VERSION,
    path: resolved,
    message: needs_upgrade
      ? `gallery-dl ${version_info.version || "unknown"} is older than ${MINIMUM_GALLERY_DL_VERSION}`
      : `gallery-dl ${version_info.version}`,
    fix: needs_upgrade ? "brew upgrade gallery-dl" : "",
  };
}

async function check_yt_dlp(options = {}) {
  const command_name = options.command_name || "yt-dlp";
  const resolved = await which_command(command_name, options);
  if (!resolved) {
    return {
      ok: false,
      present: false,
      version: "",
      needs_install: true,
      needs_upgrade: false,
      message: "yt-dlp not found on PATH",
      fix: "brew install yt-dlp",
    };
  }
  const version_info = await detect_tool_version(
    command_name,
    ["--version"],
    { ...options, resolved_path: resolved },
  );
  return {
    ok: true,
    present: true,
    version: version_info.version,
    needs_install: false,
    needs_upgrade: false,
    path: resolved,
    message: `yt-dlp ${version_info.version || "present"}`,
    fix: "",
  };
}

async function check_f2(options = {}) {
  const fs_promises = require("fs/promises");
  const fs_sync = require("fs");
  const upstream =
    options.upstream_path ||
    process.env.COMMAND_BASE_F2_UPSTREAM ||
    `${process.env.HOME}/.local/bin/f2`;
  const result = await run_command(upstream, ["--version"], options).catch(
    () => null,
  );
  try {
    await fs_promises.access(
      upstream,
      fs_sync.constants ? fs_sync.constants.X_OK : undefined,
    );
    let version = "";
    if (result && result.stdout) version = extract_semver(result.stdout);
    return {
      ok: true,
      present: true,
      version,
      path: upstream,
      needs_install: false,
      needs_upgrade: false,
      message: `f2 present at ${upstream}`,
      fix: "",
    };
  } catch (_error) {
    return {
      ok: false,
      present: false,
      version: "",
      path: upstream,
      needs_install: true,
      needs_upgrade: false,
      message: `f2 not found: ${upstream}`,
      fix: "pipx install f2  # or install upstream f2 and set COMMAND_BASE_F2_UPSTREAM",
    };
  }
}

module.exports = {
  run_command,
  extract_semver,
  version_is_less_than,
  which_command,
  detect_tool_version,
  ensure_brew_package,
  check_gallery_dl,
  check_yt_dlp,
  check_f2,
  MINIMUM_GALLERY_DL_VERSION,
};
