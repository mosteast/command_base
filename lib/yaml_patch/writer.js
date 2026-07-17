"use strict";

const crypto = require("node:crypto");
const child_process = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");

const package_json = require("../../package.json");
const { Yaml_patch_error } = require("./error");
const { run_isolated_yaml_action } = require("./isolated");
const {
  assert_lock_namespace_available,
  assert_stale_lock,
  find_lock_record_by_token,
  inspect_lock_namespace,
  is_process_alive,
  publish_lock_record,
  quarantine_owned_lock,
  read_lock_details,
  with_lock_recovery_intent,
} = require("./lock");
const { read_bounded_file, sha256_digest } = require("./source");

const exec_file = util.promisify(child_process.execFile);

const LOCAL_FILE_SYSTEM_TYPES = Object.freeze({
  darwin: new Set([0x1a, 0x17]),
  linux: new Set([
    0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630, 0x2fc12fc1,
    0xf2f52010,
  ]),
});

function debug_log(options, message) {
  if (options && typeof options.debug === "function") options.debug(message);
}

function get_writer_capabilities(options = {}) {
  const platform = options.platform || process.platform;
  const write = platform === "linux" || platform === "darwin";
  return {
    platform,
    inspect: true,
    find: true,
    extract: true,
    dry_run: true,
    write,
    atomic_visibility: write,
    cooperative_conflict_detection: write,
    crash_durability: write ? "file-and-directory-fsync-when-supported" : false,
    preserves_mode: write,
    preserves_owner_group: write,
    rejects_symbolic_links: write,
    rejects_multiple_hard_links: write,
    rejects_extended_metadata: write,
    preserves_extended_attributes: platform === "darwin",
    metadata_detection: write ? "best-effort-native-tools" : false,
    file_system_policy: write ? "verified-local-allowlist" : false,
  };
}

function lock_path_for(source_path) {
  const absolute_path = path.resolve(source_path);
  return path.join(
    path.dirname(absolute_path),
    `.${path.basename(absolute_path)}.yaml_patch.lock`,
  );
}

function management_guard_path_for(source_path) {
  return `${lock_path_for(source_path)}.guard`;
}

async function create_lock_record(lock_path, lock_data, held_message) {
  await assert_lock_namespace_available(lock_path);
  try {
    await publish_lock_record(lock_path, lock_data);
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw new Yaml_patch_error("UNSAFE_CONCURRENCY", held_message, {
        recoverable: true,
        next_action: "inspect the lock and retry after its owner completes",
        details: { lock_path, lock: await read_lock_details(lock_path) },
      });
    }
    throw error;
  }
  const lock = { lock_path, token: lock_data.token, lock_data };
  try {
    await assert_lock_namespace_available(lock_path);
    return lock;
  } catch (error) {
    await quarantine_owned_lock(lock_path, lock_data.token, "contended-create");
    throw error;
  }
}

function create_lock_data(source_path, options = {}) {
  const token = crypto.randomUUID();
  return {
    source_path: path.resolve(source_path),
    pid: process.pid,
    hostname: os.hostname(),
    token,
    tool_version: options.tool_version || package_json.version,
    created_at: new Date().toISOString(),
    operation: options.operation || "write",
  };
}

async function acquire_management_guard(source_path, options = {}) {
  const guard_path = management_guard_path_for(source_path);
  const guard_data = create_lock_data(source_path, {
    ...options,
    operation: options.operation || "manage-lock",
  });
  return create_lock_record(
    guard_path,
    guard_data,
    `Another process is managing ${lock_path_for(source_path)}`,
  );
}

async function release_management_guard(guard) {
  await quarantine_owned_lock(guard.lock_path, guard.token, "guard-release");
}

async function with_management_guard(source_path, options, operation) {
  const guard = await acquire_management_guard(source_path, options);
  try {
    if (typeof options.on_management_guard === "function") {
      await options.on_management_guard({ guard });
    }
    return await operation();
  } finally {
    await release_management_guard(guard);
  }
}

