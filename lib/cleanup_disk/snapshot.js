"use strict";

const fs = require("fs/promises");
const path = require("path");

const snapshot_version = 1;
const default_keep = 90;

function to_file_date(date) {
  return date.toISOString().slice(0, 10);
}

function snapshot_file_name(date = new Date()) {
  return `snapshot-${to_file_date(date)}.json`;
}

function build_snapshot({ resolved_list, now = Date.now() } = {}) {
  const by_path = new Map();

  for (const resolved of resolved_list || []) {
    const rule = resolved.rule || {};
    for (const target_path of resolved.paths || []) {
      const previous = by_path.get(target_path);
      const size_bytes = Number(resolved.size_bytes) || 0;
      if (previous) {
        previous.size_bytes += size_bytes;
        continue;
      }
      by_path.set(target_path, {
        path: target_path,
        rule_id: rule.id || "",
        size_bytes,
      });
    }
  }

  const items = Array.from(by_path.values()).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  const total_bytes = items.reduce((sum, item) => sum + item.size_bytes, 0);

  return {
    version: snapshot_version,
    created_at: new Date(now).toISOString(),
    total_bytes,
    items,
  };
}

async function write_snapshot(snapshot_dir, snapshot) {
  await fs.mkdir(snapshot_dir, { recursive: true });
  const file_path = path.join(
    snapshot_dir,
    snapshot_file_name(new Date(snapshot.created_at)),
  );
  await fs.writeFile(file_path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return file_path;
}

async function list_snapshot_files(snapshot_dir) {
  let entries = [];
  try {
    entries = await fs.readdir(snapshot_dir);
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }

  return entries
    .filter((name) => /^snapshot-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .map((name) => path.join(snapshot_dir, name));
}

async function read_snapshot(file_path) {
  const text = await fs.readFile(file_path, "utf8");
  const parsed = JSON.parse(text);
  if (!parsed || parsed.version !== snapshot_version) {
    throw new Error(`Unsupported snapshot version in ${file_path}`);
  }
  if (!Array.isArray(parsed.items)) {
    throw new Error(`Snapshot has no items: ${file_path}`);
  }
  return parsed;
}

function parse_since(text, now = Date.now()) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const relative = /^(\d+)\s*d$/i.exec(raw);
  if (relative) {
    return now - Number(relative[1]) * 24 * 60 * 60 * 1000;
  }

  const absolute = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (absolute) {
    const parsed = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid --since date: ${raw}`);
    }
    return parsed.getTime();
  }

  throw new Error(`Invalid --since value: ${raw} (use 30d or 2026-09-20)`);
}

async function load_baseline(snapshot_dir, { since_ms = null } = {}) {
  const files = await list_snapshot_files(snapshot_dir);
  if (files.length === 0) return null;

  const snapshots = [];
  for (const file_path of files) {
    try {
      const snapshot = await read_snapshot(file_path);
      const created_ms = new Date(snapshot.created_at).getTime();
      if (Number.isNaN(created_ms)) continue;
      snapshots.push({ file_path, snapshot, created_ms });
    } catch (_error) {
      // Skip unreadable snapshots instead of failing the whole diff.
    }
  }

  if (snapshots.length === 0) return null;
  snapshots.sort((a, b) => a.created_ms - b.created_ms);

  if (since_ms == null) {
    // diff without --since compares against the oldest snapshot on disk.
    return snapshots[0];
  }

  const before_cutoff = snapshots.filter((entry) => entry.created_ms <= since_ms);
  if (before_cutoff.length === 0) {
    return snapshots[0];
  }
  return before_cutoff[before_cutoff.length - 1];
}

function diff_snapshots(previous, current) {
  const previous_by_path = new Map();
  for (const item of (previous && previous.items) || []) {
    previous_by_path.set(item.path, Number(item.size_bytes) || 0);
  }

  const rows = [];
  const seen = new Set();

  for (const item of (current && current.items) || []) {
    const current_bytes = Number(item.size_bytes) || 0;
    const previous_bytes = previous_by_path.get(item.path) || 0;
    seen.add(item.path);
    rows.push({
      path: item.path,
      rule_id: item.rule_id || "",
      previous_bytes,
      current_bytes,
      delta_bytes: current_bytes - previous_bytes,
    });
  }

  for (const [target_path, previous_bytes] of previous_by_path) {
    if (seen.has(target_path)) continue;
    const previous_item = previous.items.find((item) => item.path === target_path);
    rows.push({
      path: target_path,
      rule_id: previous_item ? previous_item.rule_id : "",
      previous_bytes,
      current_bytes: 0,
      delta_bytes: -previous_bytes,
    });
  }

  return rows.sort((a, b) => Math.abs(b.delta_bytes) - Math.abs(a.delta_bytes));
}

async function prune_snapshots(snapshot_dir, keep = default_keep) {
  if (!Number.isFinite(keep) || keep <= 0) return [];
  const files = await list_snapshot_files(snapshot_dir);
  if (files.length <= keep) return [];

  const removable = files.slice(0, files.length - keep);
  for (const file_path of removable) {
    await fs.rm(file_path, { force: true });
  }
  return removable;
}

function format_delta(bytes) {
  const value = Number(bytes) || 0;
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const units = ["B", "K", "M", "G", "T"];
  let scaled = abs;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  const digits = index === 0 || scaled >= 10 ? 0 : 1;
  return `${sign}${scaled.toFixed(digits)}${units[index]}`;
}

module.exports = {
  snapshot_version,
  build_snapshot,
  write_snapshot,
  list_snapshot_files,
  read_snapshot,
  load_baseline,
  diff_snapshots,
  prune_snapshots,
  parse_since,
  format_delta,
  snapshot_file_name,
};
