"use strict";

const chalk = require("chalk");
const { get_adapter } = require("./adapter");
const { run_check, create_logger } = require("./check_runner");
const { confirm_plan } = require("./confirm");
const {
  read_runtime_config,
  write_runtime_config,
  set_platform_runtime,
} = require("./runtime_config");
const { DEFAULT_RUNTIME_PATH } = require("./constants");

async function run_fix(options) {
  const logger = create_logger(options);
  logger.debug("Step: diagnose before fix");
  const diagnosis = await run_check({ ...options, offline: options.offline });

  const plan_lines = [
    chalk.cyanBright("Fix plan:"),
  ];
  const planned_platforms = [];

  for (const result of diagnosis.results) {
    const needs_work =
      result.status !== "ok" ||
      (result.profile_matches && result.profile_matches.length > 1);
    if (!needs_work && !options.force) {
      plan_lines.push(`- ${result.platform_key}: already ok (skip)`);
      continue;
    }
    planned_platforms.push(result);
    if (result.profile_matches && result.profile_matches.length > 1) {
      plan_lines.push(
        `- ${result.platform_key}: choose Chrome profile (candidates: ${result.profile_matches
          .map((item) => `${item.directory}/${item.name}`)
          .join(", ")}); with --yes use most recently used`,
      );
    } else if (result.selected_profile) {
      plan_lines.push(
        `- ${result.platform_key}: use Chrome profile ${result.selected_profile.directory}`,
      );
    } else {
      plan_lines.push(`- ${result.platform_key}: configure tools/cookies`);
    }
    if (result.next_command) {
      plan_lines.push(`  hinted: ${result.next_command}`);
    }
  }

  if (planned_platforms.length === 0) {
    logger.success("Nothing to fix; all selected platforms are ok.");
    return { exit_code: diagnosis.exit_code, diagnosis };
  }

  for (const line of plan_lines) logger.info(line);

  if (options.dry_run) {
    logger.info("Dry-run: no files written, no brew commands executed.");
    return { exit_code: 0, diagnosis, dry_run: true };
  }

  const confirmed = await confirm_plan(plan_lines, {
    yes: options.yes,
    dry_run: false,
  });
  if (!confirmed) {
    logger.warn("Fix cancelled.");
    return { exit_code: 1, diagnosis, cancelled: true };
  }

  let runtime = await read_runtime_config(
    options.runtime_path || DEFAULT_RUNTIME_PATH,
  );
  let runtime_data = runtime.data;
  let failed = 0;

  for (const result of planned_platforms) {
    logger.debug(`Step: fix ${result.platform_key}`);
    const adapter = get_adapter(result.platform_key);
    const context = {
      dry_run: false,
      offline: Boolean(options.offline),
      runtime_data,
      chrome_scans: diagnosis.chrome.scans || [],
      tool_options: options.tool_options || {},
      f2_options: options.f2_options || {},
    };
    const fix_result = await adapter.fix(context, result);
    for (const action of fix_result.actions || []) {
      const suffix = action.error ? ` (${action.error})` : "";
      if (action.ok) logger.success(`${result.platform_key}: ${action.detail}${suffix}`);
      else logger.error(`${result.platform_key}: ${action.detail}${suffix}`);
    }
    if (!fix_result.ok) {
      failed += 1;
      continue;
    }
    if (fix_result.runtime_patch && Object.keys(fix_result.runtime_patch).length > 0) {
      runtime_data = set_platform_runtime(
        runtime_data,
        result.platform_key,
        fix_result.runtime_patch,
      );
    }
  }

  const write_result = await write_runtime_config(runtime.path, runtime_data, {
    dry_run: false,
  });
  logger.success(`Runtime written: ${write_result.path}`);

  logger.info("Re-running check after fix...");
  const recheck = await run_check({ ...options, offline: options.offline });
  return {
    exit_code: failed > 0 || recheck.exit_code !== 0 ? 1 : 0,
    diagnosis,
    recheck,
    failed,
  };
}

module.exports = {
  run_fix,
};
