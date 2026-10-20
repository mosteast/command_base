"use strict";

const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { move_to_trash } = require("../file/trash");
const { assert_safe_path } = require("./path_guard");
const { default_get_size_bytes } = require("./resolve_target");

const exec_file = promisify(execFile);

async function read_available_bytes(probe_path) {
  // fs.statfs reports volume-level free space. Clean must prove it returned
  // bytes to the filesystem, because moving a target to Trash frees nothing.
  if (!probe_path) return null;
  try {
    const stats = await fs.statfs(probe_path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch (_error) {
    return null;
  }
}

async function measure_target_bytes(target_path, fallback_bytes) {
  try {
    const size_bytes = await default_get_size_bytes(target_path);
    if (size_bytes != null) return size_bytes;
  } catch (_error) {
    // fall through to the resolved size
  }
  return Number(fallback_bytes) || 0;
}

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
  { yes, dry_run, home, trash_dir, logger, fallback_size_bytes = 0 },
) {
  assert_safe_path(target_path, { home });

  const planned_size_bytes = Number(fallback_size_bytes) || 0;

  if (!yes) {
    return {
      status: "planned",
      path: target_path,
      size_bytes: planned_size_bytes,
    };
  }

  if (dry_run) {
    return {
      status: "dry_run",
      path: target_path,
      size_bytes: planned_size_bytes,
    };
  }

  const size_bytes = await measure_target_bytes(
    target_path,
    planned_size_bytes,
  );

  if (action === "trash") {
    await move_to_trash(target_path, { trash_dir, logger });
    return { status: "trashed", path: target_path, size_bytes };
  }

  if (action === "delete") {
    await fs.rm(target_path, { recursive: true, force: true });
    return { status: "deleted", path: target_path, size_bytes };
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
    probe_path = "",
    measure_free_space = true,
  } = {},
) {
  const results = [];
  let failed = 0;
  let deleted_bytes = 0;
  let trashed_bytes = 0;
  let delegated_count = 0;

  const free_before = measure_free_space
    ? await read_available_bytes(probe_path || home)
    : null;

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
          delegated_count += 1;
          results.push({
            rule_id: item.rule.id,
            status: outcome.status,
            detail: outcome.detail || "",
          });
        }
        continue;
      }

      // A glob rule holds the total across paths; split it evenly so each row
      // carries a comparable estimate until the real size is measured.
      const path_count = (item.paths || []).length;
      const fallback_size_bytes =
        path_count > 0 ? (Number(item.size_bytes) || 0) / path_count : 0;

      for (const target_path of item.paths || []) {
        const outcome = await execute_path_action(target_path, item.effective_action, {
          yes,
          dry_run,
          home,
          trash_dir,
          logger,
          fallback_size_bytes,
        });
        if (yes && !dry_run) {
          if (outcome.status === "deleted") {
            deleted_bytes += outcome.size_bytes || 0;
          }
          if (outcome.status === "trashed") {
            trashed_bytes += outcome.size_bytes || 0;
          }
        }
        results.push({
          rule_id: item.rule.id,
          status: outcome.status,
          path: outcome.path,
          size_bytes: outcome.size_bytes || 0,
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

  const free_after = measure_free_space
    ? await read_available_bytes(probe_path || home)
    : null;

  const freed_bytes =
    free_before != null && free_after != null
      ? Math.max(0, free_after - free_before)
      : null;

  return {
    results,
    exit_code: failed > 0 ? 1 : 0,
    deleted_bytes,
    trashed_bytes,
    delegated_count,
    freed_bytes,
  };
}

module.exports = {
  plan_clean,
  execute_clean,
};