async function acquire_file_lock(source_path, options = {}) {
  const absolute_source_path = path.resolve(source_path);
  return with_management_guard(
    absolute_source_path,
    { ...options, operation: "acquire-lock" },
    async () => {
      const lock_path = lock_path_for(absolute_source_path);
      const lock_data = create_lock_data(absolute_source_path, options);
      return create_lock_record(
        lock_path,
        lock_data,
        `A cooperative writer already holds ${lock_path}`,
      );
    },
  );
}

async function release_file_lock(lock, options = {}) {
  const source_path = lock.lock_data && lock.lock_data.source_path;
  if (!source_path) {
    throw new Yaml_patch_error(
      "UNSAFE_CONCURRENCY",
      "Lock record has no source path for guarded release",
    );
  }
  return with_management_guard(
    source_path,
    { ...options, operation: "release-lock" },
    () => quarantine_owned_lock(lock.lock_path, lock.token, "release"),
  );
}

async function inspect_file_lock(source_path) {
  return inspect_lock_namespace(
    lock_path_for(source_path),
    "Source cooperative lock",
  );
}

async function inspect_management_guard(source_path) {
  return inspect_lock_namespace(
    management_guard_path_for(source_path),
    "Source lock management guard",
  );
}

async function break_stale_file_lock(source_path, options = {}) {
  return with_management_guard(
    source_path,
    { ...options, operation: "break-stale-lock" },
    async () => {
      const expected_token = options.expected_token;
      const inspected = await find_lock_record_by_token(
        lock_path_for(source_path),
        expected_token,
      );
      assert_stale_lock(inspected, expected_token);
      await quarantine_owned_lock(
        inspected.lock_path,
        expected_token,
        "stale-break",
      );
      return { ...inspected, removed: true };
    },
  );
}

async function break_stale_management_guard(source_path, options = {}) {
  const expected_token = options.expected_token;
  const guard_path = management_guard_path_for(source_path);
  return with_lock_recovery_intent(
    guard_path,
    source_path,
    { ...options, operation: "break-stale-guard" },
    async (intent) => {
      const inspected = await find_lock_record_by_token(
        guard_path,
        expected_token,
        { excluded_paths: [intent.lock_path] },
      );
      assert_stale_lock(inspected, expected_token);
      if (typeof options.after_recovery_inspection === "function") {
        await options.after_recovery_inspection({ inspected, intent });
      }
      await quarantine_owned_lock(
        inspected.lock_path,
        expected_token,
        "stale-guard-break",
      );
      return { ...inspected, removed: true };
    },
  );
}

async function assert_local_file_system(source_path, options = {}) {
  const platform = options.platform || process.platform;
  const allowed_types = LOCAL_FILE_SYSTEM_TYPES[platform];
  if (!allowed_types) {
    throw new Yaml_patch_error(
      "ATOMIC_WRITE_UNAVAILABLE",
      `No local filesystem allowlist is available for ${platform}`,
    );
  }
  if (!options.file_system_stats && typeof fs.statfs !== "function") {
    throw new Yaml_patch_error(
      "ATOMIC_WRITE_UNAVAILABLE",
      "The platform cannot identify the source filesystem",
    );
  }
  const stats =
    options.file_system_stats ||
    (await fs.statfs(path.dirname(path.resolve(source_path))));
  const normalized_type = Number(stats.type) >>> 0;
  if (!allowed_types.has(normalized_type)) {
    throw new Yaml_patch_error(
      "ATOMIC_WRITE_UNAVAILABLE",
      "Source filesystem is not in the verified local allowlist",
      {
        details: {
          platform,
          file_system_type: normalized_type,
          allowed_file_system_types: Array.from(allowed_types),
        },
      },
    );
  }
  return stats;
}

async function run_optional_metadata_command(command, args) {
  try {
    const result = await exec_file(command, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return { available: true, stdout: result.stdout || "" };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { available: false, stdout: "" };
    }
    throw new Yaml_patch_error(
      "ATOMIC_WRITE_UNAVAILABLE",
      `Cannot inspect source metadata with ${command}`,
      { cause: error, details: { command } },
    );
  }
}

function extended_acl_lines(acl_text) {
  return acl_text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !line.startsWith("#") &&
        !["user::", "group::", "other::"].some((prefix) =>
          line.startsWith(prefix),
        ),
    );
}

