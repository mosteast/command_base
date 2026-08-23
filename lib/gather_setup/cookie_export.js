"use strict";

const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { HOST_PATTERNS, PLATFORM_PROBE_URLS } = require("./constants");

function run_command(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env || process.env,
      shell: Boolean(options.shell),
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

function browser_spec_for_profile(chrome_profile) {
  const profile = String(chrome_profile || "").trim();
  if (!profile) return "chrome";
  return `chrome:${profile}`;
}

async function export_netscape_cookies({
  chrome_profile,
  output_path,
  platform_key,
  yt_dlp_command = "yt-dlp",
  dry_run = false,
  probe_url,
}) {
  const resolved_output = path.resolve(output_path);
  const browser_spec = browser_spec_for_profile(chrome_profile);
  const url =
    probe_url ||
    PLATFORM_PROBE_URLS[platform_key] ||
    PLATFORM_PROBE_URLS.youtube;
  const args = [
    "--cookies-from-browser",
    browser_spec,
    "--cookies",
    resolved_output,
    "--skip-download",
    "--no-warnings",
    "--playlist-end",
    "1",
    url,
  ];

  if (dry_run) {
    return {
      ok: true,
      dry_run: true,
      output_path: resolved_output,
      browser_spec,
      command: [yt_dlp_command, ...args],
    };
  }

  await fs.mkdir(path.dirname(resolved_output), { recursive: true });
  const result = await run_command(yt_dlp_command, args);
  const exists = await fs
    .access(resolved_output)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    return {
      ok: false,
      dry_run: false,
      output_path: resolved_output,
      browser_spec,
      command: [yt_dlp_command, ...args],
      error:
        result.stderr.trim() ||
        result.stdout.trim() ||
        "Cookie export did not create the cookies file.",
    };
  }

  return {
    ok: true,
    dry_run: false,
    output_path: resolved_output,
    browser_spec,
    command: [yt_dlp_command, ...args],
    warning: result.ok
      ? ""
      : result.stderr.trim() ||
        "yt-dlp exited non-zero but cookies file was written.",
  };
}

function parse_netscape_cookie_header(raw_text, domain_patterns) {
  const patterns = Array.isArray(domain_patterns) ? domain_patterns : [];
  const pairs = [];
  const seen = new Set();

  for (const line of String(raw_text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 7) continue;
    const domain = String(parts[0] || "")
      .trim()
      .toLowerCase()
      .replace(/^\./, "");
    const name = String(parts[5] || "").trim();
    const value = String(parts[6] || "").trim();
    if (!name) continue;
    const matches = patterns.some((pattern) => {
      const needle = String(pattern || "")
        .trim()
        .toLowerCase();
      if (!needle) return false;
      return domain === needle || domain.endsWith(`.${needle}`);
    });
    if (!matches) continue;
    const key = `${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(`${name}=${value}`);
  }

  return pairs.join("; ");
}

async function netscape_to_cookie_header(cookies_file, platform_key) {
  const raw_text = await fs.readFile(cookies_file, "utf8");
  const patterns = HOST_PATTERNS[platform_key] || [];
  return parse_netscape_cookie_header(raw_text, patterns);
}

async function cookies_file_has_hosts(cookies_file, platform_key) {
  try {
    const raw_text = await fs.readFile(cookies_file, "utf8");
    const patterns = HOST_PATTERNS[platform_key] || [];
    for (const line of raw_text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const parts = trimmed.split("\t");
      if (parts.length < 7) continue;
      const domain = String(parts[0] || "")
        .trim()
        .toLowerCase()
        .replace(/^\./, "");
      if (
        patterns.some((pattern) => {
          const needle = String(pattern || "")
            .trim()
            .toLowerCase();
          return domain === needle || domain.endsWith(`.${needle}`);
        })
      ) {
        return { ok: true, exists: true, has_hosts: true };
      }
    }
    return { ok: true, exists: true, has_hosts: false };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { ok: true, exists: false, has_hosts: false };
    }
    return { ok: false, exists: false, has_hosts: false, error: error.message };
  }
}

module.exports = {
  browser_spec_for_profile,
  export_netscape_cookies,
  parse_netscape_cookie_header,
  netscape_to_cookie_header,
  cookies_file_has_hosts,
  run_command,
};
