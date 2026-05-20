"use strict";

const fs = require("fs-extra");
const path = require("path");

const README_FILENAME = "README.md";

function readme_at_backup_root(backup_root) {
  return path.join(backup_root, README_FILENAME);
}

/**
 * Ensure backup root exists. README.md is maintained at the backup root
 * (default: iCloud .../config_base/__app_config_backup/README.md), not in the repo.
 * @param {string} backup_root
 * @param {{ debug?: boolean, dry_run?: boolean }} ctx
 */
function ensure_readme_at_backup_root(backup_root, ctx = {}) {
  const { dry_run = false } = ctx;
  if (dry_run) {
    return;
  }
  fs.ensureDirSync(backup_root);
}

module.exports = {
  ensure_readme_at_backup_root,
  readme_at_backup_root,
  README_FILENAME,
};
