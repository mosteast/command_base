"use strict";

const path = require("node:path");

const { canonical_digest } = require("./artifact_version");
const { create_file_diff } = require("./diff");
const { Yaml_patch_error, throw_request_error } = require("./error");
const { build_node_index, get_index_node } = require("./node_index");
const {
  MAPPING_OPERATION,
  SCALAR_OPERATION,
  SEQUENCE_OPERATION,
  compile_operation,
} = require("./operation");
const { validate_operation } = require("./operation_schema");
const { parse_yaml_source } = require("./parser");
const { create_transaction_manifest } = require("./manifest");
const {
  IDENTITY_LIMIT_FIELDS,
  validate_profile_candidates,
} = require("./profile_validate");
const {
  find_nodes,
  resolve_query_path,
  select_unique_node,
  validate_query,
} = require("./query");
const {
  apply_snapshot_splices,
  create_multi_range_byte_proof,
  create_piece_table,
  create_transaction_proof,
  materialize_piece_table,
} = require("./range_set");
const { create_source_record, sha256_digest } = require("./source");
const { typed_scalar_metadata } = require("./scalar_metadata");
const { compile_subtree_operation } = require("./subtree_edit");
const {
  assert_known_fields,
  assert_non_empty_string,
  assert_non_negative_integer,
  assert_sha256_digest,
} = require("./schema");
const { typed_values_equal, validate_typed_value } = require("./typed_value");
const {
  validate_candidate_index,
  validate_source_index,
} = require("./validate");

const TRANSACTION_OPERATION_FIELD = new Set([
  "file",
  "target",
  "source",
  "destination",
  "selector",
  "handle",
  "result_handle",
  "preconditions",
]);
const TRANSACTION_FIELD = [
  "version",
  "files",
  "operations",
  "preconditions",
  "limits",
];
const FILE_FIELD = ["id", "path", "digest", "identity", "document_count"];
const TRANSACTION_PRECONDITION_FIELD = [
  "participant_digest",
  "profile_digest",
  "tool_version",
];
const OPERATION_PRECONDITION_FIELD = [
  "match_count",
  "target_digest",
  "raw",
  "typed",
  "parent_handle",
  "previous_handle",
  "next_handle",
  "position",
];
const LIMIT_FIELD = [
  "max_file",
  "max_operation",
  "max_match",
  "max_range",
  "max_added_node",
  "max_deleted_node",
  "max_moved_node",
  "max_touched_byte_per_file",
  "max_touched_byte_total",
  "max_added_identity",
  "max_deleted_identity",
  "max_modified_identity",
  "max_affected_identity",
];
const STRUCTURAL_OPERATION = new Set([
  ...SCALAR_OPERATION,
  ...MAPPING_OPERATION,
  ...SEQUENCE_OPERATION,
]);
const BIND_OPERATION_FIELD = [
  "id",
  "type",
  "file",
  "selector",
  "handle",
  "preconditions",
];
const SUBTREE_OPERATION_FIELD = Object.freeze({
  add_subtree: [
    "id",
    "type",
    "destination",
    "raw",
    "key",
    "result_handle",
    "preconditions",
  ],
  copy_subtree: [
    "id",
    "type",
    "source",
    "destination",
    "result_handle",
    "preconditions",
  ],
  delete_subtree: ["id", "type", "source", "preconditions"],
  move_subtree: [
    "id",
    "type",
    "source",
    "destination",
    "result_handle",
    "preconditions",
  ],
});

function assert_plain_known(value, allowed, label) {
  return assert_known_fields(value, allowed, label, "REQUEST_ERROR");
}

function precondition_error(scope, message, expected, actual, details = {}) {
  throw new Yaml_patch_error("PRECONDITION_FAILED", message, {
    details: { scope, expected, actual, ...details },
    next_action: "refresh the transaction against the current snapshot",
  });
}

function change_limit_error(limit_name, limit, actual, details = {}) {
  throw new Yaml_patch_error(
    "CHANGE_LIMIT_EXCEEDED",
    `Transaction exceeds ${limit_name}`,
    {
      details: { limit_name, limit, actual, ...details },
      next_action:
        "review the candidate and explicitly increase the change limit",
    },
  );
}

function normalized_limits(request) {
  const limits = request.limits || {};
  assert_plain_known(limits, LIMIT_FIELD, "transaction limits");
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw_request_error(`${field} must be a non-negative safe integer`);
    }
  }
  return limits;
}

function enforce_limit(limits, name, actual, details) {
  if (limits[name] !== undefined && actual > limits[name]) {
    change_limit_error(name, limits[name], actual, details);
  }
}

function validate_initial_limits(request, limits) {
  enforce_limit(limits, "max_file", request.files.length);
  enforce_limit(limits, "max_operation", request.operations.length);
}

function participant_digest_for(files) {
  if (!Array.isArray(files))
    throw_request_error("Transaction files must be an array");
  return canonical_digest(
    files
      .map((file) => ({
        id: file.id,
        digest: file.digest === undefined ? null : file.digest,
      }))
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      ),
  );
}

function operation_file_ids(operation) {
  const ids = [];
  for (const value of [
    operation.file,
    operation.source && operation.source.file,
    operation.destination && operation.destination.file,
  ]) {
    if (typeof value === "string") ids.push(value);
  }
  return ids;
}

function validate_operation_precondition_shape(operation) {
  if (operation.preconditions === undefined) return;
  const label = `${operation.id} preconditions`;
  const preconditions = assert_plain_known(
    operation.preconditions,
    OPERATION_PRECONDITION_FIELD,
    label,
  );
  if (preconditions.match_count !== undefined) {
    assert_non_negative_integer(
      preconditions.match_count,
      `${label}.match_count`,
      "REQUEST_ERROR",
    );
  }
  if (preconditions.target_digest !== undefined) {
    assert_sha256_digest(
      preconditions.target_digest,
      `${label}.target_digest`,
      "REQUEST_ERROR",
    );
  }
  if (
    preconditions.raw !== undefined &&
    typeof preconditions.raw !== "string"
  ) {
    throw_request_error(`${label}.raw must be a string`);
  }
  if (preconditions.typed !== undefined) {
    validate_typed_value(preconditions.typed, `${label}.typed`);
  }
  for (const field of ["parent_handle", "previous_handle", "next_handle"]) {
    if (preconditions[field] !== undefined) {
      assert_handle_name(preconditions[field], `${label}.${field}`);
    }
  }
  if (preconditions.position !== undefined) {
    assert_non_negative_integer(
      preconditions.position,
      `${label}.position`,
      "REQUEST_ERROR",
    );
  }
}

