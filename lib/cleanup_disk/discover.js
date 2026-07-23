"use strict";

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { expand_home } = require("./resolve_target");
const { is_dangerous_path } = require("./path_guard");
const { parse_size } = require("./size");

const exec_file = promisify(execFile);

async function default_run_command(command, args) {
  const { stdout } = await exec_file(command, args, {
    maxBuffer: 20 * 1024 * 1024,
  });
  return String(stdout || "");
}

async function command_exists(command, run_command) {
  try {
    await run_command(command, ["--version"]);
    return true;
  } catch (_error) {
    try {
      await run_command("which", [command]);
      return true;
    } catch (_error2) {
      return false;
    }
  }
}

function parse_gdu_lines(stdout) {
  const items = [];
  for (const line of String(stdout).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([\d.]+)\s*([KMGTPE]?i?B?|[KMGTPE])\s+(.+)$/i.exec(trimmed);
    if (!match) continue;
    const size_text = `${match[1]}${normalize_unit(match[2])}`;
    let size_bytes = 0;
    try {
      size_bytes = parse_size(size_text);
    } catch (_error) {
      continue;
    }
    items.push({
      path: path.resolve(match[3].trim()),
      size_bytes,
      source: "gdu-go",
    });
  }
  return items;
}

function normalize_unit(unit) {
  const raw = String(unit || "").toUpperCase().replace(/IB$/, "").replace(/B$/, "");
  if (!raw) return "";
  return raw[0];
}

function parse_mdfind_lines(stdout, min_size_bytes) {
  return String(stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((entry) => ({
      path: path.resolve(entry),
      size_bytes: min_size_bytes,
      source: "mdfind",
    }));
}

function classify_path(target_path) {
  const base = path.basename(target_path);
  const lower = target_path.toLowerCase();

  if (base.endsWith(".hprof") || lower.endsWith(".hprof")) {
    return {
      kind: "artifact",
      risk: "low",
      action: "trash",
    };
  }

  if (/cache/i.test(target_path)) {
    return {
      kind: "cache",
      risk: "low",
      action: "trash",
    };
  }

  return {
    kind: "large_file",
    risk: "high",
    action: "report",
  };
}

function suggest_id(target_path, kind) {
  const base = path
    .basename(target_path)
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  if (kind === "cache") {
    return `cache_${base || "item"}`;
  }
  if (kind === "artifact") {
    return `artifact_${base || "item"}`;
  }
  return `large_${base || "item"}`;
}

function covered_by_existing(target_path, existing_paths) {
  return existing_paths.has(path.resolve(target_path));
}

function to_yaml_snippet(item) {
  const lines = [
    `  - id: ${item.suggested_id}`,
    `    path: "${item.path}"`,
    `    kind: ${item.kind}`,
    `    risk: ${item.risk}`,
    `    action: ${item.action}`,
    `    enabled: true`,
    `    note: "Suggested by discover"`,
  ];
  return lines.join("\n");
}

async function list_scan_roots(root) {
  // Avoid unbounded full-home gdu walks; scan known hotspot segments only.
  const segments = [path.join(root, "Library", "Caches")];
  for (const name of [".cache", ".npm", ".gradle", ".android", ".codex"]) {
    segments.push(path.join(root, name));
  }

  const existing = [];
  for (const segment of segments) {
    try {
      const stat = await fs.stat(segment);
      if (stat.isDirectory()) {
        existing.push(segment);
      }
    } catch (_error) {
      // skip missing segments
    }
  }

  // Fallback for fixtures / non-home roots with no hotspot subdirs.
  if (existing.length === 0) {
    existing.push(root);
  }

  return existing;
}

async function discover_hotspots({
  root = os.homedir(),
  home = null,
  top = 30,
  min_size_bytes = 1024 * 1024 * 1024,
  existing_rules = [],
  run_command = default_run_command,
} = {}) {
  const resolved_root = path.resolve(root);
  const resolved_home = home || resolved_root;
  const warnings = [];

  const existing_paths = new Set();
  for (const rule of existing_rules || []) {
    if (rule.path) {
      existing_paths.add(path.resolve(expand_home(rule.path, resolved_home)));
    }
    if (rule.glob) {
      existing_paths.add(path.resolve(expand_home(rule.glob, resolved_home)));
    }
  }

  const collected = [];
  const has_gdu = await command_exists("gdu-go", run_command);
  if (has_gdu) {
    const scan_roots = await list_scan_roots(resolved_root);
    // In unit tests, fs.stat will fail for fake roots; still run once on root.
    const targets = scan_roots.length > 0 ? scan_roots : [resolved_root];
    for (const segment of targets) {
      try {
        const stdout = await run_command("gdu-go", [
          "-n",
          "-p",
          "--si",
          "--depth",
          "1",
          segment,
        ]);
        collected.push(...parse_gdu_lines(stdout));
      } catch (error) {
        warnings.push(`gdu-go failed for ${segment}: ${error.message}`);
      }
    }
  } else {
    warnings.push("gdu-go not found; falling back to mdfind/du style discovery");
  }

  try {
    const stdout = await run_command("mdfind", [
      `kMDItemFSSize > ${min_size_bytes}`,
    ]);
    collected.push(...parse_mdfind_lines(stdout, min_size_bytes));
  } catch (error) {
    warnings.push(`mdfind failed: ${error.message}`);
  }

  const by_path = new Map();
  for (const item of collected) {
    if (!item.path) continue;
    if (item.path.endsWith(".app") || item.path.includes(".app/")) continue;
    if (is_dangerous_path(item.path, { home: resolved_home })) continue;
    if (covered_by_existing(item.path, existing_paths)) continue;
    if (!item.path.startsWith(resolved_root)) continue;

    const previous = by_path.get(item.path);
    if (!previous || item.size_bytes > previous.size_bytes) {
      by_path.set(item.path, item);
    }
  }

  const classified = Array.from(by_path.values())
    .map((item) => {
      const meta = classify_path(item.path);
      return {
        ...item,
        ...meta,
        suggested_id: suggest_id(item.path, meta.kind),
      };
    })
    .sort((a, b) => b.size_bytes - a.size_bytes)
    .slice(0, top);

  // Ensure unique suggested ids
  const used_ids = new Set();
  for (const item of classified) {
    let candidate = item.suggested_id;
    let index = 2;
    while (used_ids.has(candidate)) {
      candidate = `${item.suggested_id}_${index}`;
      index += 1;
    }
    item.suggested_id = candidate;
    used_ids.add(candidate);
  }

  return {
    items: classified,
    yaml_snippets: classified.map(to_yaml_snippet),
    warnings,
  };
}

module.exports = {
  discover_hotspots,
  parse_gdu_lines,
  classify_path,
  suggest_id,
};
