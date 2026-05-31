#!/usr/bin/env node

"use strict";

const fs = require("fs/promises");

const {
  build_download_report,
  compute_archive_line_delta,
  create_default_report_dir,
  parse_tool_output_file,
  read_archive_snapshot_file,
  write_download_report,
} = require("./index");

function read_arg_value(args, name, default_value = "") {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) return default_value;
  return args[index + 1];
}

function has_flag(args, name) {
  return args.includes(name);
}

function number_arg(args, name, default_value = 0) {
  const value = Number(read_arg_value(args, name, ""));
  return Number.isFinite(value) ? value : default_value;
}

async function read_json_file(file_path, fallback) {
  if (!file_path) return fallback;
  try {
    return JSON.parse(await fs.readFile(file_path, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function read_line_file(file_path) {
  if (!file_path) return [];
  try {
    return (await fs.readFile(file_path, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

function resolve_status({ dry_run, exit_code }) {
  if (dry_run) return "dry_run";
  return exit_code === 0 ? "completed" : "failed";
}

async function main() {
  const args = process.argv.slice(2);
  const tool_name = read_arg_value(args, "--tool-name");
  if (has_flag(args, "--print-default-report-dir")) {
    const batch_number = read_arg_value(args, "--batch-number");
    const options = batch_number ? { batch_number } : {};
    process.stdout.write(`${create_default_report_dir(tool_name, options)}\n`);
    return;
  }

  const report_dir = read_arg_value(args, "--report-dir");
  const tool_version = read_arg_value(args, "--tool-version", "unknown");
  const started_at = read_arg_value(args, "--started-at");
  const ended_at = read_arg_value(args, "--ended-at", new Date().toISOString());
  const exit_code = number_arg(args, "--exit-code", 0);
  const dry_run = has_flag(args, "--dry-run");
  const input_json_file = read_arg_value(args, "--input-json-file");
  const job_json_file = read_arg_value(args, "--job-json-file");
  const command_file = read_arg_value(args, "--command-file");
  const archive_snapshot_file = read_arg_value(args, "--archive-snapshot-file");
  const log_file = read_arg_value(args, "--log-file");
  const output_dir = read_arg_value(args, "--output-dir");
  const planned = number_arg(args, "--planned", 0);
  const executed = number_arg(args, "--executed", dry_run ? 0 : planned);
  const failed = number_arg(args, "--failed", exit_code === 0 ? 0 : 1);
  const aborted = number_arg(args, "--aborted", 0);

  const archive_summary = await compute_archive_line_delta(
    await read_archive_snapshot_file(archive_snapshot_file),
  );
  const output_summary = await parse_tool_output_file(log_file);
  const downloaded_count =
    archive_summary.delta_count > 0
      ? archive_summary.delta_count
      : dry_run
        ? 0
        : output_summary.output_download_marker_count;

  const report = build_download_report({
    tool_name,
    tool_version,
    status: resolve_status({ dry_run, exit_code }),
    started_at,
    ended_at,
    input: await read_json_file(input_json_file, {}),
    output: output_dir ? { directory: output_dir } : {},
    command: await read_line_file(command_file),
    summary: {
      total: planned,
      planned,
      executed,
      dry_run: dry_run ? planned || 1 : 0,
      failed,
      aborted,
      downloaded_count,
      skipped_count: output_summary.skipped_count,
      warning_count: output_summary.warning_count,
      error_count: output_summary.error_count,
      output_download_marker_count: output_summary.output_download_marker_count,
      archive_entry_before: archive_summary.before_count,
      archive_entry_after: archive_summary.after_count,
      archive_entry_delta: archive_summary.delta_count,
    },
    artifact: {
      archive_file: archive_summary.file,
      log_file: log_file || undefined,
    },
    job: await read_json_file(job_json_file, []),
  });

  await write_download_report(report_dir, report);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
