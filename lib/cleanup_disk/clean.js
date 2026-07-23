"use strict";

const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { move_to_trash } = require("../file/trash");
const { assert_safe_path } = require("./path_guard");

const exec_file = promisify(execFile);

function plan_clean(resolved_list, { action_override = null } = {}) {
  const plan = [];

  for (const resolved of resolved_list || []) {
    if (!resolved || !resolved.rule) {
      continue;
    }

    if (resolved.status === "missing" || resolved.status === "skipped_threshold") {
      continue;
    }

    const base_action = resolved.rule.action;
    if (base_action === "report") {
      continue;
    }

    let action = base_action;
    if (
      action_override &&
      (action_override === "trash" || action_override === "delete") &&
      (base_action === "trash" || base_action === "delete")
    ) {
      action = action_override;
    }

    plan.push({
      ...resolved,
      effective_action: action,
    });
  }

  return plan;
}

async function execute_delegate(item, { repo_bin_dir, dry_run, logger }) {
  const command_name = item.rule.delegate_to;
  if (!command_name) {
    throw new Error(`Delegate rule ${item.rule.id} missing delegate_to.`);
  }

  const command_path = path.join(repo_bin_dir, command_name);
  const args = Array.isArray(item.rule.delegate_args)
    ? [...item.rule.delegate_args]
    : [];

  if (logger && typeof logger.debug === "function") {
    logger.debug(`Delegate: ${command_path} ${args.join(" ")}`);
  }

  if (dry_run) {
    return { status: "dry_run", detail: `${command_name} ${args.join(" ")}` };
  }

  await exec_file(command_path, args, {
    maxBuffer: 10 * 1024 * 1024,
  });
  return { status: "delegated", detail: command_name };
}

async function execute_path_action(
  target_path,
  action,
  { yes, dry_run, home, trash_dir, logger },
) {
  assert_safe_path(target_path, { home });

  if (!yes) {
    return { status: "planned", path: target_path };
  }

  if (dry_run) {
    return { status: "dry_run", path: target_path };
  }

  if (action === "trash") {
    await move_to_trash(target_path, { trash_dir, logger });
    return { status: "trashed", path: target_path };
  }

  if (action === "delete") {
    await fs.rm(target_path, { recursive: true, force: true });
    return { status: "deleted", path: target_path };
  }

  throw new Error(`Unsupported clean action: ${action}`);
}

async function execute_clean(
  plan,
  {
    yes = false,
    dry_run = false,
    home,
    trash_dir = "",
    repo_bin_dir = "",
    logger = null,
  } = {},
) {
  const results = [];
  let failed = 0;

  for (const item of plan || []) {
    try {
      if (item.effective_action === "delegate" || item.rule.action === "delegate") {
        const outcome = await execute_delegate(item, {
          repo_bin_dir,
          dry_run: dry_run || !yes,
          logger,
        });
        if (!yes) {
          results.push({
            rule_id: item.rule.id,
            status: "planned",
            detail: outcome.detail || "",
          });
        } else {
          results.push({
            rule_id: item.rule.id,
            status: outcome.status,
            detail: outcome.detail || "",
          });
        }
        continue;
      }

      for (const target_path of item.paths || []) {
        const outcome = await execute_path_action(target_path, item.effective_action, {
          yes,
          dry_run,
          home,
          trash_dir,
          logger,
        });
        results.push({
          rule_id: item.rule.id,
          status: outcome.status,
          path: outcome.path,
        });
      }
    } catch (error) {
      failed += 1;
      results.push({
        rule_id: item.rule.id,
        status: "failed",
        detail: error.message || String(error),
      });
    }
  }

  return {
    results,
    exit_code: failed > 0 ? 1 : 0,
  };
}

module.exports = {
  plan_clean,
  execute_clean,
};
