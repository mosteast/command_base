"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const package_json = require("../../package.json");
const { Yaml_patch_error } = require("./error");
const { read_bounded_file } = require("./source");

const MAX_LOCK_BYTES = 16 * 1024;
const MAX_LOCK_MARKERS = 1024;

async function read_lock_details(lock_path) {
  try {
    const file = await read_bounded_file(lock_path, {
      max_file_bytes: MAX_LOCK_BYTES,
      allow_symbolic_link: false,
      file_type_error_code: "UNSAFE_CONCURRENCY",
      limit_error_code: "UNSAFE_CONCURRENCY",
      changed_error_code: "UNSAFE_CONCURRENCY",
    });
    return JSON.parse(file.buffer.toString("utf8"));
  } catch (error) {
    return { unreadable: true, message: error.message };
  }
}

async function publish_lock_record(lock_path, lock_data) {
  const pending_path = path.join(
    path.dirname(lock_path),
    `.yamlpatch-lock-pending-${crypto.randomUUID()}`,
  );
  let handle;
  try {
    handle = await fs.open(pending_path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(lock_data)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.link(pending_path, lock_path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(pending_path).catch(() => {});
  }
}

async function list_lock_markers(lock_path) {
  const directory_path = path.dirname(lock_path);
  const base_name = path.basename(lock_path);
  const prefixes = [`${base_name}.quarantine-`, `${base_name}.recovery-`];
  const marker_paths = [];
  let directory;
  try {
    directory = await fs.opendir(directory_path);
    for await (const entry of directory) {
      if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
      marker_paths.push(path.join(directory_path, entry.name));
      if (marker_paths.length > MAX_LOCK_MARKERS) {
        throw new Yaml_patch_error(
          "UNSAFE_CONCURRENCY",
          "Lock namespace contains too many recovery markers",
          { details: { lock_path, max_lock_markers: MAX_LOCK_MARKERS } },
        );
      }
    }
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  } finally {
    if (directory) await directory.close().catch(() => {});
  }
  return marker_paths.sort();
}

async function assert_lock_namespace_available(lock_path) {
  const marker_paths = await list_lock_markers(lock_path);
  if (marker_paths.length === 0) return;
  throw new Yaml_patch_error(
    "UNSAFE_CONCURRENCY",
    "Lock namespace is being recovered or released",
    {
      recoverable: true,
      next_action: "inspect the lock namespace and retry after recovery",
      details: {
        lock_path,
        marker_paths,
        marker: await read_lock_details(marker_paths[0]),
      },
    },
  );
}

async function existing_lock_paths(lock_path) {
  const paths = await list_lock_markers(lock_path);
  try {
    await fs.access(lock_path);
    paths.push(lock_path);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  return paths;
}

function assert_complete_lock(lock_path, lock) {
  if (!lock.token || !lock.hostname || !Number.isInteger(lock.pid)) {
    throw new Yaml_patch_error(
      "UNSAFE_CONCURRENCY",
      "Lock content is incomplete or unreadable",
      { details: { lock_path, lock } },
    );
  }
}

async function inspect_lock_namespace(lock_path, label) {
  const paths = await existing_lock_paths(lock_path);
  if (paths.length === 0) {
    throw new Yaml_patch_error("NO_MATCH", `${label} does not exist`, {
      recoverable: true,
      next_action: "no lock action is required",
      details: { lock_path },
    });
  }
  const inspected_path = paths[0];
  const lock = await read_lock_details(inspected_path);
  assert_complete_lock(inspected_path, lock);
  return {
    namespace_path: lock_path,
    lock_path: inspected_path,
    marker: inspected_path !== lock_path,
    lock,
  };
}

async function find_lock_record_by_token(
  lock_path,
  expected_token,
  options = {},
) {
  const excluded_paths = new Set(options.excluded_paths || []);
  for (const candidate_path of await existing_lock_paths(lock_path)) {
    if (excluded_paths.has(candidate_path)) continue;
    const lock = await read_lock_details(candidate_path);
    if (lock.token === expected_token) {
      assert_complete_lock(candidate_path, lock);
      return {
        namespace_path: lock_path,
        lock_path: candidate_path,
        marker: candidate_path !== lock_path,
        lock,
      };
    }
  }
  throw new Yaml_patch_error(
    "UNSAFE_CONCURRENCY",
    "Lock token does not match any record in the inspected namespace",
    { details: { lock_path, expected_token } },
  );
}

async function quarantine_owned_lock(lock_path, expected_token, reason) {
  const quarantine_path = `${lock_path}.quarantine-${reason}-${crypto.randomUUID()}`;
  try {
    await fs.rename(lock_path, quarantine_path);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Yaml_patch_error(
        "UNSAFE_CONCURRENCY",
        "Lock disappeared before token quarantine",
        { details: { lock_path, expected_token } },
      );
    }
    throw error;
  }
  const quarantined_lock = await read_lock_details(quarantine_path);
  if (quarantined_lock.token !== expected_token) {
    try {
      await fs.access(lock_path);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        await fs.rename(quarantine_path, lock_path);
      }
    }
    throw new Yaml_patch_error(
      "UNSAFE_CONCURRENCY",
      "Refusing to remove a quarantined lock owned by another token",
      {
        details: {
          lock_path,
          quarantine_path,
          expected_token,
          actual_token: quarantined_lock.token,
        },
      },
    );
  }
  await fs.unlink(quarantine_path);
  return quarantined_lock;
}

async function create_recovery_intent(lock_path, owner_path, options = {}) {
  const intent_path = `${lock_path}.recovery-${crypto.randomUUID()}`;
  const lock_data = {
    owner_path: path.resolve(owner_path),
    pid: process.pid,
    hostname: os.hostname(),
    token: crypto.randomUUID(),
    tool_version: options.tool_version || package_json.version,
    created_at: new Date().toISOString(),
    operation: options.operation || "recover-lock",
  };
  await publish_lock_record(intent_path, lock_data);
  return { lock_path: intent_path, token: lock_data.token, lock_data };
}

async function with_lock_recovery_intent(
  lock_path,
  owner_path,
  options,
  operation,
) {
  const intent = await create_recovery_intent(lock_path, owner_path, options);
  try {
    return await operation(intent);
  } finally {
    await quarantine_owned_lock(
      intent.lock_path,
      intent.token,
      "recovery-release",
    );
  }
}

function is_process_alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    if (error && error.code === "EPERM") return true;
    throw error;
  }
}

