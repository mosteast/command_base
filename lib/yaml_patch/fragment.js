"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const package_json = require("../../package.json");
const { resolve_edit_range, SUPPORTED_EDIT_UNITS } = require("./edit_range");
const { Yaml_patch_error } = require("./error");
const {
  assert_lock_namespace_available,
  assert_stale_lock,
  find_lock_record_by_token,
  inspect_lock_namespace,
  publish_lock_record,
  quarantine_owned_lock,
  read_lock_details,
  with_lock_recovery_intent,
} = require("./lock");
const { validate_query } = require("./query");
const { read_bounded_file, sha256_digest } = require("./source");
const {
  assert_no_cross_boundary_dependencies,
  validate_source_index,
} = require("./validate");

const DEFAULT_LIMITS = Object.freeze({
  expect_matches: 1,
  max_deleted_bytes: 65536,
  max_inserted_bytes: 65536,
  max_touched_bytes: 131072,
});
const DEFAULT_MAX_FRAGMENT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_MANIFEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONTEXT_BYTES = 8 * 1024 * 1024;

function normalize_limits(limits = {}) {
  const normalized = { ...DEFAULT_LIMITS, ...limits };
  for (const field of [
    "expect_matches",
    "max_deleted_bytes",
    "max_inserted_bytes",
    "max_touched_bytes",
  ]) {
    if (!Number.isInteger(normalized[field]) || normalized[field] < 0) {
      throw new Yaml_patch_error(
        "VALIDATION_FAILED",
        `Limit ${field} must be a non-negative integer`,
        { details: { field, value: normalized[field] } },
      );
    }
  }
  return normalized;
}

function get_directive_summary(document) {
  const directives = document.directives || {};
  const tag_handles = directives.tags
    ? Object.entries(directives.tags).map(([handle, prefix]) => ({
        handle,
        prefix,
      }))
    : [];
  return {
    yaml_version:
      directives.yaml && directives.yaml.version
        ? directives.yaml.version
        : "1.2",
    tag_handles,
  };
}

function context_summary(entry) {
  return {
    document: entry.document,
    path: entry.path,
    node_type: entry.node_type,
    source: {
      line: entry.source.line,
      column: entry.source.column,
      start_byte: entry.source.start_byte,
      end_byte: entry.source.end_byte,
    },
    raw_digest: entry.raw_digest,
    size_bytes: entry.size_bytes,
  };
}

function structural_children(index, entry) {
  return entry.child_ids
    .map((child_id) => index._internal.entry_by_id.get(child_id))
    .filter(Boolean)
    .filter((child) =>
      entry.node_type === "mapping"
        ? child.relationship === "mapping_value"
        : child.relationship === "sequence_item",
    );
}

function collect_descendants(index, entry, max_depth) {
  if (!Number.isInteger(max_depth) || max_depth <= 0) return [];
  const descendants = [];
  let queue = structural_children(index, entry).map((child) => ({
    entry: child,
    depth: 1,
  }));
  while (queue.length > 0) {
    const current = queue.shift();
    descendants.push(current.entry);
    if (current.depth < max_depth) {
      queue = queue.concat(
        structural_children(index, current.entry).map((child) => ({
          entry: child,
          depth: current.depth + 1,
        })),
      );
    }
  }
  return descendants;
}

