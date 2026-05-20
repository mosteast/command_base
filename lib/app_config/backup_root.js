"use strict";

const fs = require("fs-extra");
const path = require("path");
const os = require("os");

const DEFAULT_REL_SEGMENTS = [
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
  "main",
  "config_base",
  "__app_config_backup",
];

function get_backup_root(override_root) {
  const from_env =
    override_root !== undefined
      ? override_root
      : process.env.APP_CONFIG_BACKUP_ROOT;
  if (from_env && String(from_env).trim()) {
    return path.resolve(String(from_env).trim());
  }
  return path.join(os.homedir(), ...DEFAULT_REL_SEGMENTS);
}

function app_dir_under_root(backup_root, app_name) {
  return path.join(backup_root, app_name);
}

function is_numeric_dir_name(name) {
  return /^\d+$/.test(name);
}

/**
 * @param {string} app_dir - Absolute path to .../__app_config_backup/<APP>
 * @returns {number[]}
 */
function list_numeric_ids(app_dir) {
  if (!fs.existsSync(app_dir)) {
    return [];
  }
  const entries = fs.readdirSync(app_dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && is_numeric_dir_name(e.name))
    .map((e) => Number.parseInt(e.name, 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}

/**
 * @param {string} app_dir
 * @returns {number}
 */
function next_id(app_dir) {
  const ids = list_numeric_ids(app_dir);
  const max = ids.length ? Math.max(...ids) : 0;
  return max + 1;
}

/**
 * @param {string} app_dir
 * @param {number | undefined} explicit_id
 * @returns {number}
 */
function resolve_restore_id(app_dir, explicit_id) {
  const ids = list_numeric_ids(app_dir);
  if (!ids.length) {
    throw new Error(`no numeric backup id found under ${app_dir}`);
  }
  if (explicit_id !== undefined && explicit_id !== null) {
    const n = Number(explicit_id);
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
      throw new Error(`invalid backup id: ${explicit_id}`);
    }
    if (!ids.includes(n)) {
      throw new Error(`backup id ${n} not found (have: ${ids.join(", ")})`);
    }
    return n;
  }
  return Math.max(...ids);
}

/**
 * @param {string} app_dir
 * @param {number} id
 * @returns {string}
 */
function id_backup_dir(app_dir, id) {
  return path.join(app_dir, String(id));
}

/**
 * @param {string} backup_root
 * @param {string} app_name
 * @param {number} id
 */
function backup_snapshot_dir(backup_root, app_name, id) {
  return id_backup_dir(app_dir_under_root(backup_root, app_name), id);
}

module.exports = {
  get_backup_root,
  app_dir_under_root,
  list_numeric_ids,
  next_id,
  resolve_restore_id,
  id_backup_dir,
  backup_snapshot_dir,
  is_numeric_dir_name,
};
