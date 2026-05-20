"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const os = require("os");

const APP_KEY = "cursor";

/** @typedef {{ debug: boolean, quiet: boolean, dry_run: boolean, home_dir?: string, exec_cursor_list_extensions?: () => string, exec_cursor_install_extension?: (ext_id: string) => void }} App_config_ctx */

/**
 * Paths relative to user home to back up (files or directories).
 * Mirrors layout under the backup root so restore can copy back.
 */
const CURSOR_REL_PATHS = [
  path.join("Library", "Application Support", "Cursor", "User", "settings.json"),
  path.join("Library", "Application Support", "Cursor", "User", "keybindings.json"),
  path.join("Library", "Application Support", "Cursor", "User", "snippets"),
  path.join("Library", "Application Support", "Cursor", "User", "globalStorage"),
  path.join(".cursor", "extensions"),
  path.join(".cursor", "mcp.json"),
  path.join(".cursor", "argv.json"),
  path.join(".cursor", "skills-cursor"),
  path.join(".cursor", "plugins"),
];

const MANIFEST_NAME = "manifest.json";
const EXTENSIONS_LIST_FILE = "extensions.txt";
const CLI_VERSION = require("../../../package.json").version;

function home(ctx) {
  return path.resolve(ctx.home_dir || os.homedir());
}

function debug_log(ctx, msg) {
  if (ctx.debug) {
    console.error(`[DEBUG] ${msg}`);
  }
}

function copy_path(src, dst, ctx) {
  debug_log(ctx, `IO: copy ${src} -> ${dst}`);
  if (ctx.dry_run) {
    return;
  }
  fs.ensureDirSync(path.dirname(dst));
  fs.copySync(src, dst, { overwrite: true });
}

function copy_tree(src, dst, ctx) {
  debug_log(ctx, `IO: copy dir ${src} -> ${dst}`);
  if (ctx.dry_run) {
    return;
  }
  fs.ensureDirSync(path.dirname(dst));
  fs.copySync(src, dst, { overwrite: true });
}

function remove_path_if_present(target_path, ctx) {
  if (!fs.existsSync(target_path)) {
    return;
  }
  debug_log(ctx, `IO: remove ${target_path}`);
  if (ctx.dry_run) {
    return;
  }
  fs.removeSync(target_path);
}

function restore_file(src, dst, ctx) {
  if (fs.existsSync(dst) && fs.statSync(dst).isDirectory()) {
    remove_path_if_present(dst, ctx);
  }
  copy_path(src, dst, ctx);
}

function restore_tree(src, dst, ctx) {
  remove_path_if_present(dst, ctx);
  copy_tree(src, dst, ctx);
}

/**
 * @param {App_config_ctx} ctx
 * @returns {string}
 */
function list_extensions_via_cursor(ctx) {
  if (ctx.dry_run) {
    return "# dry-run: extension list not queried\n";
  }
  if (typeof ctx.exec_cursor_list_extensions === "function") {
    return ctx.exec_cursor_list_extensions();
  }
  try {
    return execFileSync("cursor", ["--list-extensions"], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e) {
    return `# cursor --list-extensions failed: ${e.message || e}\n`;
  }
}

/**
 * @param {App_config_ctx} ctx
 * @param {string} ext_id
 */
function install_extension(ctx, ext_id) {
  if (ctx.dry_run) {
    debug_log(ctx, `IO: would run cursor --install-extension ${ext_id}`);
    return;
  }
  if (typeof ctx.exec_cursor_install_extension === "function") {
    ctx.exec_cursor_install_extension(ext_id);
    return;
  }
  execFileSync("cursor", ["--install-extension", ext_id], {
    stdio: ctx.quiet ? "pipe" : "inherit",
  });
}

/**
 * @param {string} backup_dir
 * @param {App_config_ctx} ctx
 */
function backup(backup_dir, ctx) {
  debug_log(ctx, `stage: cursor backup -> ${backup_dir}`);
  const h = home(ctx);
  const included = [];
  const skipped_missing = [];

  for (const rel of CURSOR_REL_PATHS) {
    const src = path.join(h, rel);
    const dst = path.join(backup_dir, rel);
    if (!fs.existsSync(src)) {
      skipped_missing.push(rel);
      debug_log(ctx, `skip missing: ${src}`);
      continue;
    }
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      copy_tree(src, dst, ctx);
    } else {
      copy_path(src, dst, ctx);
    }
    included.push(rel);
  }

  debug_log(ctx, "stage: write extensions.txt");
  const ext_out = path.join(backup_dir, EXTENSIONS_LIST_FILE);
  const list_text = list_extensions_via_cursor(ctx);
  debug_log(ctx, `IO: write ${ext_out}`);
  if (!ctx.dry_run) {
    fs.writeFileSync(ext_out, list_text, "utf8");
  }

  const manifest = {
    app: APP_KEY,
    created_at: new Date().toISOString(),
    cli_version: CLI_VERSION,
    included_paths: included,
    paths_skipped_missing: skipped_missing,
  };
  const man_path = path.join(backup_dir, MANIFEST_NAME);
  debug_log(ctx, `IO: write ${man_path}`);
  if (!ctx.dry_run) {
    fs.writeJsonSync(man_path, manifest, { spaces: 2 });
  }

  return manifest;
}

/**
 * @param {string} backup_dir
 * @param {App_config_ctx} ctx
 */
function restore(backup_dir, ctx) {
  debug_log(ctx, `stage: cursor restore <- ${backup_dir}`);
  const h = home(ctx);
  const man_path = path.join(backup_dir, MANIFEST_NAME);
  if (!fs.existsSync(man_path)) {
    throw new Error(`missing ${MANIFEST_NAME} in ${backup_dir}`);
  }
  /** @type {{ included_paths?: string[] }} */
  const manifest = fs.readJsonSync(man_path);

  const paths =
    manifest.included_paths && manifest.included_paths.length
      ? manifest.included_paths
      : CURSOR_REL_PATHS;

  let had_extensions_dir = false;
  for (const rel of paths) {
    const src = path.join(backup_dir, rel);
    if (!fs.existsSync(src)) {
      debug_log(ctx, `restore skip not in backup: ${src}`);
      continue;
    }
    const dst = path.join(h, rel);
    const stat = fs.statSync(src);
    if (rel === path.join(".cursor", "extensions") && stat.isDirectory()) {
      had_extensions_dir = true;
    }
    if (stat.isDirectory()) {
      restore_tree(src, dst, ctx);
    } else {
      restore_file(src, dst, ctx);
    }
  }

  if (!had_extensions_dir) {
    const ext_file = path.join(backup_dir, EXTENSIONS_LIST_FILE);
    debug_log(
      ctx,
      "stage: extensions folder missing; reinstall from extensions.txt",
    );
    if (!fs.existsSync(ext_file)) {
      throw new Error(
        `missing ${EXTENSIONS_LIST_FILE} and .cursor/extensions in backup`,
      );
    }
    const raw = fs.readFileSync(ext_file, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    for (const ext_id of lines) {
      install_extension(ctx, ext_id);
    }
  }

  if (!ctx.quiet) {
    console.error(
      "\x1b[33mWarning: close Cursor before restoring if it is running; restart after restore.\x1b[0m",
    );
  }
}

module.exports = {
  APP_KEY,
  CURSOR_REL_PATHS,
  MANIFEST_NAME,
  EXTENSIONS_LIST_FILE,
  backup,
  restore,
};
