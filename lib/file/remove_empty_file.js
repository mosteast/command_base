"use strict";

const fs = require("fs/promises");
const path = require("path");

function format_error_message(error) {
  if (!error) return "Unknown error";
  if (typeof error.message === "string" && error.message.trim())
    return error.message;
  return String(error);
}

function is_safe_cleanup_directory(target_dir) {
  const resolved_dir = path.resolve(String(target_dir || "").trim());
  if (!resolved_dir) return false;
  const root_dir = path.parse(resolved_dir).root;
  return resolved_dir !== root_dir;
}

async function remove_empty_files(target_dir, logger = {}) {
  const cleanup_directory = path.resolve(String(target_dir || "").trim());
  if (!cleanup_directory || !is_safe_cleanup_directory(cleanup_directory))
    return 0;

  const pending_directories = [cleanup_directory];
  let removed_count = 0;

  while (pending_directories.length > 0) {
    const current_directory = pending_directories.pop();
    if (!current_directory) continue;

    let entries = [];
    try {
      if (typeof logger.debug === "function")
        logger.debug(`IO: read directory ${current_directory}`);
      entries = await fs.readdir(current_directory, { withFileTypes: true });
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        if (typeof logger.warn === "function") {
          logger.warn(
            `Unable to read cleanup directory ${current_directory}: ${format_error_message(
              error,
            )}`,
          );
        }
      }
      continue;
    }

    for (const entry of entries) {
      const entry_path = path.join(current_directory, entry.name);

      if (entry.isDirectory()) {
        pending_directories.push(entry_path);
        continue;
      }

      if (!entry.isFile()) continue;

      let entry_stat;
      try {
        if (typeof logger.debug === "function")
          logger.debug(`IO: stat file ${entry_path}`);
        entry_stat = await fs.stat(entry_path);
      } catch (error) {
        if (!error || error.code !== "ENOENT") {
          if (typeof logger.warn === "function") {
            logger.warn(
              `Unable to inspect file ${entry_path}: ${format_error_message(error)}`,
            );
          }
        }
        continue;
      }

      if (entry_stat.size !== 0) continue;

      try {
        if (typeof logger.debug === "function")
          logger.debug(`IO: remove empty file ${entry_path}`);
        await fs.unlink(entry_path);
        removed_count += 1;
      } catch (error) {
        if (!error || error.code !== "ENOENT") {
          if (typeof logger.warn === "function") {
            logger.warn(
              `Unable to remove empty file ${entry_path}: ${format_error_message(
                error,
              )}`,
            );
          }
        }
      }
    }
  }

  return removed_count;
}

module.exports = {
  is_safe_cleanup_directory,
  remove_empty_files,
};
