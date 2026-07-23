"use strict";

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { glob } = require("glob");
const { parse_size } = require("./size");
const { assert_safe_path } = require("./path_guard");

const exec_file = promisify(execFile);

function expand_home(raw_path, home) {
  const text = String(raw_path);
  if (text === "~") {
    return home;
  }
  if (text.startsWith("~/")) {
    return path.join(home, text.slice(2));
  }
  return text;
}

async function path_exists(target_path) {
  try {
    await fs.access(target_path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function size_via_du(target_path) {
  // Prefer du -sk for speed on large trees; fall back to Node walk in tests/odd hosts.
  try {
    const { stdout } = await exec_file("du", ["-sk", target_path], {
      maxBuffer: 1024 * 1024,
    });
    const match = /^(\d+)/.exec(String(stdout).trim());
    if (!match) {
      throw new Error("Unexpected du output");
    }
    return Number(match[1]) * 1024;
  } catch (_error) {
    return null;
  }
}

async function size_via_walk(target_path) {
  const stat = await fs.lstat(target_path);
  if (!stat.isDirectory()) {
    return stat.size;
  }

  let total = 0;
  const entries = await fs.readdir(target_path, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(target_path, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      total += await size_via_walk(child);
    } else if (entry.isFile()) {
      const child_stat = await fs.stat(child);
      total += child_stat.size;
    }
  }
  return total;
}

async function default_get_size_bytes(target_path) {
  const from_du = await size_via_du(target_path);
  if (from_du != null) {
    return from_du;
  }
  return size_via_walk(target_path);
}

async function expand_rule_paths(rule, home) {
  if (rule.action === "delegate" || rule.kind === "delegate") {
    return [];
  }

  if (rule.path && rule.glob) {
    throw new Error(`Rule ${rule.id} must not set both path and glob.`);
  }

  if (rule.path) {
    return [path.resolve(expand_home(rule.path, home))];
  }

  if (rule.glob) {
    const pattern = expand_home(rule.glob, home);
    const matches = await glob(pattern, {
      nodir: false,
      dot: true,
      absolute: true,
    });
    return matches.map((entry) => path.resolve(entry));
  }

  throw new Error(`Rule ${rule.id} requires path or glob.`);
}

async function resolve_rule(
  rule,
  {
    home = os.homedir(),
    now = Date.now(),
    get_size_bytes = default_get_size_bytes,
  } = {},
) {
  if (rule.action === "delegate" || rule.kind === "delegate") {
    return {
      rule,
      paths: [],
      status: "delegate",
      size_bytes: 0,
      notes: rule.note || "",
    };
  }

  const candidates = await expand_rule_paths(rule, home);
  const existing = [];

  for (const candidate of candidates) {
    assert_safe_path(candidate, { home });
    if (await path_exists(candidate)) {
      existing.push(candidate);
    }
  }

  if (existing.length === 0) {
    return {
      rule,
      paths: [],
      status: "missing",
      size_bytes: 0,
      notes: rule.note || "",
    };
  }

  let size_bytes = 0;
  for (const target of existing) {
    size_bytes += await get_size_bytes(target);
  }

  if (rule.min_size) {
    const min_bytes = parse_size(rule.min_size);
    if (size_bytes < min_bytes) {
      return {
        rule,
        paths: existing,
        status: "skipped_threshold",
        size_bytes,
        notes: rule.note || "",
      };
    }
  }

  if (rule.min_age) {
    const match = /^(\d+)\s*d$/i.exec(String(rule.min_age).trim());
    if (!match) {
      throw new Error(`Invalid min_age for rule ${rule.id}: ${rule.min_age}`);
    }
    const min_age_ms = Number(match[1]) * 24 * 60 * 60 * 1000;
    let newest_mtime = 0;
    for (const target of existing) {
      const stat = await fs.stat(target);
      newest_mtime = Math.max(newest_mtime, stat.mtimeMs);
    }
    if (now - newest_mtime < min_age_ms) {
      return {
        rule,
        paths: existing,
        status: "skipped_threshold",
        size_bytes,
        notes: rule.note || "",
      };
    }
  }

  return {
    rule,
    paths: existing,
    status: "ok",
    size_bytes,
    notes: rule.note || "",
  };
}

module.exports = {
  resolve_rule,
  expand_home,
  default_get_size_bytes,
};
