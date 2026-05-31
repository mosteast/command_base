"use strict";

const fs = require("fs/promises");
const path = require("path");

const SCHEMA_VERSION = 1;
const REPORT_JSON_NAME = "report.json";
const REPORT_MARKDOWN_NAME = "report.md";

const SUMMARY_FIELD_ORDER = [
  "total",
  "planned",
  "executed",
  "dry_run",
  "failed",
  "aborted",
  "skipped",
  "downloaded_count",
  "skipped_count",
  "warning_count",
  "error_count",
  "output_download_marker_count",
  "archive_entry_before",
  "archive_entry_after",
  "archive_entry_delta",
];

function require_non_empty_string(value, field_name) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error(`download report requires ${field_name}`);
  }
  return text;
}

function normalize_status(value) {
  const text = require_non_empty_string(value, "status");
  return text;
}

function normalize_timestamp(value, field_name) {
  const text = require_non_empty_string(value, field_name);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`download report requires a valid ${field_name}`);
  }
  return date.toISOString();
}

function normalize_object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}

function normalize_command(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }
  const text = String(value || "").trim();
  return text ? [text] : [];
}

function normalize_job(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  return [];
}

function normalize_summary(summary) {
  const result = {};
  const source = normalize_object(summary);
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value;
      continue;
    }
    if (typeof value === "boolean") {
      result[key] = value ? 1 : 0;
      continue;
    }
    if (value !== undefined && value !== null && value !== "") {
      result[key] = value;
    }
  }
  return result;
}

function build_download_report({
  tool_name,
  tool_version,
  status,
  started_at,
  ended_at,
  input,
  output,
  command,
  summary,
  artifact,
  job,
}) {
  const normalized_started_at = normalize_timestamp(started_at, "started_at");
  const normalized_ended_at = normalize_timestamp(ended_at, "ended_at");
  const duration_ms = Math.max(
    0,
    new Date(normalized_ended_at).getTime() -
      new Date(normalized_started_at).getTime(),
  );

  return {
    schema_version: SCHEMA_VERSION,
    tool_name: require_non_empty_string(tool_name, "tool_name"),
    tool_version: require_non_empty_string(tool_version, "tool_version"),
    status: normalize_status(status),
    started_at: normalized_started_at,
    ended_at: normalized_ended_at,
    duration_ms,
    input: normalize_object(input),
    output: normalize_object(output),
    command: normalize_command(command),
    summary: normalize_summary(summary),
    artifact: normalize_object(artifact),
    job: normalize_job(job),
  };
}

function format_markdown_value(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return `\`${JSON.stringify(value)}\``;
  return String(value).replace(/\|/g, "\\|");
}

function render_summary_table(summary) {
  const entries = [];
  const seen = new Set();
  for (const field_name of SUMMARY_FIELD_ORDER) {
    if (summary[field_name] === undefined) continue;
    entries.push([field_name, summary[field_name]]);
    seen.add(field_name);
  }
  for (const [field_name, value] of Object.entries(summary)) {
    if (seen.has(field_name)) continue;
    entries.push([field_name, value]);
  }
  if (entries.length === 0) return "_No summary fields._";
  return [
    "| Field | Value |",
    "| --- | ---: |",
    ...entries.map(
      ([field_name, value]) =>
        `| ${format_markdown_value(field_name)} | ${format_markdown_value(value)} |`,
    ),
  ].join("\n");
}

function render_json_block(title, value) {
  if (!value || (Array.isArray(value) && value.length === 0)) return "";
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    return "";
  }
  return [
    `## ${title}`,
    "",
    "```json",
    JSON.stringify(value, null, 2),
    "```",
  ].join("\n");
}

function render_download_report_markdown(report) {
  const sections = [
    `# ${report.tool_name} Download Report`,
    "",
    `- Status: ${report.status}`,
    `- Started: ${report.started_at}`,
    `- Ended: ${report.ended_at}`,
    `- Duration: ${report.duration_ms} ms`,
    "",
    "## Summary",
    "",
    render_summary_table(report.summary || {}),
  ];

  for (const [title, value] of [
    ["Input", report.input],
    ["Output", report.output],
    ["Command", report.command],
    ["Artifact", report.artifact],
    ["Job", report.job],
  ]) {
    const block = render_json_block(title, value);
    if (block) {
      sections.push("", block);
    }
  }

  return `${sections.join("\n")}\n`;
}

