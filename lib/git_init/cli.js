"use strict";

const path = require("node:path");
const chalk = require("chalk");
const package_json = require("../../package.json");
const { run_git_init } = require("./run");

function create_logger({ debug_mode = false, quiet_mode = false } = {}) {
  const color_enabled = process.env.FORCE_COLOR !== "0";
  const color_green = color_enabled ? chalk.green : (text) => text;
  const color_yellow = color_enabled ? chalk.yellow : (text) => text;
  const color_red = color_enabled ? chalk.red : (text) => text;
  const color_cyan = color_enabled ? chalk.cyan : (text) => text;

  return {
    info(message) {
      if (quiet_mode) return;
      console.log(color_green(message));
    },
    success(message) {
      if (quiet_mode) return;
      console.log(color_green(message));
    },
    warn(message) {
      console.warn(color_yellow(message));
    },
    error(message) {
      console.error(color_red(message));
    },
    debug(message) {
      if (!debug_mode || quiet_mode) return;
      console.log(color_cyan(`DEBUG ${message}`));
    },
  };
}

function build_help_text(command_name) {
  return `${command_name} - initialize a Git repository with Node, LFS, and editor ignores

Usage:
  $0 [directory] [options]

Description:
  Write .gitignore and .gitattributes, initialize a Git repository on branch
  main when one does not exist, and install Git LFS hooks locally.
  Existing git metadata files are left untouched unless --force is set.

Options:
  -h, --help              Show this help message and exit.
  -v, --version           Show the version number and exit.
  --debug                 Print verbose debug logs (default: false).
  --quiet                 Print only warnings and errors (default: false).
  -d, --dry-run           Print planned actions without writing (default: false).
  -f, --force             Overwrite existing .gitignore and .gitattributes (default: false).

Examples:
  # Initialize the current directory
  $0

  # Initialize a new or existing project directory
  $0 path/to/project

  # Preview files and git init without writing
  $0 --dry-run

  # Replace existing git metadata with the command templates
  $0 --force
`.replaceAll("$0", command_name);
}

function parse_args(argv) {
  const options = {
    directory: "",
    debug: false,
    quiet: false,
    dry_run: false,
    force: false,
    help: false,
    version: false,
  };

  const args = [...argv];
  for (const arg of args) {
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-v":
      case "--version":
        options.version = true;
        break;
      case "--debug":
        options.debug = true;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "-d":
      case "--dry-run":
        options.dry_run = true;
        break;
      case "-f":
      case "--force":
        options.force = true;
        break;
      default:
        if (String(arg).startsWith("-"))
          throw new Error(`Unknown option: ${arg}`);
        if (options.directory)
          throw new Error(`Unexpected argument: ${arg}`);
        options.directory = arg;
    }
  }

  return options;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parse_args(argv);
  } catch (error) {
    console.error(chalk.red(error.message || error));
    return 1;
  }

  const command_name = path.basename(process.argv[1] || "git_init");
  if (options.help) {
    console.log(build_help_text(command_name));
    return 0;
  }
  if (options.version) {
    console.log(package_json.version);
    return 0;
  }

  const logger = create_logger({
    debug_mode: options.debug,
    quiet_mode: options.quiet,
  });
  const cwd = path.resolve(process.cwd(), options.directory || ".");
  logger.debug(`stage: start git_init cwd=${cwd}`);

  try {
    const result = await run_git_init({
      cwd,
      force: options.force,
      dry_run: options.dry_run,
      logger,
    });
    logger.debug(
      `stage: done created=${result.created.join(",")} skipped=${result.skipped.join(",")}`,
    );
    return 0;
  } catch (error) {
    logger.error(error.message || error);
    if (options.debug && error && error.stack) console.error(error.stack);
    return 1;
  }
}

module.exports = {
  build_help_text,
  create_logger,
  main,
  parse_args,
};