function validate_subtree_position(position, label) {
  assert_plain_known(position, ["kind"], label);
  if (!new Set(["append", "prepend"]).has(position.kind)) {
    throw_request_error(`${label}.kind must be append or prepend`);
  }
}

function validate_reference_shape(reference, label, options = {}) {
  const position_fields = options.position ? ["position"] : [];
  assert_plain_known(
    reference,
    ["file", "selector", "handle", "path", ...position_fields],
    label,
  );
  const uses_handle = Object.hasOwn(reference, "handle");
  const uses_selector =
    Object.hasOwn(reference, "file") || Object.hasOwn(reference, "selector");
  if (uses_handle === uses_selector) {
    throw_request_error(
      `${label} must use exactly one of file/selector or handle/path`,
    );
  }
  if (uses_handle) {
    assert_plain_known(
      reference,
      ["handle", "path", ...position_fields],
      label,
    );
    assert_handle_name(reference.handle, `${label}.handle`);
    if (reference.path !== undefined) {
      validate_query({ version: 1, path: reference.path });
    }
  } else {
    assert_plain_known(
      reference,
      ["file", "selector", ...position_fields],
      label,
    );
    assert_non_empty_string(reference.file, `${label}.file`, "REQUEST_ERROR");
    validate_query(reference.selector);
  }
  if (options.position) {
    validate_subtree_position(reference.position, `${label}.position`);
  }
}

function validate_transaction_operation(operation, index) {
  assert_known_fields(
    operation,
    Reflect.ownKeys(operation).filter((field) => typeof field === "string"),
    `transaction operation ${index}`,
    "REQUEST_ERROR",
  );
  if (STRUCTURAL_OPERATION.has(operation.type)) {
    for (const field of [
      "source",
      "destination",
      "selector",
      "handle",
      "result_handle",
    ]) {
      if (Object.hasOwn(operation, field)) {
        throw_request_error(
          `${operation.type} does not support transaction field: ${field}`,
        );
      }
    }
    assert_plain_known(
      operation.target,
      ["selector", "handle", "path"],
      `${operation.type}.target`,
    );
    if (Object.hasOwn(operation.target, "handle")) {
      assert_plain_known(
        operation.target,
        ["handle", "path"],
        `${operation.type}.target`,
      );
      assert_handle_name(
        operation.target.handle,
        `${operation.type}.target.handle`,
      );
      if (operation.target.path !== undefined) {
        validate_query({ version: 1, path: operation.target.path });
      }
    } else {
      assert_non_empty_string(
        operation.file,
        `${operation.type}.file`,
        "REQUEST_ERROR",
      );
      assert_plain_known(
        operation.target,
        ["selector"],
        `${operation.type}.target`,
      );
      validate_query(operation.target.selector);
    }
    validate_operation(
      structural_operation(operation),
      STRUCTURAL_OPERATION,
      "Structural",
    );
    validate_operation_precondition_shape(operation);
    return;
  }
  if (operation.type === "bind") {
    assert_plain_known(
      operation,
      BIND_OPERATION_FIELD,
      `transaction operation ${index}`,
    );
    assert_non_empty_string(operation.file, "bind.file", "REQUEST_ERROR");
    validate_query(operation.selector);
    assert_handle_name(operation.handle, "bind.handle");
    validate_operation_precondition_shape(operation);
    return;
  }
  const subtree_fields = SUBTREE_OPERATION_FIELD[operation.type];
  if (!subtree_fields) {
    throw_request_error(`Unsupported transaction operation: ${operation.type}`);
  }
  assert_plain_known(
    operation,
    subtree_fields,
    `transaction operation ${index}`,
  );
  if (operation.type === "add_subtree") {
    validate_reference_shape(operation.destination, "add_subtree.destination", {
      position: true,
    });
    if (typeof operation.raw !== "string" || operation.raw.length === 0) {
      throw_request_error("add_subtree.raw must be a non-empty string");
    }
    if (operation.key !== undefined && typeof operation.key !== "string") {
      throw_request_error("add_subtree.key must be a string");
    }
  } else {
    validate_reference_shape(operation.source, `${operation.type}.source`);
    if (operation.type !== "delete_subtree") {
      validate_reference_shape(
        operation.destination,
        `${operation.type}.destination`,
        { position: true },
      );
    }
  }
  if (operation.result_handle !== undefined) {
    assert_handle_name(
      operation.result_handle,
      `${operation.type}.result_handle`,
    );
  }
  validate_operation_precondition_shape(operation);
}

function validate_participants(request) {
  assert_plain_known(request, TRANSACTION_FIELD, "transaction");
  if (request.version !== 1) {
    throw new Yaml_patch_error(
      "PROTOCOL_VERSION_UNSUPPORTED",
      "Unsupported transaction version",
      {
        details: { kind: "transaction", version: request.version },
      },
    );
  }
  if (!Array.isArray(request.files) || !Array.isArray(request.operations)) {
    throw_request_error("Transaction requires files and operations arrays");
  }
  const declared = new Set();
  for (const [index, file] of request.files.entries()) {
    assert_plain_known(file, FILE_FIELD, `transaction file ${index}`);
    assert_non_empty_string(
      file.id,
      `transaction file ${index}.id`,
      "REQUEST_ERROR",
    );
    assert_non_empty_string(
      file.path,
      `transaction file ${index}.path`,
      "REQUEST_ERROR",
    );
    if (file.digest !== undefined) {
      assert_sha256_digest(
        file.digest,
        `transaction file ${index}.digest`,
        "REQUEST_ERROR",
      );
    }
    if (file.identity !== undefined) {
      assert_non_empty_string(
        file.identity,
        `transaction file ${index}.identity`,
        "REQUEST_ERROR",
      );
    }
    if (file.document_count !== undefined) {
      assert_non_negative_integer(
        file.document_count,
        `transaction file ${index}.document_count`,
        "REQUEST_ERROR",
      );
    }
    if (declared.has(file.id))
      throw_request_error(`Duplicate transaction file id: ${file.id}`);
    declared.add(file.id);
  }
  const operation_ids = new Set();
  for (const [index, operation] of request.operations.entries()) {
    assert_known_fields(
      operation,
      operation && typeof operation === "object" && !Array.isArray(operation)
        ? Reflect.ownKeys(operation).filter(
            (field) => typeof field === "string",
          )
        : [],
      `transaction operation ${index}`,
      "REQUEST_ERROR",
    );
    if (
      typeof operation.id !== "string" ||
      operation.id.length === 0 ||
      operation_ids.has(operation.id)
    ) {
      throw_request_error(
        `Transaction operation ${index} requires a unique non-empty id`,
      );
    }
    operation_ids.add(operation.id);
    validate_transaction_operation(operation, index);
    for (const file_id of operation_file_ids(operation)) {
      if (!declared.has(file_id)) {
        throw new Yaml_patch_error(
          "CROSS_BOUNDARY_DEPENDENCY",
          "Transaction operation references an undeclared file",
          { details: { operation_id: operation.id, file_id } },
        );
      }
    }
  }
}