async function write_download_report(report_dir, report) {
  const resolved_report_dir = path.resolve(String(report_dir || "").trim());
  if (!resolved_report_dir) {
    throw new Error("download report requires report_dir");
  }

  await fs.mkdir(resolved_report_dir, { recursive: true });
  const json_path = path.join(resolved_report_dir, REPORT_JSON_NAME);
  const markdown_path = path.join(resolved_report_dir, REPORT_MARKDOWN_NAME);
  const report_to_write = {
    ...report,
    artifact: {
      ...(report.artifact || {}),
      report_json_path: json_path,
      report_markdown_path: markdown_path,
    },
  };

  await fs.writeFile(
    json_path,
    JSON.stringify(report_to_write, null, 2),
    "utf8",
  );
  await fs.writeFile(
    markdown_path,
    render_download_report_markdown(report_to_write),
    "utf8",
  );

  return { json_path, markdown_path, report: report_to_write };
}

function count_lines(text) {
  if (!text) return 0;
  return String(text)
    .split(/\r?\n/)
    .filter((line) => line.trim()).length;
}

async function count_file_lines(file_path) {
  if (!file_path) return 0;
  try {
    const text = await fs.readFile(file_path, "utf8");
    return count_lines(text);
  } catch (error) {
    if (error && error.code === "ENOENT") return 0;
    throw error;
  }
}

async function compute_archive_line_delta(snapshot_list) {
  const file = [];
  let before_count = 0;
  let after_count = 0;
  let delta_count = 0;

  for (const snapshot of Array.isArray(snapshot_list) ? snapshot_list : []) {
    if (!snapshot || !snapshot.path) continue;
    const archive_path = String(snapshot.path);
    const before = Number(snapshot.before_count) || 0;
    const after = await count_file_lines(archive_path);
    const delta = after - before;
    before_count += before;
    after_count += after;
    delta_count += delta;
    file.push({
      path: archive_path,
      before_count: before,
      after_count: after,
      delta_count: delta,
    });
  }

  return {
    before_count,
    after_count,
    delta_count,
    file,
  };
}

async function read_archive_snapshot_file(snapshot_file) {
  if (!snapshot_file) return [];
  let text = "";
  try {
    text = await fs.readFile(snapshot_file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [archive_path, before_count_text = "0"] = line.split("\t");
      return {
        path: archive_path,
        before_count: Number(before_count_text) || 0,
      };
    });
}

function parse_tool_output_summary(output_text) {
  const lines = String(output_text || "").split(/\r?\n/);
  let warning_count = 0;
  let error_count = 0;
  let skipped_count = 0;
  let output_download_marker_count = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (/\bwarning\b|^\s*warn(?:ing)?:/i.test(line)) {
      warning_count += 1;
    }
    if (/\berror\b|^\s*error:/i.test(line)) {
      error_count += 1;
    }
    if (
      /already in archive|has already been downloaded|skipping|skip download|no-overwrites/i.test(
        line,
      )
    ) {
      skipped_count += 1;
    }
    if (/\[download\]/i.test(line)) {
      output_download_marker_count += 1;
    }
  }

  return {
    warning_count,
    error_count,
    skipped_count,
    output_download_marker_count,
  };
}

async function parse_tool_output_file(log_file) {
  if (!log_file) return parse_tool_output_summary("");
  try {
    const text = await fs.readFile(log_file, "utf8");
    return parse_tool_output_summary(text);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return parse_tool_output_summary("");
    }
    throw error;
  }
}

function sanitize_report_path_component(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return text || "run";
}

function create_default_report_dir(
  tool_name,
  now = new Date(),
  pid = process.pid,
) {
  const home_dir = process.env.HOME || process.cwd();
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return path.join(
    home_dir,
    ".command_base",
    "report",
    sanitize_report_path_component(tool_name),
    `${timestamp}_${pid}`,
  );
}

module.exports = {
  REPORT_JSON_NAME,
  REPORT_MARKDOWN_NAME,
  SCHEMA_VERSION,
  build_download_report,
  compute_archive_line_delta,
  count_file_lines,
  create_default_report_dir,
  parse_tool_output_file,
  parse_tool_output_summary,
  read_archive_snapshot_file,
  render_download_report_markdown,
  sanitize_report_path_component,
  write_download_report,
};