async function detect_unsupported_metadata(source_path, options = {}) {
  const platform = options.platform || process.platform;
  const extended_attribute_names = [];
  const access_control_entries = [];
  const detection = { extended_attributes: false, access_control_list: false };
  const copy_support = {
    extended_attributes: false,
    access_control_list: false,
  };

  if (platform === "darwin") {
    const xattr = await run_optional_metadata_command("xattr", [source_path]);
    detection.extended_attributes = xattr.available;
    copy_support.extended_attributes = xattr.available;
    extended_attribute_names.push(
      ...xattr.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const acl = await run_optional_metadata_command("ls", [
      "-lde",
      source_path,
    ]);
    detection.access_control_list = acl.available;
    const acl_lines = acl.stdout.split(/\r?\n/);
    const mode = (acl_lines[0] || "").trim().split(/\s+/)[0] || "";
    if (mode.endsWith("+")) {
      access_control_entries.push(
        ...acl_lines
          .slice(1)
          .map((line) => line.trim())
          .filter(Boolean),
      );
    }
  } else if (platform === "linux") {
    const xattr = await run_optional_metadata_command("getfattr", [
      "--absolute-names",
      "--dump",
      source_path,
    ]);
    detection.extended_attributes = xattr.available;
    extended_attribute_names.push(
      ...xattr.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => line.split("=", 1)[0]),
    );
    const acl = await run_optional_metadata_command("getfacl", [
      "--absolute-names",
      "--omit-header",
      source_path,
    ]);
    detection.access_control_list = acl.available;
    access_control_entries.push(...extended_acl_lines(acl.stdout));
  }

  return {
    extended_attribute_names,
    access_control_entries,
    detection,
    copy_support,
  };
}

async function copy_supported_metadata(source_path, target_path, metadata) {
  if (
    !metadata ||
    !metadata.copy_support ||
    !metadata.copy_support.extended_attributes
  ) {
    return;
  }
  for (const attribute_name of metadata.extended_attribute_names || []) {
    let attribute;
    try {
      attribute = await exec_file(
        "xattr",
        ["-px", attribute_name, source_path],
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      );
      const hex_value = (attribute.stdout || "").replace(/\s+/g, "");
      await exec_file(
        "xattr",
        ["-wx", attribute_name, hex_value, target_path],
        {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        },
      );
    } catch (error) {
      throw new Yaml_patch_error(
        "ATOMIC_WRITE_UNAVAILABLE",
        `Cannot preserve extended attribute ${attribute_name}`,
        { cause: error, details: { attribute_name } },
      );
    }
  }
}

async function assert_write_target(source_path, options = {}) {
  const capabilities = get_writer_capabilities(options);
  if (!capabilities.write) {
    throw new Yaml_patch_error(
      "ATOMIC_WRITE_UNAVAILABLE",
      `Atomic write is unavailable on ${capabilities.platform}`,
      { details: { capabilities } },
    );
  }
  const absolute_path = path.resolve(source_path);
  let stats;
  try {
    stats = await fs.lstat(absolute_path);
  } catch (error) {
    throw new Yaml_patch_error(
      "UNSUPPORTED_FILE_TYPE",
      `Cannot inspect write target: ${absolute_path}`,
      { cause: error },
    );
  }
  if (stats.isSymbolicLink()) {
    throw new Yaml_patch_error(
      "UNSUPPORTED_FILE_TYPE",
      "Symbolic links are read-only in the first version",
      { details: { path: absolute_path, file_type: "symbolic-link" } },
    );
  }
  if (!stats.isFile() || stats.nlink !== 1) {
    throw new Yaml_patch_error(
      "UNSUPPORTED_FILE_TYPE",
      "Write target must be one regular file with exactly one hard link",
      {
        details: {
          path: absolute_path,
          is_regular_file: stats.isFile(),
          hard_link_count: stats.nlink,
        },
      },
    );
  }
  const file_system = await assert_local_file_system(absolute_path, options);
  const metadata_detector =
    options.metadata_detector || detect_unsupported_metadata;
  const unsupported_metadata = await metadata_detector(absolute_path, options);
  const cannot_copy_extended_attributes =
    unsupported_metadata.extended_attribute_names.length > 0 &&
    !(unsupported_metadata.copy_support || {}).extended_attributes;
  const cannot_copy_access_control_list =
    unsupported_metadata.access_control_entries.length > 0 &&
    !(unsupported_metadata.copy_support || {}).access_control_list;
  if (cannot_copy_extended_attributes || cannot_copy_access_control_list) {
    throw new Yaml_patch_error(
      "UNSUPPORTED_FILE_TYPE",
      "Source has extended metadata that the atomic writer cannot preserve",
      {
        details: { path: absolute_path, unsupported_metadata },
        next_action:
          "remove the metadata or use a future explicit downgrade mode",
      },
    );
  }
  return {
    absolute_path,
    stats,
    file_system,
    capabilities,
    metadata: unsupported_metadata,
  };
}