function validate_transaction_preconditions(request, options) {
  const preconditions = request.preconditions;
  if (preconditions === undefined) return;
  assert_plain_known(
    preconditions,
    TRANSACTION_PRECONDITION_FIELD,
    "transaction preconditions",
  );
  if (
    preconditions.participant_digest !== undefined &&
    preconditions.participant_digest !== participant_digest_for(request.files)
  ) {
    precondition_error(
      "transaction",
      "Participant digest changed",
      preconditions.participant_digest,
      participant_digest_for(request.files),
      { field: "participant_digest" },
    );
  }
  const profile_digest =
    options.profile_digest ||
    (options.profile ? canonical_digest(options.profile) : null);
  if (
    preconditions.profile_digest !== undefined &&
    preconditions.profile_digest !== profile_digest
  ) {
    precondition_error(
      "transaction",
      "Profile digest changed",
      preconditions.profile_digest,
      profile_digest,
      { field: "profile_digest" },
    );
  }
  if (
    preconditions.tool_version !== undefined &&
    preconditions.tool_version !== options.tool_version
  ) {
    precondition_error(
      "transaction",
      "Tool version changed",
      preconditions.tool_version,
      options.tool_version || null,
      { field: "tool_version" },
    );
  }
}

async function source_buffer_for(file, options) {
  let value = options.sources && options.sources[file.id];
  if (value === undefined && typeof options.load_source === "function") {
    value = await options.load_source(file);
  }
  if (typeof value === "string") value = Buffer.from(value);
  if (value && !Buffer.isBuffer(value) && Buffer.isBuffer(value.buffer))
    value = value.buffer;
  if (!Buffer.isBuffer(value))
    throw_request_error(`No source bytes declared for file: ${file.id}`);
  return Buffer.from(value);
}

function index_for(file, buffer, original_index) {
  const source = create_source_record(buffer, {
    requested_path: file.path,
    source_id: file.id,
  });
  const parsed = parse_yaml_source(source);
  if (parsed.errors.length > 0) {
    throw new Yaml_patch_error(
      "YAML_DIAGNOSTIC",
      "Transaction source is not valid YAML",
      {
        details: { file_id: file.id, diagnostics: parsed.errors },
      },
    );
  }
  const index = build_node_index(source, parsed);
  if (original_index) {
    validate_candidate_index(original_index, index);
  } else {
    validate_source_index(index);
  }
  return index;
}

function structural_operation(operation) {
  return Object.fromEntries(
    Object.entries(operation).filter(
      ([field]) => !TRANSACTION_OPERATION_FIELD.has(field),
    ),
  );
}

function assert_handle_name(handle, label = "handle") {
  if (
    typeof handle !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(handle)
  ) {
    throw_request_error(`${label} must be a transaction-local identifier`);
  }
  return handle;
}

function entry_semantic_digest(index, entry) {
  const node = get_index_node(index, entry);
  if (!node)
    throw new Yaml_patch_error("PRECONDITION_FAILED", "Handle node vanished");
  return canonical_digest({ node_type: entry.node_type, value: node.toJSON() });
}

function bind_handle(handles, name, state, entry) {
  assert_handle_name(name);
  if (handles.has(name))
    throw_request_error(`Duplicate transaction handle: ${name}`);
  handles.set(name, {
    file_id: state.file.id,
    node_type: entry.node_type,
    document: entry.document,
    path: structuredClone(entry.path),
    semantic_digest: entry_semantic_digest(state.index, entry),
  });
}

function matching_handle_entry(state, binding) {
  const matches = state.index.entries.filter(
    (entry) =>
      entry.node_type === binding.node_type &&
      entry_semantic_digest(state.index, entry) === binding.semantic_digest,
  );
  if (matches.length === 1) return matches[0];
  const at_path = resolve_query_path(
    state.index,
    binding.document,
    binding.path,
  );
  if (at_path && at_path.node_type === binding.node_type) return at_path;
  throw new Yaml_patch_error(
    "PRECONDITION_FAILED",
    "Transaction handle no longer identifies one node",
    {
      details: { handle_file: binding.file_id, match_count: matches.length },
    },
  );
}

function resolve_reference(reference, states, handles, label) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw_request_error(`${label} must be a selector or handle reference`);
  }
  if (Object.hasOwn(reference, "handle")) {
    assert_handle_name(reference.handle, `${label}.handle`);
    const binding = handles.get(reference.handle);
    if (!binding) {
      throw new Yaml_patch_error(
        "PRECONDITION_FAILED",
        "Unknown transaction handle",
        {
          details: { handle: reference.handle },
        },
      );
    }
    const state = states.get(binding.file_id);
    const root = matching_handle_entry(state, binding);
    const relative_path = reference.path || [];
    if (!Array.isArray(relative_path))
      throw_request_error(`${label}.path must be an array`);
    const entry =
      relative_path.length === 0
        ? root
        : resolve_query_path(
            state.index,
            root.document,
            root.path.concat(structuredClone(relative_path)),
          );
    if (!entry) {
      throw new Yaml_patch_error(
        "NO_MATCH",
        "Handle-relative path matched no YAML node",
        {
          details: { handle: reference.handle, path: relative_path },
        },
      );
    }
    return { state, entry, handle: reference.handle };
  }
  if (typeof reference.file !== "string" || !reference.selector) {
    throw_request_error(`${label} requires file and selector`);
  }
  const state = states.get(reference.file);
  if (!state) throw_request_error(`${label} references an unavailable file`);
  return { state, entry: select_unique_node(state.index, reference.selector) };
}

