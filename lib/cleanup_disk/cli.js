"use strict";

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { load_config } = require("./config");
const { filter_rules } = require("./filter");
const { resolve_rule } = require("./resolve_target");
const { plan_clean, execute_clean } = require("./clean");
const { discover_hotspots } = require("./discover");
const { format_size, parse_size } = require("./size");

const script_version = "1.0.0";

function create_logger({ debug_mode = false, quiet_mode = false, force_color = true } = {}) {
  const color_enabled = force_color && process.env.FORCE_COLOR !== "0";
  const color_green = color_enabled ? "\u001b[32m" : "";
  const color_yellow = color_enabled ? "\u001b[33m" : "";
  const color_blue = color_enabled ? "\u001b[34m" : "";
  const color_red = color_enabled ? "\u001b[31m" : "";
  const color_reset = color_enabled ? "\u001b[0m" : "";

  return {
    info(message) {
      if (quiet_mode) return;
      console.log(`${color_green}${message}${color_reset}`);
    },
    warn(message) {
      console.warn(`${color_yellow}${message}${color_reset}`);
    },
    error(message) {
      console.error(`${color_red}${message}${color_reset}`);
    },
    debug(message) {
      if (!debug_mode) return;
      console.log(`${color_blue}DEBUG ${message}${color_reset}`);
    },
  };
}

function print_help(command_name) {
  console.log(`${command_name} - rule-driven macOS disk cleanup orchestrator

Usage:
  $0 report [options]
  $0 discover [options]
  $0 clean [options]

Description:
  Report disk hotspots from a maintainable YAML rule list, discover new
  candidates with gdu-go/mdfind, and clean only after an explicit --yes.

Options:
  -h, --help              Show this help message and exit.
  -v, --version           Show the version number and exit.
  --debug                 Print verbose debug logs (default: false).
  --quiet                 Print only warnings and errors (default: false).
  -d, --dry-run           Print planned actions without executing them (default: false).
  --config <path>         Extra YAML config merged over defaults/local.
  --rule <id>             Only include this rule id (repeatable).
  --kind <k>              Filter by kind: cache|temp|artifact|large_file|delegate.
  --risk <r>              Risk ceiling: low|medium|high.
                          report default: high (all). clean default: low.
  --min-size <s>          Minimum size threshold override (e.g. 100M, 1G).
  --yes                   Required for real clean mutation (default: false).
  --action trash|delete   Override mutable rule actions during clean.
  --top <n>               Discover: max items to show (default: 30).
  --root <path>           Discover: scan root (default: $HOME).

Examples:
  # Daily inspection of all enabled rules
  $0 report

  # Discover hotspots and print suggested YAML snippets
  $0 discover --root ~ --top 40

  # Preview cleaning low-risk caches only
  $0 clean --risk low --kind cache

  # Apply low-risk cache cleanup after review
  $0 clean --risk low --kind cache --yes

  # Report a single rule
  $0 report --rule jetbrains_cache --debug
`.replaceAll("$0", command_name));
}