async function sync_parent_directory(directory_path) {
  let directory_handle;
  try {
    directory_handle = await fs.open(directory_path, "r");
    await directory_handle.sync();
    return true;
  } catch (error) {
    if (["EINVAL", "ENOTSUP", "EISDIR"].includes(error && error.code)) {
      return false;
    }
    throw error;
  } finally {
    if (directory_handle) await directory_handle.close().catch(() => {});
  }
}

async function verify_source_unchanged(source_path, source, expected_stats) {
  const current_file = await read_bounded_file(source_path, {
    max_file_bytes:
      source.size_bytes === undefined ? expected_stats.size : source.size_bytes,
    allow_symbolic_link: false,
    file_type_error_code: "SOURCE_CHANGED",
    limit_error_code: "SOURCE_CHANGED",
    changed_error_code: "SOURCE_CHANGED",
  });
  const current_stats = current_file.stats;
  if (
    current_stats.dev !== expected_stats.dev ||
    current_stats.ino !== expected_stats.ino ||
    current_stats.nlink !== 1
  ) {
    throw new Yaml_patch_error(
      "SOURCE_CHANGED",
      "Source identity changed during the write window",
      { recoverable: true, next_action: "run extract again" },
    );
  }
  const current_digest = sha256_digest(current_file.buffer);
  if (current_digest !== source.digest) {
    throw new Yaml_patch_error(
      "SOURCE_CHANGED",
      "Source bytes changed during the write window",
      {
        recoverable: true,
        next_action: "run extract again",
        details: {
          expected_digest: source.digest,
          actual_digest: current_digest,
        },
      },
    );
  }
}