function operation_target(operation, states, handles) {
  if (operation.target && Object.hasOwn(operation.target, "handle")) {
    return resolve_reference(
      operation.target,
      states,
      handles,
      `${operation.type}.target`,
    );
  }
  if (
    !operation.target ||
    !operation.target.selector ||
    typeof operation.file !== "string"
  ) {
    throw_request_error(`${operation.type} requires file and target.selector`);
  }
  return resolve_reference(
    { file: operation.file, selector: operation.target.selector },
    states,
    handles,
    `${operation.type}.target`,
  );
}

function reference_match_count(reference, resolved) {
  return reference && reference.selector
    ? find_nodes(resolved.state.index, reference.selector).length
    : 1;
}

function path_starts_with(path, prefix) {
  return (
    path.length >= prefix.length &&
    prefix.every(
      (step, index) => canonical_digest(step) === canonical_digest(path[index]),
    )
  );
}

function handle_snapshot(handles, states, file_ids) {
  const snapshot = new Map();
  for (const [name, binding] of handles) {
    if (!file_ids.has(binding.file_id)) continue;
    const state = states.get(binding.file_id);
    snapshot.set(name, {
      binding: { ...binding },
      entry: matching_handle_entry(state, binding),
    });
  }
  return snapshot;
}

function refresh_handles(handles, states, snapshot) {
  for (const [name, before] of snapshot) {
    const binding = handles.get(name);
    const state = states.get(binding.file_id);
    const refreshed = matching_handle_entry(state, before.binding);
    handles.set(name, {
      ...binding,
      document: refreshed.document,
      path: structuredClone(refreshed.path),
      semantic_digest: entry_semantic_digest(state.index, refreshed),
    });
  }
}

function refresh_reordered_sequence_handles(
  handles,
  snapshot,
  target,
  operation,
) {
  const item_count = target.entry.child_ids.length;
  let permutation;
  if (operation.type === "reorder_sequence_items") {
    permutation = operation.indices;
  } else if (operation.type === "swap_sequence_items") {
    permutation = Array.from({ length: item_count }, (_, index) => index);
    [permutation[operation.left_index], permutation[operation.right_index]] = [
      permutation[operation.right_index],
      permutation[operation.left_index],
    ];
  } else if (operation.type === "move_sequence_item") {
    const position = operation.position;
    const position_index =
      position.kind === "append"
        ? item_count
        : position.kind === "prepend"
          ? 0
          : position.kind === "index"
            ? position.index
            : position.kind === "before" && Number.isSafeInteger(position.index)
              ? position.index
              : position.kind === "after" &&
                  Number.isSafeInteger(position.index)
                ? position.index + 1
                : null;
    if (position_index !== null) {
      permutation = Array.from({ length: item_count }, (_, index) => index);
      const [moved] = permutation.splice(operation.index, 1);
      permutation.splice(
        position_index > operation.index ? position_index - 1 : position_index,
        0,
        moved,
      );
    }
  } else {
    return;
  }
  for (const [name, before] of snapshot) {
    if (
      before.binding.file_id !== target.state.file.id ||
      !path_starts_with(before.entry.path, target.entry.path) ||
      before.entry.path.length <= target.entry.path.length
    ) {
      continue;
    }
    const item_step = before.entry.path[target.entry.path.length];
    if (!Number.isSafeInteger(item_step.sequence_index)) continue;
    if (!permutation) {
      throw new Yaml_patch_error(
        "PRECONDITION_FAILED",
        "Sequence move position cannot preserve handle identity",
        { details: { handle: name } },
      );
    }
    const next_index = permutation.indexOf(item_step.sequence_index);
    if (next_index < 0) continue;
    const next_path = structuredClone(before.entry.path);
    next_path[target.entry.path.length] = { sequence_index: next_index };
    const next_entry = resolve_query_path(
      target.state.index,
      before.entry.document,
      next_path,
    );
    if (
      !next_entry ||
      next_entry.node_type !== before.binding.node_type ||
      entry_semantic_digest(target.state.index, next_entry) !==
        before.binding.semantic_digest
    ) {
      throw new Yaml_patch_error(
        "PRECONDITION_FAILED",
        "Reordered handle no longer identifies one node",
        { details: { handle: name } },
      );
    }
    handles.set(name, {
      ...before.binding,
      document: next_entry.document,
      path: structuredClone(next_entry.path),
      semantic_digest: entry_semantic_digest(target.state.index, next_entry),
    });
    snapshot.delete(name);
  }
}

function refresh_deleted_subtree_handles(handles, snapshot, source) {
  const source_path = source.entry.path;
  const parent_path = source_path.slice(0, -1);
  const source_step = source_path[source_path.length - 1];
  const source_index = Number.isSafeInteger(source_step.sequence_index)
    ? source_step.sequence_index
    : source_step.mapping_pair_index;
  const index_field = Number.isSafeInteger(source_step.sequence_index)
    ? "sequence_index"
    : "mapping_pair_index";
  for (const [name, before] of snapshot) {
    if (before.binding.file_id !== source.state.file.id) continue;
    if (path_starts_with(before.entry.path, source_path)) {
      handles.delete(name);
      snapshot.delete(name);
      continue;
    }
    if (
      !path_starts_with(before.entry.path, parent_path) ||
      before.entry.path.length <= parent_path.length
    ) {
      continue;
    }
    const sibling_step = before.entry.path[parent_path.length];
    if (!Number.isSafeInteger(sibling_step[index_field])) continue;
    if (sibling_step[index_field] <= source_index) continue;
    const next_path = structuredClone(before.entry.path);
    next_path[parent_path.length] = {
      ...next_path[parent_path.length],
      [index_field]: sibling_step[index_field] - 1,
    };
    const next_entry = resolve_query_path(
      source.state.index,
      before.entry.document,
      next_path,
    );
    if (
      !next_entry ||
      next_entry.node_type !== before.binding.node_type ||
      entry_semantic_digest(source.state.index, next_entry) !==
        before.binding.semantic_digest
    ) {
      throw new Yaml_patch_error(
        "PRECONDITION_FAILED",
        "Deleted subtree sibling handle no longer identifies one node",
        { details: { handle: name } },
      );
    }
    handles.set(name, {
      ...before.binding,
      document: next_entry.document,
      path: structuredClone(next_entry.path),
      semantic_digest: entry_semantic_digest(source.state.index, next_entry),
    });
    snapshot.delete(name);
  }
}