function build_context(index, entry, dependencies, options = {}) {
  const ancestor_candidates = [];
  let parent_id = entry.parent_id;
  const max_ancestors = Number.isInteger(options.ancestors)
    ? Math.max(0, options.ancestors)
    : 3;
  while (parent_id && ancestor_candidates.length < max_ancestors) {
    const parent = index._internal.entry_by_id.get(parent_id);
    if (!parent) break;
    ancestor_candidates.push(parent);
    parent_id = parent.parent_id;
  }
  const parent = entry.parent_id
    ? index._internal.entry_by_id.get(entry.parent_id)
    : null;
  const sibling_count = Number.isInteger(options.siblings)
    ? Math.max(0, options.siblings)
    : 2;
  const entry_position = parent
    ? structural_children(index, parent).findIndex(
        (sibling) => sibling.id === entry.id,
      )
    : -1;
  const sibling_before_candidates =
    entry_position === -1
      ? []
      : structural_children(index, parent).slice(
          Math.max(0, entry_position - sibling_count),
          entry_position,
        );
  const sibling_after_candidates =
    entry_position === -1
      ? []
      : structural_children(index, parent).slice(
          entry_position + 1,
          entry_position + 1 + sibling_count,
        );
  const descendant_candidates = collect_descendants(
    index,
    entry,
    Number(options.descendants_depth || 0),
  );
  const max_bytes =
    options.max_bytes === undefined
      ? Number.POSITIVE_INFINITY
      : options.max_bytes;
  const max_characters =
    options.max_characters === undefined
      ? Number.POSITIVE_INFINITY
      : options.max_characters;
  let used_bytes = entry.size_bytes;
  let used_characters = entry.size_characters;
  const omitted = { ancestors: [], siblings: [], descendants: [] };

  function include_within_budget(candidate, omitted_group) {
    const summary = context_summary(candidate);
    const serialized_summary = JSON.stringify(summary);
    const summary_bytes = Buffer.byteLength(serialized_summary, "utf8");
    const summary_characters = serialized_summary.length;
    if (
      used_bytes + summary_bytes > max_bytes ||
      used_characters + summary_characters > max_characters
    ) {
      omitted[omitted_group].push(candidate.path);
      return null;
    }
    used_bytes += summary_bytes;
    used_characters += summary_characters;
    return summary;
  }

  const ancestors = ancestor_candidates
    .map((candidate) => include_within_budget(candidate, "ancestors"))
    .filter(Boolean);
  const sibling_before = sibling_before_candidates
    .map((candidate) => include_within_budget(candidate, "siblings"))
    .filter(Boolean);
  const sibling_after = sibling_after_candidates
    .map((candidate) => include_within_budget(candidate, "siblings"))
    .filter(Boolean);
  const descendants = descendant_candidates
    .map((candidate) => include_within_budget(candidate, "descendants"))
    .filter(Boolean);

  return {
    format: "yaml_patch-context",
    version: 1,
    target: {
      path: entry.path,
      mapping_key: entry.mapping_key,
      ...context_summary(entry),
    },
    ancestors,
    siblings: { before: sibling_before, after: sibling_after },
    descendants,
    dependencies,
    budget: {
      max_bytes: Number.isFinite(max_bytes) ? max_bytes : null,
      max_characters: Number.isFinite(max_characters) ? max_characters : null,
      used_bytes,
      used_characters,
    },
    omitted,
  };
}

function build_edit_package(index, entry, options = {}) {
  validate_source_index(index);
  const edit_unit = options.edit_unit || "node-value";
  const edit_range = resolve_edit_range(index, entry, edit_unit);
  const dependencies = assert_no_cross_boundary_dependencies(index, edit_range);
  const fragment_buffer = index.source.buffer.subarray(
    edit_range.start_byte,
    edit_range.end_byte,
  );
  const max_bytes =
    options.max_bytes === undefined
      ? Number.POSITIVE_INFINITY
      : options.max_bytes;
  const max_characters =
    options.max_characters === undefined
      ? Number.POSITIVE_INFINITY
      : options.max_characters;
  if (
    fragment_buffer.length > max_bytes ||
    entry.size_characters > max_characters
  ) {
    throw new Yaml_patch_error(
      "CHANGE_LIMIT_EXCEEDED",
      "Target exceeds the extraction context budget",
      {
        details: {
          size_bytes: fragment_buffer.length,
          size_characters: entry.size_characters,
          max_bytes,
          max_characters,
        },
      },
    );
  }

  const document = index.parser_result.documents[entry.document];
  const directive_summary = get_directive_summary(document);
  const limits = normalize_limits(options.limits);
  const manifest = {
    format: "yaml_patch-edit",
    version: 1,
    tool_version: package_json.version,
    source: {
      path: index.source.requested_path || index.source.file_path,
      encoding: index.source.encoding,
      bom: index.source.bom,
      yaml_version: directive_summary.yaml_version,
      directives_digest: sha256_digest(
        Buffer.from(JSON.stringify(directive_summary), "utf8"),
      ),
      digest: index.source.digest,
      size_bytes: index.source.size_bytes,
    },
    target: {
      locator: entry.locator,
      path: entry.path,
      raw_digest: edit_range.raw_digest,
      document: entry.document,
      start_byte: edit_range.start_byte,
      end_byte: edit_range.end_byte,
      node_type: entry.node_type,
      edit_unit,
    },
    dependencies: {
      ...dependencies,
      tag_handles: directive_summary.tag_handles,
    },
    formatting: {
      line_break_mode: index.source.line_break_mode,
      terminal_newline_in_range: /(?:\r\n|\r|\n)$/.test(
        fragment_buffer.toString("utf8"),
      ),
    },
    limits,
  };
  return {
    fragment_buffer,
    manifest,
    context: build_context(index, entry, manifest.dependencies, options),
  };
}

