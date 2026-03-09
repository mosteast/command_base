"use strict";

const fs = require("fs/promises");
const os = require("os");
const path = require("path");

function debug_log(logger, message) {
  if (!logger || typeof logger.debug !== "function") return;
  logger.debug(message);
}

async function path_exists(target_path) {
  try {
    await fs.access(target_path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function resolve_trash_directory(explicit_trash_dir = "") {
  if (explicit_trash_dir) {
    return path.resolve(String(explicit_trash_dir));
  }

  const env_trash_dir = process.env.COMMAND_BASE_TRASH_DIR;
  if (env_trash_dir) {
    return path.resolve(env_trash_dir);
  }

  const home_dir = os.homedir();
  if (!home_dir) {
    throw new Error("Cannot determine the home directory for Trash.");
  }

  if (process.platform === "darwin") {
    return path.join(home_dir, ".Trash");
  }

  if (process.platform === "linux") {
    return path.join(home_dir, ".local", "share", "Trash", "files");
  }

  throw new Error(
    `Moving files to Trash is not supported on platform: ${process.platform}`,
  );
}

function append_unique_suffix(file_path, suffix_text) {
  const parsed_path = path.parse(file_path);
  return path.join(
    parsed_path.dir,
    `${parsed_path.name}-${suffix_text}${parsed_path.ext}`,
  );
}

async function ensure_unique_path(base_path) {
  let candidate_path = base_path;
  let attempt = 0;

  while (await path_exists(candidate_path)) {
    attempt += 1;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    candidate_path = append_unique_suffix(
      base_path,
      `${timestamp}-${process.pid}-${attempt}`,
    );
  }

  return candidate_path;
}

async function move_to_trash(source_path, options = {}) {
  const { trash_dir: explicit_trash_dir = "", logger = null } = options;

  if (!source_path) {
    throw new Error("move_to_trash requires a source path.");
  }

  const resolved_source_path = path.resolve(String(source_path));
  const trash_dir = await resolve_trash_directory(explicit_trash_dir);
  debug_log(logger, `IO: mkdir ${trash_dir}`);
  await fs.mkdir(trash_dir, { recursive: true });

  const base_name = path.basename(resolved_source_path);
  const initial_target_path = path.join(trash_dir, base_name);
  const target_path = await ensure_unique_path(initial_target_path);

  try {
    debug_log(
      logger,
      `IO: rename ${resolved_source_path} -> ${target_path}`,
    );
    await fs.rename(resolved_source_path, target_path);
  } catch (error) {
    if (!error || error.code !== "EXDEV") {
      throw error;
    }

    debug_log(
      logger,
      `IO: copyFile ${resolved_source_path} -> ${target_path}`,
    );
    await fs.copyFile(resolved_source_path, target_path);
    debug_log(logger, `IO: unlink ${resolved_source_path}`);
    await fs.unlink(resolved_source_path);
  }

  return target_path;
}

module.exports = {
  move_to_trash,
  path_exists,
  resolve_trash_directory,
};