function apply_compiled(state, compiled, operation_order) {
  state.piece_table = apply_snapshot_splices(
    state.piece_table,
    compiled.splices.map((splice) => ({ ...splice, operation_order })),
  );
  state.buffer = materialize_piece_table(state.piece_table);
  state.index = index_for(state.file, state.buffer, state.original_index);
}

async function initialize_states(request, options) {
  const states = new Map();
  for (const file of request.files) {
    const original_buffer = await source_buffer_for(file, options);
    const index = index_for(file, original_buffer);
    if (file.digest !== undefined && file.digest !== index.source.digest) {
      precondition_error(
        "file",
        "File digest changed",
        file.digest,
        index.source.digest,
        {
          file_id: file.id,
          field: "digest",
        },
      );
    }
    if (
      file.identity !== undefined &&
      file.identity !== index.source.source_identity
    ) {
      precondition_error(
        "file",
        "File identity changed",
        file.identity,
        index.source.source_identity,
        { file_id: file.id, field: "identity" },
      );
    }
    const document_count = index.parser_result.documents.length;
    if (
      file.document_count !== undefined &&
      file.document_count !== document_count
    ) {
      precondition_error(
        "file",
        "YAML document count changed",
        file.document_count,
        document_count,
        { file_id: file.id, field: "document_count" },
      );
    }
    states.set(file.id, {
      file,
      original_buffer,
      original_index: index,
      piece_table: create_piece_table(original_buffer),
      buffer: original_buffer,
      index,
    });
  }
  return states;
}

function raw_for_entry(state, entry) {
  return state.buffer
    .subarray(entry.source.start_byte, entry.source.end_byte)
    .toString("utf8");
}

function typed_for_entry(state, entry) {
  if (entry.node_type !== "scalar") return null;
  const node = get_index_node(state.index, entry);
  if (!node) return null;
  const metadata = typed_scalar_metadata(node, raw_for_entry(state, entry));
  if (metadata.scalar_type === undefined) return null;
  return {
    type: metadata.scalar_type,
    value: metadata.scalar_value,
    ...(metadata.scalar_value_encoding === undefined
      ? {}
      : { value_encoding: metadata.scalar_value_encoding }),
  };
}

function evidence_for_target(operation, resolved) {
  return {
    id: operation.id,
    type: operation.type,
    file_id: resolved.state.file.id,
    locator: resolved.entry.locator,
    ...(resolved.handle === undefined ? {} : { handle: resolved.handle }),
    original_range: {
      start_byte: resolved.entry.source.start_byte,
      end_byte: resolved.entry.source.end_byte,
    },
    before: {
      raw: raw_for_entry(resolved.state, resolved.entry),
      typed: typed_for_entry(resolved.state, resolved.entry),
    },
  };
}

function candidate_entry_at_path(state, before_entry) {
  const entry = resolve_query_path(
    state.index,
    before_entry.document,
    before_entry.path,
  );
  return entry && entry.node_type === before_entry.node_type ? entry : null;
}

function entry_for_result_range(state, range) {
  const candidates = state.index.entries
    .filter(
      (entry) =>
        ["mapping_value", "sequence_item"].includes(entry.relationship) &&
        entry.source.start_byte >= range.start_byte &&
        entry.source.end_byte <= range.end_byte,
    )
    .sort(
      (left, right) =>
        right.size_bytes - left.size_bytes || left.ordinal - right.ordinal,
    );
  if (candidates.length === 0) {
    throw new Yaml_patch_error(
      "PRECONDITION_FAILED",
      "Created subtree result range contains no node",
      {
        details: { range },
      },
    );
  }
  return candidates[0];
}

function range_after_disjoint_splices(range, splices) {
  let byte_delta = 0;
  for (const splice of splices) {
    if (splice.end_byte <= range.start_byte) {
      byte_delta +=
        splice.replacement_buffer.length -
        (splice.end_byte - splice.start_byte);
    }
  }
  return {
    start_byte: range.start_byte + byte_delta,
    end_byte: range.end_byte + byte_delta,
  };
}

function sibling_position(entry) {
  return entry.relationship === "sequence_item"
    ? entry.sequence_index
    : entry.mapping_pair_index;
}

function entry_location(entry) {
  return {
    locator: entry.locator,
    document: entry.document,
    path: structuredClone(entry.path),
  };
}

function subtree_relocation_evidence(source, destination, operation) {
  const source_parent = source.state.index._internal.entry_by_id.get(
    source.entry.parent_id,
  );
  return {
    source: {
      file_id: source.state.file.id,
      ...(source.handle === undefined ? {} : { handle: source.handle }),
      parent: source_parent ? entry_location(source_parent) : null,
      position: sibling_position(source.entry),
    },
    destination: {
      file_id: destination.state.file.id,
      ...(destination.handle === undefined
        ? {}
        : { handle: destination.handle }),
      parent: entry_location(destination.entry),
      position: structuredClone(operation.destination.position),
    },
  };
}

function validate_operation_preconditions(
  operation,
  resolved,
  states,
  handles,
  match_count = 1,
) {
  const preconditions = operation.preconditions;
  if (preconditions === undefined) return;
  assert_plain_known(
    preconditions,
    OPERATION_PRECONDITION_FIELD,
    `${operation.id} preconditions`,
  );
  const { state, entry } = resolved;
  const checks = [
    ["match_count", match_count],
    ["target_digest", entry.raw_digest],
    ["raw", raw_for_entry(state, entry)],
    ["position", sibling_position(entry)],
  ];
  for (const [field, actual] of checks) {
    if (preconditions[field] !== undefined && preconditions[field] !== actual) {
      precondition_error(
        "operation",
        `Operation ${field} precondition failed`,
        preconditions[field],
        actual,
        { operation_id: operation.id, field },
      );
    }
  }
  if (preconditions.typed !== undefined) {
    validate_typed_value(
      preconditions.typed,
      `${operation.id} preconditions.typed`,
    );
    const actual = typed_for_entry(state, entry);
    if (!typed_values_equal(preconditions.typed, actual)) {
      precondition_error(
        "operation",
        "Operation typed precondition failed",
        preconditions.typed,
        actual,
        { operation_id: operation.id, field: "typed" },
      );
    }
  }
  for (const [field, offset] of [
    ["previous_handle", -1],
    ["next_handle", 1],
  ]) {
    if (preconditions[field] === undefined) continue;
    const adjacent = resolve_reference(
      { handle: preconditions[field] },
      states,
      handles,
      `${operation.id}.${field}`,
    );
    const expected_position = sibling_position(entry) + offset;
    const actual_position = sibling_position(adjacent.entry);
    if (
      adjacent.state !== state ||
      adjacent.entry.parent_id !== entry.parent_id ||
      actual_position !== expected_position
    ) {
      precondition_error(
        "operation",
        `Operation ${field} precondition failed`,
        preconditions[field],
        null,
        { operation_id: operation.id, field },
      );
    }
  }
  if (preconditions.parent_handle !== undefined) {
    const parent = resolve_reference(
      { handle: preconditions.parent_handle },
      states,
      handles,
      `${operation.id}.parent_handle`,
    );
    if (parent.state !== state || parent.entry.id !== entry.parent_id) {
      precondition_error(
        "operation",
        "Operation parent_handle precondition failed",
        preconditions.parent_handle,
        null,
        { operation_id: operation.id, field: "parent_handle" },
      );
    }
  }
}