function format_json_file(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assert_known_fields(value, allowed_fields, label, error_code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Yaml_patch_error(error_code, `${label} must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (!allowed_fields.has(field)) {
      throw new Yaml_patch_error(
        error_code,
        `Unknown ${label} field: ${field}`,
        { details: { label, field } },
      );
    }
  }
}

async function path_exists(file_path) {
  try {
    await fs.lstat(file_path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function write_synced_file(file_path, data) {
  const handle = await fs.open(file_path, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function sync_directory(directory_path) {
  let handle;
  try {
    handle = await fs.open(directory_path, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error && error.code)) {
      throw error;
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function edit_package_lock_path_for(output_directory) {
  const resolved_directory = path.resolve(output_directory);
  return path.join(
    path.dirname(resolved_directory),
    `.${path.basename(resolved_directory)}.yaml_patch-extract.lock`,
  );
}

async function inspect_edit_package_lock(output_directory) {
  return inspect_lock_namespace(
    edit_package_lock_path_for(output_directory),
    "Edit-package extract lock",
  );
}

async function break_stale_edit_package_lock(output_directory, options = {}) {
  const expected_token = options.expected_token;
  const lock_path = edit_package_lock_path_for(output_directory);
  return with_lock_recovery_intent(
    lock_path,
    output_directory,
    { ...options, operation: "break-stale-extract-lock" },
    async (intent) => {
      const inspected = await find_lock_record_by_token(
        lock_path,
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
        "stale-break",
      );
      return { ...inspected, removed: true };
    },
  );
}

async function write_edit_package(
  edit_package,
  output_directory,
  options = {},
) {
  const resolved_directory = path.resolve(output_directory);
  const parent_directory = path.dirname(resolved_directory);
  const output_name = path.basename(resolved_directory);
  await fs.mkdir(parent_directory, { recursive: true });
  const lock_path = edit_package_lock_path_for(resolved_directory);
  const lock_data = {
    output_directory: resolved_directory,
    pid: process.pid,
    hostname: os.hostname(),
    token: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    operation: "extract",
  };
  let lock_complete = false;
  try {
    await assert_lock_namespace_available(lock_path);
    await publish_lock_record(lock_path, lock_data);
    lock_complete = true;
    await assert_lock_namespace_available(lock_path);
  } catch (error) {
    if (lock_complete) {
      await quarantine_owned_lock(
        lock_path,
        lock_data.token,
        "contended-create",
      ).catch(() => {});
    }
    if (
      (error && error.code === "EEXIST") ||
      (error instanceof Yaml_patch_error && error.code === "UNSAFE_CONCURRENCY")
    ) {
      const inspected = await inspect_lock_namespace(
        lock_path,
        "Edit-package extract lock",
      ).catch(() => null);
      throw new Yaml_patch_error(
        "OUTPUT_EXISTS",
        `Another extract is updating: ${resolved_directory}`,
        {
          recoverable: true,
          next_action: "inspect the extract lock and retry after it completes",
          details: {
            lock_path,
            lock: inspected
              ? inspected.lock
              : await read_lock_details(lock_path),
          },
        },
      );
    }
    throw error;
  }

  const temporary_directory = path.join(
    parent_directory,
    `.${output_name}.yaml_patch-session-${crypto.randomUUID()}`,
  );
  let backup_directory = "";
  try {
    const exists = await path_exists(resolved_directory);
    if (exists && !options.refresh) {
      throw new Yaml_patch_error(
        "OUTPUT_EXISTS",
        `Edit package already exists: ${resolved_directory}`,
        {
          recoverable: true,
          next_action: "use refresh to replace this generated edit package",
        },
      );
    }
    if (exists) {
      const existing_manifest_path = path.join(
        resolved_directory,
        "manifest.json",
      );
      validate_manifest(
        JSON.parse(
          await read_bounded_regular_file(
            existing_manifest_path,
            DEFAULT_MAX_MANIFEST_BYTES,
            "utf8",
          ),
        ),
      );
    }

    await fs.mkdir(temporary_directory, { mode: 0o700 });
    await Promise.all([
      write_synced_file(
        path.join(temporary_directory, "fragment.yaml"),
        edit_package.fragment_buffer,
      ),
      write_synced_file(
        path.join(temporary_directory, "manifest.json"),
        format_json_file(edit_package.manifest),
      ),
      write_synced_file(
        path.join(temporary_directory, "context.json"),
        format_json_file(edit_package.context),
      ),
    ]);
    await sync_directory(temporary_directory);
    if (typeof options.before_commit === "function") {
      await options.before_commit({
        output_directory: resolved_directory,
        temporary_directory,
      });
    }

    if (exists) {
      backup_directory = path.join(
        parent_directory,
        `.${output_name}.yaml_patch-backup-${crypto.randomUUID()}`,
      );
      await fs.rename(resolved_directory, backup_directory);
    }
    try {
      await fs.rename(temporary_directory, resolved_directory);
    } catch (error) {
      if (backup_directory && !(await path_exists(resolved_directory))) {
        await fs.rename(backup_directory, resolved_directory);
        backup_directory = "";
      }
      throw error;
    }
    await sync_directory(parent_directory);
    if (backup_directory) {
      await fs.rm(backup_directory, { recursive: true, force: true });
      backup_directory = "";
    }
    return {
      output_directory: resolved_directory,
      fragment_path: path.join(resolved_directory, "fragment.yaml"),
      manifest_path: path.join(resolved_directory, "manifest.json"),
      context_path: path.join(resolved_directory, "context.json"),
    };
  } finally {
    await fs.rm(temporary_directory, { recursive: true, force: true });
    if (backup_directory && (await path_exists(resolved_directory))) {
      await fs.rm(backup_directory, { recursive: true, force: true });
    }
    await quarantine_owned_lock(lock_path, lock_data.token, "release");
  }
}

function validate_manifest(manifest) {
  const error_code = "INVALID_FRAGMENT";
  assert_known_fields(
    manifest,
    new Set([
      "format",
      "version",
      "tool_version",
      "source",
      "target",
      "dependencies",
      "formatting",
      "limits",
    ]),
    "manifest",
    error_code,
  );
  if (
    manifest.format !== "yaml_patch-edit" ||
    manifest.version !== 1 ||
    !manifest.source ||
    !manifest.target ||
    !manifest.dependencies ||
    !manifest.formatting ||
    !manifest.limits
  ) {
    throw new Yaml_patch_error(
      "INVALID_FRAGMENT",
      "manifest.json is not a supported yaml_patch edit manifest",
    );
  }
  assert_known_fields(
    manifest.source,
    new Set([
      "path",
      "encoding",
      "bom",
      "yaml_version",
      "directives_digest",
      "digest",
      "size_bytes",
    ]),
    "manifest source",
    error_code,
  );
  assert_known_fields(
    manifest.target,
    new Set([
      "locator",
      "path",
      "raw_digest",
      "document",
      "start_byte",
      "end_byte",
      "node_type",
      "edit_unit",
    ]),
    "manifest target",
    error_code,
  );
  assert_known_fields(
    manifest.dependencies || {},
    new Set([
      "cross_boundary_anchor_alias",
      "crossing_relations",
      "tag_handles",
    ]),
    "manifest dependencies",
    error_code,
  );
  assert_known_fields(
    manifest.formatting || {},
    new Set(["line_break_mode", "terminal_newline_in_range"]),
    "manifest formatting",
    error_code,
  );
  assert_known_fields(
    manifest.limits || {},
    new Set([
      "expect_matches",
      "max_deleted_bytes",
      "max_inserted_bytes",
      "max_touched_bytes",
    ]),
    "manifest limits",
    error_code,
  );
  const sha256_pattern = /^[a-f0-9]{64}$/;
  function require_manifest(condition, message) {
    if (!condition) throw new Yaml_patch_error(error_code, message);
  }
  require_manifest(
    typeof manifest.tool_version === "string" &&
      manifest.tool_version.length > 0,
    "manifest tool_version must be a non-empty string",
  );
  require_manifest(
    typeof manifest.source.path === "string" &&
      manifest.source.path.length > 0 &&
      !manifest.source.path.includes("\0"),
    "manifest source path must be a non-empty string",
  );
  require_manifest(
    manifest.source.encoding === "utf-8",
    "manifest source encoding must be utf-8",
  );
  require_manifest(
    typeof manifest.source.bom === "boolean",
    "manifest source bom must be boolean",
  );
  require_manifest(
    ["1.1", "1.2"].includes(manifest.source.yaml_version),
    "manifest source yaml_version must be 1.1 or 1.2",
  );
  require_manifest(
    sha256_pattern.test(manifest.source.directives_digest || "") &&
      sha256_pattern.test(manifest.source.digest || ""),
    "manifest source digests must be SHA-256 hex strings",
  );
  require_manifest(
    Number.isInteger(manifest.source.size_bytes) &&
      manifest.source.size_bytes >= 0,
    "manifest source size_bytes must be a non-negative integer",
  );
  require_manifest(
    typeof manifest.target.locator === "string" &&
      manifest.target.locator.length > 0,
    "manifest target locator must be a non-empty string",
  );
  require_manifest(
    Number.isInteger(manifest.target.document) && manifest.target.document >= 0,
    "manifest target document must be a non-negative integer",
  );
  require_manifest(
    Array.isArray(manifest.target.path),
    "manifest target path must be an array",
  );
  try {
    validate_query({
      version: 1,
      document: manifest.target.document,
      path: manifest.target.path,
      node_type: manifest.target.node_type,
    });
  } catch (error) {
    throw new Yaml_patch_error(error_code, "manifest target path is invalid", {
      cause: error,
    });
  }
  require_manifest(
    sha256_pattern.test(manifest.target.raw_digest || ""),
    "manifest target raw_digest must be a SHA-256 hex string",
  );
  require_manifest(
    Number.isInteger(manifest.target.start_byte) &&
      Number.isInteger(manifest.target.end_byte) &&
      manifest.target.start_byte >= 0 &&
      manifest.target.end_byte >= manifest.target.start_byte,
    "manifest target byte range is invalid",
  );
  require_manifest(
    SUPPORTED_EDIT_UNITS.has(manifest.target.edit_unit),
    "manifest target edit_unit is unsupported",
  );
  require_manifest(
    typeof (manifest.dependencies || {}).cross_boundary_anchor_alias ===
      "boolean" &&
      Array.isArray((manifest.dependencies || {}).crossing_relations) &&
      Array.isArray((manifest.dependencies || {}).tag_handles),
    "manifest dependencies are invalid",
  );
  for (const tag_handle of manifest.dependencies.tag_handles) {
    assert_known_fields(
      tag_handle,
      new Set(["handle", "prefix"]),
      "manifest tag handle",
      error_code,
    );
    require_manifest(
      typeof tag_handle.handle === "string" &&
        typeof tag_handle.prefix === "string",
      "manifest tag handle is invalid",
    );
  }
  for (const relation of manifest.dependencies.crossing_relations) {
    assert_known_fields(
      relation,
      new Set([
        "alias",
        "alias_locator",
        "anchor_locator",
        "alias_inside",
        "anchor_inside",
      ]),
      "manifest crossing relation",
      error_code,
    );
    require_manifest(
      typeof relation.alias === "string" &&
        typeof relation.alias_locator === "string" &&
        typeof relation.anchor_locator === "string" &&
        typeof relation.alias_inside === "boolean" &&
        typeof relation.anchor_inside === "boolean",
      "manifest crossing relation is invalid",
    );
  }
  require_manifest(
    ["none", "lf", "crlf", "cr", "mixed"].includes(
      (manifest.formatting || {}).line_break_mode,
    ) &&
      typeof (manifest.formatting || {}).terminal_newline_in_range ===
        "boolean",
    "manifest formatting is invalid",
  );
  for (const field of [
    "expect_matches",
    "max_deleted_bytes",
    "max_inserted_bytes",
    "max_touched_bytes",
  ]) {
    const value = manifest.limits[field];
    require_manifest(
      Number.isInteger(value) && value >= 0,
      `manifest limit ${field} must be a non-negative integer`,
    );
  }
  require_manifest(
    manifest.limits && manifest.limits.expect_matches === 1,
    "manifest limits expect_matches must equal 1",
  );
  normalize_limits(manifest.limits);
  return manifest;
}

async function read_bounded_regular_file(file_path, max_bytes, encoding) {
  if (!Number.isInteger(max_bytes) || max_bytes < 0) {
    throw new Yaml_patch_error(
      "INVALID_FRAGMENT",
      `Edit-package member read limit is invalid: ${file_path}`,
      { details: { path: file_path, max_bytes } },
    );
  }
  try {
    const file = await read_bounded_file(file_path, {
      max_file_bytes: max_bytes,
      allow_symbolic_link: false,
      file_type_error_code: "INVALID_FRAGMENT",
      limit_error_code: "INVALID_FRAGMENT",
    });
    if (!encoding) return file.buffer;
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(file.buffer);
    } catch (error) {
      throw new Yaml_patch_error(
        "INVALID_FRAGMENT",
        `Edit-package member is not valid ${encoding}: ${file_path}`,
        { cause: error, details: { path: file_path } },
      );
    }
  } catch (error) {
    if (
      error instanceof Yaml_patch_error &&
      error.code === "INVALID_FRAGMENT"
    ) {
      throw error;
    }
    throw new Yaml_patch_error(
      "INVALID_FRAGMENT",
      `Edit-package member changed while being read: ${file_path}`,
      { cause: error, details: { path: file_path } },
    );
  }
}

async function assert_edit_package_unlocked(output_directory) {
  try {
    const inspected = await inspect_edit_package_lock(output_directory);
    throw new Yaml_patch_error(
      "UNSAFE_CONCURRENCY",
      "Edit package is being refreshed or its lock is being recovered",
      {
        recoverable: true,
        next_action: "retry after the extract operation completes",
        details: inspected,
      },
    );
  } catch (error) {
    if (error instanceof Yaml_patch_error && error.code === "NO_MATCH") return;
    throw error;
  }
}

function directory_generation_matches(left, right) {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

async function load_edit_package(output_directory, options = {}) {
  const resolved_directory = path.resolve(output_directory);
  let directory_handle;
  try {
    await assert_edit_package_unlocked(resolved_directory);
    const path_stats = await fs.lstat(resolved_directory);
    if (!path_stats.isDirectory() || path_stats.isSymbolicLink()) {
      throw new Yaml_patch_error(
        "INVALID_FRAGMENT",
        `Edit package must be a regular directory: ${resolved_directory}`,
      );
    }
    directory_handle = await fs.open(resolved_directory, "r");
    const initial_stats = await directory_handle.stat();
    if (!directory_generation_matches(path_stats, initial_stats)) {
      throw new Yaml_patch_error(
        "UNSAFE_CONCURRENCY",
        "Edit-package generation changed while its directory was opened",
        { details: { output_directory: resolved_directory } },
      );
    }
    const fragment_buffer = await read_bounded_regular_file(
      path.join(resolved_directory, "fragment.yaml"),
      options.max_fragment_bytes === undefined
        ? DEFAULT_MAX_FRAGMENT_BYTES
        : options.max_fragment_bytes,
    );
    if (typeof options.after_member_read === "function") {
      await options.after_member_read({ member: "fragment.yaml" });
    }
    const manifest_text = await read_bounded_regular_file(
      path.join(resolved_directory, "manifest.json"),
      options.max_manifest_bytes === undefined
        ? DEFAULT_MAX_MANIFEST_BYTES
        : options.max_manifest_bytes,
      "utf8",
    );
    if (typeof options.after_member_read === "function") {
      await options.after_member_read({ member: "manifest.json" });
    }
    const context_text = await read_bounded_regular_file(
      path.join(resolved_directory, "context.json"),
      options.max_context_bytes === undefined
        ? DEFAULT_MAX_CONTEXT_BYTES
        : options.max_context_bytes,
      "utf8",
    );
    if (typeof options.after_member_read === "function") {
      await options.after_member_read({ member: "context.json" });
    }
    const final_stats_before_unlock = await fs.lstat(resolved_directory);
    if (
      !directory_generation_matches(initial_stats, final_stats_before_unlock)
    ) {
      throw new Yaml_patch_error(
        "UNSAFE_CONCURRENCY",
        "Edit-package generation changed while its members were read",
        {
          recoverable: true,
          next_action: "retry after the extract refresh completes",
          details: {
            output_directory: resolved_directory,
            initial_inode: initial_stats.ino,
            final_inode: final_stats_before_unlock.ino,
          },
        },
      );
    }
    await assert_edit_package_unlocked(resolved_directory);
    const final_stats_after_unlock = await fs.lstat(resolved_directory);
    if (
      !directory_generation_matches(initial_stats, final_stats_after_unlock)
    ) {
      throw new Yaml_patch_error(
        "UNSAFE_CONCURRENCY",
        "Edit-package generation changed during the final lock check",
        {
          recoverable: true,
          next_action: "retry after the extract refresh completes",
          details: {
            output_directory: resolved_directory,
            initial_inode: initial_stats.ino,
            final_inode: final_stats_after_unlock.ino,
          },
        },
      );
    }
    return {
      fragment_buffer,
      manifest: validate_manifest(JSON.parse(manifest_text)),
      context: JSON.parse(context_text),
    };
  } catch (error) {
    if (error instanceof Yaml_patch_error) throw error;
    throw new Yaml_patch_error(
      "INVALID_FRAGMENT",
      `Cannot load edit package: ${resolved_directory}`,
      { cause: error, details: { output_directory: resolved_directory } },
    );
  } finally {
    if (directory_handle) await directory_handle.close().catch(() => {});
  }
}

module.exports = {
  DEFAULT_MAX_CONTEXT_BYTES,
  DEFAULT_MAX_FRAGMENT_BYTES,
  DEFAULT_MAX_MANIFEST_BYTES,
  DEFAULT_LIMITS,
  assert_edit_package_unlocked,
  break_stale_edit_package_lock,
  build_context,
  build_edit_package,
  edit_package_lock_path_for,
  assert_known_fields,
  inspect_edit_package_lock,
  load_edit_package,
  normalize_limits,
  read_bounded_regular_file,
  sync_directory,
  validate_manifest,
  write_synced_file,
  write_edit_package,
};
