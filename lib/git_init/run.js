"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const {
  GITATTRIBUTES_TEMPLATE,
  GITIGNORE_TEMPLATE,
} = require("./templates");

const exec_file = promisify(execFile);

const METADATA_FILES = [
  [".gitignore", GITIGNORE_TEMPLATE],
  [".gitattributes", GITATTRIBUTES_TEMPLATE],
];

async function path_exists(target_path) {
  try {
    await fs.access(target_path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function default_run_git(args, cwd) {
  await exec_file("git", args, { cwd });
}

async function default_install_lfs({ cwd }) {
  await exec_file("git", ["lfs", "install", "--local"], { cwd });
}

async function run_git_init({
  cwd,
  force = false,
  dry_run = false,
  logger,
  run_git = default_run_git,
  install_lfs = default_install_lfs,
} = {}) {
  if (!cwd) throw new Error("cwd is required");
  if (!logger) throw new Error("logger is required");

  const created = [];
  const skipped = [];

  logger.debug(`stage: prepare git metadata in ${cwd}`);
  if (!dry_run) {
    logger.debug(`IO: mkdir ${cwd}`);
    await fs.mkdir(cwd, { recursive: true });
  }

  for (const [name, content] of METADATA_FILES) {
    const target = path.join(cwd, name);
    const exists = await path_exists(target);
    if (exists && !force) {
      logger.info(`skip existing ${name}`);
      skipped.push(name);
      continue;
    }

    logger.debug(`IO: write ${target}`);
    if (!dry_run) await fs.writeFile(target, content, "utf8");
    logger.success(`${exists ? "overwrite" : "write"} ${name}`);
    created.push(name);
  }

  const git_dir = path.join(cwd, ".git");
  const has_repo = await path_exists(git_dir);
  let initialized_repo = false;
  if (has_repo) {
    logger.info("skip git init; repository already exists");
  } else {
    logger.debug(`IO: git init -b main in ${cwd}`);
    if (!dry_run) await run_git(["init", "-b", "main"], cwd);
    logger.success("initialize git repository on branch main");
    initialized_repo = true;
  }

  if (!dry_run) {
    logger.debug(`IO: git lfs install --local in ${cwd}`);
    await install_lfs({ cwd });
    logger.success("install Git LFS hooks locally");
  }

  return { created, skipped, initialized_repo };
}

module.exports = {
  default_install_lfs,
  default_run_git,
  path_exists,
  run_git_init,
};