function validate_intermediate_profile_rules(
  profile,
  request,
  states,
  operation_results,
  operation,
  operation_index,
) {
  const selected_rule_ids = new Set(
    Array.isArray(profile.per_operation_rule) ? profile.per_operation_rule : [],
  );
  if (selected_rule_ids.size === 0) return;
  const validation = validate_profile_candidates({
    profile,
    original_inputs: request.files.map((file) => ({
      index: states.get(file.id).original_index,
    })),
    candidate_inputs: request.files.map((file) => ({
      index: states.get(file.id).index,
    })),
    operation_provenance: operation_results
      .map((result) => result.provenance)
      .filter(Boolean),
    scope: { kind: "all_inputs" },
  });
  const diagnostics = validation.diagnostics.filter(
    (diagnostic) =>
      diagnostic.severity === "error" &&
      selected_rule_ids.has(diagnostic.rule_id),
  );
  if (diagnostics.length === 0) return;
  throw new Yaml_patch_error(
    "VALIDATION_FAILED",
    "Intermediate transaction profile validation failed",
    {
      details: {
        operation_id: operation.id,
        operation_index,
        diagnostic_count: diagnostics.length,
        diagnostics: diagnostics.slice(0, 100),
      },
      next_action:
        "restore the selected profile rule before the next transaction operation",
    },
  );
}