async function atomic_replace_file(source, candidate_buffer, options = {}) {
  const source_path = source.requested_path || source.file_path;
  debug_log(options, `io: inspect atomic write target ${source_path}`);
  const target = await assert_write_target(source_path, options);
  const directory_path = path.dirname(target.absolute_path);
  const temporary_path = path.join(
    directory_path,
    `.${path.basename(target.absolute_path)}.yaml_patch-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  let temporary_handle;
  let renamed = false;
  try {
    debug_log(
      options,
      `io: create same-directory temporary file ${temporary_path}`,
    );
    temporary_handle = await fs.open(
      temporary_path,
      "wx",
      target.stats.mode & 0o7777,
    );
    debug_log(options, `io: write candidate bytes ${temporary_path}`);
    await temporary_handle.writeFile(candidate_buffer);
    const temporary_stats = await temporary_handle.stat();
    if (
      temporary_stats.uid !== target.stats.uid ||
      temporary_stats.gid !== target.stats.gid
    ) {
      await temporary_handle.chown(target.stats.uid, target.stats.gid);
    }
    await temporary_handle.chmod(target.stats.mode & 0o7777);
    debug_log(options, `io: preserve supported metadata ${temporary_path}`);
    await copy_supported_metadata(
      target.absolute_path,
      temporary_path,
      target.metadata,
    );
    debug_log(options, `io: fsync temporary file ${temporary_path}`);
    await temporary_handle.sync();
    await temporary_handle.close();
    temporary_handle = null;

    debug_log(
      options,
      `io: re-read source before rename ${target.absolute_path}`,
    );
    await verify_source_unchanged(target.absolute_path, source, target.stats);
    if (typeof options.before_rename === "function") {
      await options.before_rename({
        source_path: target.absolute_path,
        temporary_path,
      });
    }
    debug_log(
      options,
      `io: atomically rename temporary file ${temporary_path}`,
    );
    await fs.rename(temporary_path, target.absolute_path);
    renamed = true;
    debug_log(options, `io: fsync parent directory ${directory_path}`);
    const directory_synced = await sync_parent_directory(directory_path);
    debug_log(
      options,
      `io: verify final source digest ${target.absolute_path}`,
    );
    const expected_digest = sha256_digest(candidate_buffer);
    const final_file = await read_bounded_file(target.absolute_path, {
      max_file_bytes: candidate_buffer.length,
      allow_symbolic_link: false,
      file_type_error_code: "BYTE_GUARANTEE_FAILED",
      limit_error_code: "BYTE_GUARANTEE_FAILED",
      changed_error_code: "BYTE_GUARANTEE_FAILED",
    });
    const final_digest = sha256_digest(final_file.buffer);
    if (final_digest !== expected_digest) {
      throw new Yaml_patch_error(
        "BYTE_GUARANTEE_FAILED",
        "Final source digest differs after atomic replacement",
        { details: { expected_digest, final_digest } },
      );
    }
    return {
      candidate_digest: final_digest,
      guarantees: {
        atomic_visibility: true,
        cooperative_conflict_detection: true,
        crash_durability: directory_synced
          ? "file-and-directory-fsync"
          : "file-fsync",
      },
    };
  } finally {
    if (temporary_handle) await temporary_handle.close().catch(() => {});
    if (!renamed) await fs.unlink(temporary_path).catch(() => {});
  }
}

async function compile_edit_package(edit_package, options = {}) {
  const source_path = edit_package.manifest.source.path;
  debug_log(
    options,
    `io: read source under current preconditions ${source_path}`,
  );
  debug_log(
    options,
    `stage: parse, index, and compile candidate ${source_path}`,
  );
  const result = await run_isolated_yaml_action(
    "compile_edit_package",
    {
      file_path: source_path,
      manifest: edit_package.manifest,
      fragment_buffer: edit_package.fragment_buffer,
    },
    {
      timeout_ms: options.parser_timeout_ms,
      memory_mb: options.parser_memory_mb,
    },
  );
  result.patch_result.candidate_buffer = Buffer.from(
    result.patch_result.candidate_buffer,
  );
  return result;
}

function public_patch_result(patch_result) {
  const { candidate_index, ...public_result } = patch_result;
  return public_result;
}

async function apply_edit_package(edit_package, options = {}) {
  if (!options.write) {
    const { patch_result } = await compile_edit_package(edit_package, options);
    return {
      ...public_patch_result(patch_result),
      written: false,
      dry_run: true,
    };
  }

  const source_path = edit_package.manifest.source.path;
  debug_log(options, `io: inspect write target ${source_path}`);
  await assert_write_target(source_path, options);
  debug_log(options, `io: acquire cooperative lock ${source_path}`);
  const lock = await acquire_file_lock(source_path, {
    tool_version: edit_package.manifest.tool_version,
  });
  try {
    const { source, patch_result } = await compile_edit_package(
      edit_package,
      options,
    );
    if (patch_result.no_op) {
      return {
        ...public_patch_result(patch_result),
        written: false,
        dry_run: false,
      };
    }
    const write_result = await atomic_replace_file(
      source,
      patch_result.candidate_buffer,
      options,
    );
    return {
      ...public_patch_result(patch_result),
      ...write_result,
      written: true,
      dry_run: false,
    };
  } finally {
    debug_log(options, `io: release cooperative lock ${source_path}`);
    await release_file_lock(lock);
  }
}

module.exports = {
  LOCAL_FILE_SYSTEM_TYPES,
  acquire_file_lock,
  apply_edit_package,
  assert_local_file_system,
  assert_write_target,
  atomic_replace_file,
  break_stale_management_guard,
  break_stale_file_lock,
  compile_edit_package,
  copy_supported_metadata,
  debug_log,
  detect_unsupported_metadata,
  extended_acl_lines,
  get_writer_capabilities,
  inspect_file_lock,
  inspect_management_guard,
  is_process_alive,
  lock_path_for,
  management_guard_path_for,
  release_file_lock,
  sync_parent_directory,
  verify_source_unchanged,
};