function assert_stale_lock(inspected, expected_token) {
  if (!expected_token || inspected.lock.token !== expected_token) {
    throw new Yaml_patch_error(
      "UNSAFE_CONCURRENCY",
      "Lock token does not match the explicitly inspected token",
      {
        details: {
          lock_path: inspected.lock_path,
          expected_token,
          actual_token: inspected.lock.token,
          lock: inspected.lock,
        },
      },
    );
  }
  if (inspected.lock.hostname !== os.hostname()) {
    throw new Yaml_patch_error(
      "UNSAFE_CONCURRENCY",
      "Cannot prove that a lock from another host is stale",
      { details: inspected },
    );
  }
  if (is_process_alive(inspected.lock.pid)) {
    throw new Yaml_patch_error(
      "UNSAFE_CONCURRENCY",
      `Lock owner process ${inspected.lock.pid} is still alive`,
      { details: inspected },
    );
  }
}

module.exports = {
  MAX_LOCK_BYTES,
  MAX_LOCK_MARKERS,
  assert_lock_namespace_available,
  assert_stale_lock,
  create_recovery_intent,
  find_lock_record_by_token,
  inspect_lock_namespace,
  is_process_alive,
  list_lock_markers,
  publish_lock_record,
  quarantine_owned_lock,
  read_lock_details,
  with_lock_recovery_intent,
};
