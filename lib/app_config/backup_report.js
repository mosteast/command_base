"use strict";

const fs = require("fs-extra");
const path = require("path");

const REPORT_NAME = "report.json";
const SCHEMA_VERSION = 1;

function require_non_empty_string(value, field_name) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error(`backup report requires ${field_name}`);
  }
  return text;
}

function normalize_app_version(value) {
  const text = String(value || "").trim();
  return text || "unknown";
}

function require_backup_id(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error(`backup report requires a positive integer backup_id`);
  }
  return id;
}

function require_utc_timestamp(value) {
  const timestamp = require_non_empty_string(value, "backup_timestamp");
  if (!/Z$/.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`backup report requires a UTC backup_timestamp`);
  }
  return timestamp;
}

function count_array(value) {
  return Array.isArray(value) ? value.length : undefined;
}

function set_optional_integer(target, field_name, value) {
  if (Number.isInteger(value) && value >= 0) {
    target[field_name] = value;
  }
}

function build_backup_report({
  app_name,
  app_version,
  backup_id,
  backup_timestamp,
  tool_name,
  tool_version,
  status = "completed",
  provider_manifest,
  included_paths,
  paths_skipped_missing,
}) {
  const report = {
    schema_version: SCHEMA_VERSION,
    app_name: require_non_empty_string(app_name, "app_name"),
    app_version: normalize_app_version(app_version),
    backup_id: require_backup_id(backup_id),
    backup_timestamp: require_utc_timestamp(backup_timestamp),
    tool_name: require_non_empty_string(tool_name, "tool_name"),
    tool_version: require_non_empty_string(tool_version, "tool_version"),
    status: require_non_empty_string(status, "status"),
  };

  if (provider_manifest) {
    report.provider_manifest = provider_manifest;
  }
  set_optional_integer(
    report,
    "included_path_count",
    count_array(included_paths),
  );
  set_optional_integer(
    report,
    "skipped_missing_path_count",
    count_array(paths_skipped_missing),
  );

  return report;
}

function write_backup_report(snapshot_dir, report, ctx = {}) {
  const report_path = path.join(snapshot_dir, REPORT_NAME);
  if (ctx.debug) {
    console.error(`[DEBUG] IO: write ${report_path}`);
  }
  if (!ctx.dry_run) {
    fs.writeJsonSync(report_path, report, { spaces: 2 });
  }
  return report_path;
}

module.exports = {
  REPORT_NAME,
  SCHEMA_VERSION,
  build_backup_report,
  write_backup_report,
};