async function plan_transaction(request, options = {}) {
  validate_participants(request);
  validate_transaction_preconditions(request, options);
  const limits = normalized_limits(request);
  validate_initial_limits(request, limits);
  const states = await initialize_states(request, options);
  const handles = new Map();
  const operation_results = [];
  const operation_evidence = [];
  let match_count = 0;
  for (const [operation_order, operation] of request.operations.entries()) {
    if (operation_order > 0 && options.profile) {
      validate_intermediate_profile_rules(
        options.profile,
        request,
        states,
        operation_results,
        operation,
        operation_order,
      );
    }
    if (operation.type === "bind") {
      assert_handle_name(operation.handle);
      const state = states.get(operation.file);
      if (!state || !operation.selector)
        throw_request_error("bind requires file and selector");
      const entry = select_unique_node(state.index, operation.selector);
      match_count += find_nodes(state.index, operation.selector).length;
      validate_operation_preconditions(
        operation,
        { state, entry },
        states,
        handles,
      );
      bind_handle(handles, operation.handle, state, entry);
      operation_results.push({
        id: operation.id,
        type: operation.type,
        handle: operation.handle,
        no_op: true,
      });
      operation_evidence.push({
        id: operation.id,
        type: operation.type,
        file_id: state.file.id,
        locator: entry.locator,
        handle: operation.handle,
        original_range: {
          start_byte: entry.source.start_byte,
          end_byte: entry.source.end_byte,
        },
        candidate_range: {
          start_byte: entry.source.start_byte,
          end_byte: entry.source.end_byte,
        },
        before: {
          raw: raw_for_entry(state, entry),
          typed: typed_for_entry(state, entry),
        },
        after: {
          raw: raw_for_entry(state, entry),
          typed: typed_for_entry(state, entry),
        },
        no_op: true,
      });
      continue;
    }
    if (operation.type === "add_subtree") {
      const destination = resolve_reference(
        operation.destination,
        states,
        handles,
        "add_subtree.destination",
      );
      const destination_match_count = reference_match_count(
        operation.destination,
        destination,
      );
      match_count += destination_match_count;
      validate_operation_preconditions(
        operation,
        destination,
        states,
        handles,
        destination_match_count,
      );
      const compiled = compile_subtree_operation(
        null,
        null,
        { index: destination.state.index },
        destination.entry,
        {
          id: operation.id,
          type: operation.type,
          raw: operation.raw,
          key: operation.key,
          position: operation.destination.position,
        },
      );
      const before = handle_snapshot(
        handles,
        states,
        new Set([destination.state.file.id]),
      );
      apply_compiled(destination.state, compiled.destination, operation_order);
      refresh_handles(handles, states, before);
      const result_entry = entry_for_result_range(
        destination.state,
        compiled.destination.result_range,
      );
      if (operation.result_handle !== undefined) {
        bind_handle(
          handles,
          operation.result_handle,
          destination.state,
          result_entry,
        );
      }
      operation_results.push({
        id: operation.id,
        type: operation.type,
        no_op: false,
        result_range: compiled.destination.result_range,
        result_handle: operation.result_handle,
        provenance: compiled.destination.provenance,
      });
      operation_evidence.push({
        id: operation.id,
        type: operation.type,
        file_id: destination.state.file.id,
        ...(operation.result_handle === undefined
          ? {}
          : {
              handle: operation.result_handle,
              result_handle: operation.result_handle,
            }),
        original_range: null,
        candidate_range: compiled.destination.result_range,
        before: null,
        after: {
          raw: raw_for_entry(destination.state, result_entry),
          typed: typed_for_entry(destination.state, result_entry),
        },
        no_op: false,
      });
      continue;
    }
    if (operation.type === "delete_subtree") {
      const source = resolve_reference(
        operation.source,
        states,
        handles,
        "delete_subtree.source",
      );
      const source_match_count = reference_match_count(
        operation.source,
        source,
      );
      match_count += source_match_count;
      validate_operation_preconditions(
        operation,
        source,
        states,
        handles,
        source_match_count,
      );
      const evidence = evidence_for_target(operation, source);
      const before = handle_snapshot(
        handles,
        states,
        new Set([source.state.file.id]),
      );
      const compiled = compile_subtree_operation(
        { index: source.state.index },
        source.entry,
        null,
        null,
        { id: operation.id, type: operation.type },
      );
      evidence.moved_range = compiled.moved_ranges[0];
      apply_compiled(source.state, compiled.source, operation_order);
      refresh_deleted_subtree_handles(handles, before, source);
      refresh_handles(handles, states, before);
      operation_results.push({
        id: operation.id,
        type: operation.type,
        no_op: false,
        result_range: null,
        provenance: compiled.source.provenance,
      });
      operation_evidence.push({
        ...evidence,
        candidate_range: null,
        after: null,
        no_op: false,
      });
      continue;
    }
    if (
      operation.type === "copy_subtree" ||
      operation.type === "move_subtree"
    ) {
      const source = resolve_reference(
        operation.source,
        states,
        handles,
        `${operation.type}.source`,
      );
      const destination = resolve_reference(
        operation.destination,
        states,
        handles,
        `${operation.type}.destination`,
      );
      const source_match_count = reference_match_count(
        operation.source,
        source,
      );
      match_count += source_match_count + 1;
      validate_operation_preconditions(
        operation,
        source,
        states,
        handles,
        source_match_count,
      );
      const before = handle_snapshot(
        handles,
        states,
        new Set([source.state.file.id, destination.state.file.id]),
      );
      const source_fingerprint = {
        node_type: source.entry.node_type,
        semantic_digest: entry_semantic_digest(
          source.state.index,
          source.entry,
        ),
      };
      const source_before = {
        raw: raw_for_entry(source.state, source.entry),
        typed: typed_for_entry(source.state, source.entry),
      };
      const relocation_evidence = subtree_relocation_evidence(
        source,
        destination,
        operation,
      );
      const compiled = compile_subtree_operation(
        { index: source.state.index },
        source.entry,
        { index: destination.state.index },
        destination.entry,
        {
          id: operation.id,
          type: operation.type,
          position: operation.destination.position,
        },
      );
      if (source.state === destination.state) {
        source.state.piece_table = apply_snapshot_splices(
          source.state.piece_table,
          [...compiled.source.splices, ...compiled.destination.splices].map(
            (splice) => ({ ...splice, operation_order }),
          ),
        );
        source.state.buffer = materialize_piece_table(source.state.piece_table);
        source.state.index = index_for(
          source.state.file,
          source.state.buffer,
          source.state.original_index,
        );
      } else {
        apply_compiled(source.state, compiled.source, operation_order);
        apply_compiled(
          destination.state,
          compiled.destination,
          operation_order,
        );
      }
      const moved_bindings = [];
      if (operation.type === "move_subtree") {
        for (const [name, item] of before) {
          if (
            item.binding.file_id === source.state.file.id &&
            path_starts_with(item.entry.path, source.entry.path)
          ) {
            moved_bindings.push({
              name,
              relative_path: structuredClone(
                item.entry.path.slice(source.entry.path.length),
              ),
            });
          }
        }
      }
      const compiled_result_range =
        compiled.destination.result_range || compiled.source.result_range;
      const final_result_range =
        source.state === destination.state &&
        compiled.destination.result_range !== null
          ? range_after_disjoint_splices(
              compiled_result_range,
              compiled.source.splices,
            )
          : compiled_result_range;
      const result_entry = entry_for_result_range(
        destination.state,
        final_result_range,
      );
      if (
        result_entry.node_type !== source_fingerprint.node_type ||
        entry_semantic_digest(destination.state.index, result_entry) !==
          source_fingerprint.semantic_digest
      ) {
        throw new Yaml_patch_error(
          "PRECONDITION_FAILED",
          "Created subtree result range identifies the wrong node",
          { details: { range: final_result_range } },
        );
      }
      const destination_binding = {
        file_id: destination.state.file.id,
        node_type: result_entry.node_type,
        document: result_entry.document,
        path: structuredClone(result_entry.path),
        semantic_digest: source_fingerprint.semantic_digest,
      };
      for (const moved of moved_bindings) {
        const moved_entry =
          moved.relative_path.length === 0
            ? result_entry
            : resolve_query_path(
                destination.state.index,
                result_entry.document,
                result_entry.path.concat(moved.relative_path),
              );
        const prior_binding = before.get(moved.name).binding;
        if (
          !moved_entry ||
          moved_entry.node_type !== prior_binding.node_type ||
          entry_semantic_digest(destination.state.index, moved_entry) !==
            prior_binding.semantic_digest
        ) {
          throw new Yaml_patch_error(
            "PRECONDITION_FAILED",
            "Moved descendant handle no longer identifies one node",
            { details: { handle: moved.name } },
          );
        }
        handles.set(moved.name, {
          ...destination_binding,
          node_type: moved_entry.node_type,
          document: moved_entry.document,
          path: structuredClone(moved_entry.path),
          semantic_digest: prior_binding.semantic_digest,
        });
        before.delete(moved.name);
      }
      refresh_handles(handles, states, before);
      if (operation.result_handle !== undefined) {
        bind_handle(
          handles,
          operation.result_handle,
          destination.state,
          result_entry,
        );
      }
      const source_range = {
        start_byte: source.entry.source.start_byte,
        end_byte: source.entry.source.end_byte,
      };
      operation_evidence.push({
        id: operation.id,
        type: operation.type,
        file_id: source.state.file.id,
        ...(source.handle === undefined ? {} : { handle: source.handle }),
        locator: source.entry.locator,
        original_range: source_range,
        candidate_range:
          operation.type === "move_subtree" ? null : source_range,
        before: source_before,
        after: operation.type === "move_subtree" ? null : source_before,
        moved_range: compiled.moved_ranges[0],
        ...relocation_evidence,
        no_op: operation.type !== "move_subtree",
      });
      operation_evidence.push({
        id: operation.id,
        type: operation.type,
        file_id: destination.state.file.id,
        ...(operation.result_handle === undefined
          ? {}
          : {
              result_handle: operation.result_handle,
              handle: operation.result_handle,
            }),
        original_range: null,
        candidate_range: {
          start_byte: result_entry.source.start_byte,
          end_byte: result_entry.source.end_byte,
        },
        before: null,
        after: {
          raw: raw_for_entry(destination.state, result_entry),
          typed: typed_for_entry(destination.state, result_entry),
        },
        moved_range: compiled.moved_ranges[0],
        ...relocation_evidence,
        no_op: false,
      });
      operation_results.push({
        id: operation.id,
        type: operation.type,
        no_op: false,
        ...(operation.result_handle === undefined
          ? {}
          : { result_handle: operation.result_handle }),
      });
      continue;
    }

    const target = operation_target(operation, states, handles);
    const evidence = evidence_for_target(operation, target);
    const target_before = target.entry;
    const selector_match_count =
      operation.target && operation.target.selector
        ? find_nodes(target.state.index, operation.target.selector).length
        : 1;
    match_count += selector_match_count;
    validate_operation_preconditions(
      operation,
      target,
      states,
      handles,
      selector_match_count,
    );
    const before = handle_snapshot(
      handles,
      states,
      new Set([target.state.file.id]),
    );
    const compiled = compile_operation(
      { index: target.state.index },
      target.entry,
      structural_operation(operation),
    );
    apply_compiled(target.state, compiled, operation_order);
    refresh_reordered_sequence_handles(handles, before, target, operation);
    refresh_handles(handles, states, before);
    const candidate_entry = candidate_entry_at_path(
      target.state,
      target_before,
    );
    operation_evidence.push({
      ...evidence,
      candidate_range: compiled.result_range,
      after: candidate_entry
        ? {
            raw: raw_for_entry(target.state, candidate_entry),
            typed: typed_for_entry(target.state, candidate_entry),
          }
        : null,
      no_op: compiled.semantic_change.no_op,
    });
    operation_results.push({
      id: operation.id,
      type: operation.type,
      no_op: compiled.semantic_change.no_op,
      result_range: compiled.result_range,
      provenance: compiled.provenance,
    });
  }

  const candidates = {};
  const files = [];
  for (const file of request.files) {
    const state = states.get(file.id);
    const proof = create_multi_range_byte_proof(
      state.original_buffer,
      state.buffer,
      state.piece_table,
    );
    candidates[file.id] = {
      buffer: state.buffer,
      digest: sha256_digest(state.buffer),
      no_op: proof.no_op,
    };
    files.push({ file_id: file.id, path: file.path, proof });
  }
  const operation_order = request.operations.map((operation) => operation.id);
  const transaction_proof = create_transaction_proof(
    files.map((file) => ({
      source_path: path.join(
        path.sep,
        "yaml_patch_transaction",
        encodeURIComponent(file.file_id),
      ),
      proof: file.proof,
    })),
    operation_order,
  );
  let validation = {
    profile_digest: options.profile_digest || null,
    diagnostics: [],
    identity_changes: null,
  };
  if (options.profile) {
    const identity_limits = Object.fromEntries(
      IDENTITY_LIMIT_FIELDS.filter((field) => limits[field] !== undefined).map(
        (field) => [field, limits[field]],
      ),
    );
    validation = validate_profile_candidates({
      profile: options.profile,
      original_inputs: request.files.map((file) => ({
        index: states.get(file.id).original_index,
      })),
      candidate_inputs: request.files.map((file) => ({
        index: states.get(file.id).index,
      })),
      operation_provenance: operation_results
        .map((operation) => operation.provenance)
        .filter(Boolean),
      scope: { kind: "all_inputs" },
      limits: identity_limits,
    });
    const errors = validation.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    );
    if (errors.length > 0) {
      throw new Yaml_patch_error(
        "VALIDATION_FAILED",
        "Final transaction profile validation failed",
        {
          details: {
            diagnostic_count: errors.length,
            diagnostics: errors.slice(0, 100),
          },
        },
      );
    }
  }
  const changed_operations = operation_results.filter(
    (operation) => !operation.no_op,
  );
  const added_node = changed_operations.filter((operation) =>
    [
      "add_subtree",
      "copy_subtree",
      "add_mapping_pair",
      "append_sequence_item",
      "prepend_sequence_item",
      "insert_sequence_item",
      "append_unique_sequence_value",
    ].includes(operation.type),
  ).length;
  const deleted_node = changed_operations.filter((operation) =>
    [
      "delete_subtree",
      "delete_mapping_pair",
      "delete_sequence_item",
      "delete_one_sequence_value",
      "delete_all_sequence_values",
    ].includes(operation.type),
  ).length;
  const moved_node = changed_operations.filter((operation) =>
    ["move_subtree", "move_mapping_pair", "move_sequence_item"].includes(
      operation.type,
    ),
  ).length;
  const range_count = files.reduce(
    (total, file) => total + file.proof.ranges.length,
    0,
  );
  const total_touched_byte = files.reduce(
    (total, file) => total + file.proof.summary.touched_bytes,
    0,
  );
  enforce_limit(limits, "max_match", match_count);
  enforce_limit(limits, "max_range", range_count);
  enforce_limit(limits, "max_added_node", added_node);
  enforce_limit(limits, "max_deleted_node", deleted_node);
  enforce_limit(limits, "max_moved_node", moved_node);
  for (const file of files) {
    enforce_limit(
      limits,
      "max_touched_byte_per_file",
      file.proof.summary.touched_bytes,
      { file_id: file.file_id },
    );
  }
  enforce_limit(limits, "max_touched_byte_total", total_touched_byte);
  const diffs = files.map((file) => {
    const state = states.get(file.file_id);
    return create_file_diff({
      file_id: file.file_id,
      path: file.path,
      original_buffer: state.original_buffer,
      candidate_buffer: state.buffer,
      proof: file.proof,
      operations: operation_evidence.filter(
        (operation) => operation.file_id === file.file_id,
      ),
    });
  });
  const no_op = files.every((file) => file.proof.no_op);
  const manifest = create_transaction_manifest({
    request,
    result: {
      no_op,
      operation_order,
      files: files.map((file, index) => ({
        file_id: file.file_id,
        path: file.path,
        original_digest: file.proof.original_digest,
        candidate_digest: file.proof.candidate_digest,
        no_op: file.proof.no_op,
        proof: file.proof,
        diff: diffs[index].structured,
      })),
      validation,
      transaction_proof,
    },
    profile_digest: validation.profile_digest || options.profile_digest || null,
    capability_digest: options.capability_digest || null,
    tool_version: options.tool_version || null,
  });
  return {
    no_op,
    operation_order,
    operations: operation_results,
    candidates,
    files,
    transaction_proof,
    diffs,
    validation,
    manifest,
  };
}

module.exports = { participant_digest_for, plan_transaction };
