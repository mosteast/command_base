"use strict";

const fs = require("fs/promises");
const path = require("path");

const MAX_CONCURRENCY = 8;
const DEFAULT_CONCURRENCY = 2;

function normalize_concurrency(raw_value) {
  if (!Number.isFinite(raw_value)) {
    return DEFAULT_CONCURRENCY;
  }
  const normalized = Math.floor(raw_value);
  if (Number.isNaN(normalized)) {
    return DEFAULT_CONCURRENCY;
  }
  return Math.max(1, Math.min(normalized, MAX_CONCURRENCY));
}

async function build_synthesis_jobs(options) {
  const { input_files, output_dir, audio_format, force, model_id, cwd } =
    options;

  const effective_cwd = cwd || process.cwd();
  const jobs = [];

  for (const absolute_path of input_files) {
    const relative_input_path =
      path.relative(effective_cwd, absolute_path) ||
      path.basename(absolute_path);
    const parsed_path = path.parse(absolute_path);
    const destination_dir = output_dir || parsed_path.dir;
    const sanitized_model = model_id.replace(/[^a-z0-9]+/gi, "-");
    const output_file_path = path.join(
      destination_dir,
      `${parsed_path.name}.${sanitized_model}.${audio_format}`,
    );

    let skip_reason = null;
    if (!force) {
      const already_exists = await file_exists(output_file_path);
      if (already_exists) {
        skip_reason = "existing output";
      }
    }

    jobs.push({
      absolute_input_path: absolute_path,
      relative_input_path,
      output_file_path,
      skip_reason,
    });
  }

  return jobs;
}

async function file_exists(file_path) {
  try {
    await fs.access(file_path);
    return true;
  } catch (error) {
    return false;
  }
}

function parse_additional_options(raw_options) {
  if (!raw_options) {
    return undefined;
  }
  try {
    return JSON.parse(raw_options);
  } catch (error) {
    const sanitized_message = error.message || "unknown error";
    throw new Error(
      `Failed to parse additional options JSON: ${sanitized_message}`,
    );
  }
}

module.exports = {
  normalize_concurrency,
  build_synthesis_jobs,
  parse_additional_options,
};
