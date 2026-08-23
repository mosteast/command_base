"use strict";

const fs = require("fs/promises");
const path = require("path");
const YAML = require("yaml");
const chalk = require("chalk");
const { get_adapter } = require("./adapter");
const { scan_chrome_hosts } = require("./chrome_profile");
const {
  DEFAULT_CONFIG_PATH,
  DEFAULT_F2_OUTPUT_DIR,
  DEFAULT_RUNTIME_PATH,
  PLATFORM_HANDLE_BASE_URLS,
} = require("./constants");
const {
  expand_user_path,
  read_runtime_config,
} = require("./runtime_config");
const { ensure_writable_dir } = require("./confirm");
const { normalize_platform_key } = require("./platform");

function normalize_handle_to_url(raw_handle, platform_key) {
  const handle_text = String(raw_handle || "").trim();
  if (!handle_text) return "";
  if (/^https?:\/\//i.test(handle_text)) return handle_text;
  const base_url = PLATFORM_HANDLE_BASE_URLS[platform_key];
  if (!base_url) return "";
  const normalized_handle = handle_text.replace(/^@+/, "").replace(/^\/+/, "");
  return `${base_url}${normalized_handle}`;
}

function create_logger({ quiet_mode, debug_mode, command_name = "gather doctor" }) {
  const prefix = chalk.dim(command_name);
  return {
    info(message) {
      if (quiet_mode) return;
      console.log(`${prefix} ${chalk.cyanBright(message)}`);
    },
    success(message) {
      if (quiet_mode) return;
      console.log(`${prefix} ${chalk.greenBright(message)}`);
    },
    warn(message) {
      console.warn(`${prefix} ${chalk.yellowBright(message)}`);
    },
    error(message) {
      console.error(`${prefix} ${chalk.redBright(message)}`);
    },
    debug(message) {
      if (!debug_mode || quiet_mode) return;
      console.log(`${prefix} ${chalk.gray(`[debug] ${message}`)}`);
    },
  };
}

async function load_probe_urls_from_config(config_path, logger) {
  const resolved = path.resolve(expand_user_path(config_path || DEFAULT_CONFIG_PATH));
  const probe_urls = {};
  try {
    logger.debug(`IO: read gather config ${resolved}`);
    const raw_text = await fs.readFile(resolved, "utf8");
    const parsed = YAML.parse(raw_text) || {};
    const source = parsed.source || {};
    for (const [raw_key, items] of Object.entries(source)) {
      const platform_key = normalize_platform_key(raw_key);
      if (!platform_key) continue;
      if (!Array.isArray(items) || items.length === 0) continue;
      const handle = String((items[0] && (items[0].handle || items[0].url)) || "").trim();
      if (!handle) continue;
      const probe_url = normalize_handle_to_url(handle, platform_key);
      if (probe_url) probe_urls[platform_key] = probe_url;
    }
    return { config_path: resolved, probe_urls, ok: true };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        config_path: resolved,
        probe_urls,
        ok: false,
        error: `gather config missing: ${resolved}`,
      };
    }
    return {
      config_path: resolved,
      probe_urls,
      ok: false,
      error: error.message,
    };
  }
}

function print_platform_report(result, logger) {
  const color =
    result.status === "ok"
      ? chalk.greenBright
      : result.status === "warn"
        ? chalk.yellowBright
        : chalk.redBright;
  logger.info(`${color(result.status.toUpperCase())} ${result.platform_key}`);
  for (const check of result.checks || []) {
    const check_color =
      check.status === "ok"
        ? chalk.green
        : check.status === "warn"
          ? chalk.yellow
          : chalk.red;
    logger.info(`  - ${check_color(check.status)} ${check.name}: ${check.message}`);
  }
  if (result.next_command) {
    logger.info(`  next: ${chalk.magentaBright(result.next_command)}`);
  }
}

async function run_check(options) {
  const logger = create_logger(options);
  logger.debug("Step: load runtime");
  const runtime = await read_runtime_config(
    options.runtime_path || DEFAULT_RUNTIME_PATH,
  );

  logger.debug("Step: scan Chrome profiles");
  const chrome = await scan_chrome_hosts({
    chrome_profile: options.chrome_profile || "",
    chrome_user_data_dir: options.chrome_user_data_dir || "",
  });
  if (chrome.error) logger.warn(chrome.error);
  for (const scan of chrome.scans || []) {
    if (scan.locked) {
      logger.warn(
        `Chrome Cookies locked for ${scan.directory}. Quit Chrome and retry if host scan is incomplete.`,
      );
    }
  }

  logger.debug("Step: load gather config probe urls");
  const config_info = await load_probe_urls_from_config(options.config_path, logger);
  if (!config_info.ok) logger.warn(config_info.error);

  logger.debug("Step: check output directories");
  const f2_dir = await ensure_writable_dir(
    options.f2_output_dir || DEFAULT_F2_OUTPUT_DIR,
  );
  if (!f2_dir.ok) {
    logger.warn(`f2 output dir not writable: ${f2_dir.path} (${f2_dir.error})`);
  }

  const context = {
    offline: Boolean(options.offline),
    dry_run: Boolean(options.dry_run),
    runtime_data: runtime.data,
    runtime_path: runtime.path,
    chrome_scans: chrome.scans || [],
    probe_urls: config_info.probe_urls,
    tool_options: options.tool_options || {},
    f2_options: options.f2_options || {},
  };

  const results = [];
  for (const platform_key of options.platforms) {
    logger.debug(`Step: check ${platform_key}`);
    const adapter = get_adapter(platform_key);
    const result = await adapter.check(context);
    print_platform_report(result, logger);
    results.push(result);
  }

  const failed = results.filter((item) => item.status === "fail").length;
  const warned = results.filter((item) => item.status === "warn").length;
  logger.info(
    `Summary: platforms=${results.length} fail=${failed} warn=${warned}`,
  );

  return {
    results,
    failed,
    warned,
    runtime,
    chrome,
    config_info,
    exit_code: failed > 0 ? 1 : 0,
  };
}

module.exports = {
  create_logger,
  load_probe_urls_from_config,
  normalize_handle_to_url,
  run_check,
  print_platform_report,
};