function parse_args(argv) {
  const options = {
    subcommand: "report",
    debug: false,
    quiet: false,
    dry_run: false,
    yes: false,
    config: "",
    rule_ids: [],
    kind: null,
    risk: null,
    min_size: null,
    action: null,
    top: 30,
    root: "",
    help: false,
    version: false,
  };

  const args = [...argv];
  if (args.length === 0) {
    return options;
  }

  const first = args[0];
  if (first === "report" || first === "discover" || first === "clean") {
    options.subcommand = first;
    args.shift();
  } else if (first === "-h" || first === "--help") {
    options.help = true;
    return options;
  } else if (first === "-v" || first === "--version") {
    options.version = true;
    return options;
  } else if (!String(first).startsWith("-")) {
    throw new Error(`Unknown subcommand: ${first}`);
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
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
      case "--yes":
        options.yes = true;
        break;
      case "--config":
        options.config = require_value(args, ++i, arg);
        break;
      case "--rule":
        options.rule_ids.push(require_value(args, ++i, arg));
        break;
      case "--kind":
        options.kind = require_value(args, ++i, arg);
        break;
      case "--risk":
        options.risk = require_value(args, ++i, arg);
        break;
      case "--min-size":
        options.min_size = require_value(args, ++i, arg);
        break;
      case "--action":
        options.action = require_value(args, ++i, arg);
        if (options.action !== "trash" && options.action !== "delete") {
          throw new Error(`Invalid --action: ${options.action}`);
        }
        break;
      case "--top":
        options.top = Number(require_value(args, ++i, arg));
        if (!Number.isFinite(options.top) || options.top <= 0) {
          throw new Error(`Invalid --top: ${options.top}`);
        }
        break;
      case "--root":
        options.root = require_value(args, ++i, arg);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function require_value(args, index, flag) {
  if (index >= args.length) {
    throw new Error(`Missing value for ${flag}`);
  }
  return args[index];
}

function resolve_repo_paths(env) {
  const lib_dir = path.resolve(__dirname);
  const repo_root = path.resolve(lib_dir, "../..");
  const defaults_path =
    env.COMMAND_BASE_CLEANUP_DISK_DEFAULTS ||
    path.join(repo_root, "config/cleanup_disk/defaults.yaml");
  const local_path =
    env.COMMAND_BASE_CLEANUP_DISK_LOCAL ||
    path.join(repo_root, "config/cleanup_disk/local.yaml");
  return {
    repo_root,
    repo_bin_dir: path.join(repo_root, "bin"),
    defaults_path,
    local_path,
  };
}

async function resolve_all_rules(rules, { home, min_size_override, logger }) {
  const resolved = [];
  for (const rule of rules) {
    const rule_copy = { ...rule };
    if (min_size_override) {
      rule_copy.min_size = min_size_override;
    }
    logger.debug(`Resolving rule ${rule_copy.id}`);
    resolved.push(await resolve_rule(rule_copy, { home }));
  }
  return resolved;
}

async function run_report(options, context) {
  const { logger, home, paths } = context;
  const risk_ceiling = options.risk || "high";
  logger.debug("Loading config");
  const config = await load_config({
    defaults_path: paths.defaults_path,
    local_path: paths.local_path,
    extra_path: options.config || "",
  });

  const filtered = filter_rules(config.rule, {
    rule_ids: options.rule_ids,
    kind: options.kind,
    risk_ceiling,
  });

  logger.info(`cleanup_disk report (rules=${filtered.length})`);
  const resolved = await resolve_all_rules(filtered, {
    home,
    min_size_override: options.min_size,
    logger,
  });

  let total_bytes = 0;
  let reclaimable_bytes = 0;

  for (const item of resolved) {
    total_bytes += item.size_bytes || 0;
    if (item.rule.action !== "report" && item.status === "ok") {
      reclaimable_bytes += item.size_bytes || 0;
    }
    logger.info(
      [
        `id=${item.rule.id}`,
        `kind=${item.rule.kind}`,
        `risk=${item.rule.risk}`,
        `action=${item.rule.action}`,
        `status=${item.status}`,
        `size=${format_size(item.size_bytes || 0)}`,
        item.paths[0] ? `path=${item.paths[0]}` : "",
        item.notes ? `note=${item.notes}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  logger.info(
    `Total matched: ${format_size(total_bytes)}; reclaimable(non-report ok): ${format_size(reclaimable_bytes)}`,
  );
  return 0;
}

async function run_discover(options, context) {
  const { logger, home, paths } = context;
  const root = options.root
    ? options.root.replace(/^~(?=$|\/)/, home)
    : home;
  const min_size_bytes = options.min_size
    ? parse_size(options.min_size)
    : 1024 * 1024 * 1024;

  logger.debug("Loading config for dedupe");
  const config = await load_config({
    defaults_path: paths.defaults_path,
    local_path: paths.local_path,
    extra_path: options.config || "",
  });

  logger.debug(`Discovering under ${root}`);
  const result = await discover_hotspots({
    root,
    home,
    top: options.top,
    min_size_bytes,
    existing_rules: config.rule,
  });

  for (const warning of result.warnings || []) {
    logger.warn(warning);
  }

  logger.info(`Discover candidates: ${result.items.length}`);
  for (const item of result.items) {
    logger.info(
      `${format_size(item.size_bytes)} ${item.kind}/${item.action} ${item.path} -> ${item.suggested_id}`,
    );
  }

  if (result.yaml_snippets.length > 0) {
    logger.info("Suggested YAML snippets:");
    console.log(result.yaml_snippets.join("\n\n"));
  }

  return 0;
}

async function run_clean(options, context) {
  const { logger, home, paths } = context;
  const risk_ceiling = options.risk || "low";

  logger.debug("Loading config");
  const config = await load_config({
    defaults_path: paths.defaults_path,
    local_path: paths.local_path,
    extra_path: options.config || "",
  });

  const filtered = filter_rules(config.rule, {
    rule_ids: options.rule_ids,
    kind: options.kind,
    risk_ceiling,
  });

  const resolved = await resolve_all_rules(filtered, {
    home,
    min_size_override: options.min_size,
    logger,
  });

  const plan = plan_clean(resolved, { action_override: options.action });
  logger.info(`Clean plan (${plan.length} rule(s), yes=${options.yes}, dry_run=${options.dry_run})`);

  for (const item of plan) {
    logger.info(
      `plan id=${item.rule.id} action=${item.effective_action} size=${format_size(item.size_bytes || 0)} paths=${(item.paths || []).join(",") || "(delegate)"}`,
    );
  }

  const outcome = await execute_clean(plan, {
    yes: options.yes,
    dry_run: options.dry_run,
    home,
    trash_dir: process.env.COMMAND_BASE_TRASH_DIR || "",
    repo_bin_dir: paths.repo_bin_dir,
    logger,
  });

  for (const row of outcome.results) {
    logger.info(
      [
        `result id=${row.rule_id}`,
        `status=${row.status}`,
        row.path ? `path=${row.path}` : "",
        row.detail ? `detail=${row.detail}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  if (!options.yes) {
    logger.warn("No mutation performed. Re-run with --yes to apply.");
  }

  return outcome.exit_code;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const command_name = path.basename(env.COMMAND_BASE_CLEANUP_DISK_NAME || "cleanup_disk");
  let options;

  try {
    options = parse_args(argv);
  } catch (error) {
    console.error(error.message || String(error));
    return 1;
  }

  if (options.version) {
    console.log(script_version);
    return 0;
  }

  if (options.help) {
    print_help(command_name);
    return 0;
  }

  const logger = create_logger({
    debug_mode: options.debug,
    quiet_mode: options.quiet,
  });

  const paths = resolve_repo_paths(env);
  const home =
    env.COMMAND_BASE_CLEANUP_DISK_HOME || env.HOME || os.homedir();

  const context = { logger, home, paths };

  try {
    if (options.subcommand === "report") {
      return await run_report(options, context);
    }
    if (options.subcommand === "discover") {
      return await run_discover(options, context);
    }
    if (options.subcommand === "clean") {
      return await run_clean(options, context);
    }
    logger.error(`Unknown subcommand: ${options.subcommand}`);
    return 1;
  } catch (error) {
    logger.error(error.message || String(error));
    if (options.debug && error.stack) {
      logger.debug(error.stack);
    }
    return 1;
  }
}

module.exports = {
  main,
  parse_args,
  print_help,
};
