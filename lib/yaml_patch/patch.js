"use strict";

const YAML = require("yaml");

const {
  build_edit_package,
  normalize_limits,
  validate_manifest,
} = require("./fragment");
const { resolve_edit_range } = require("./edit_range");
const { request_error, Yaml_patch_error } = require("./error");
const { build_node_index, get_index_node } = require("./node_index");
const { create_byte_proof, format_text_diff } = require("./proof");
const { select_unique_node } = require("./query");
const { create_source_record, sha256_digest } = require("./source");
const { parse_yaml_source } = require("./parser");
const {
  assert_known_fields,
  assert_non_empty_string,
  assert_non_negative_integer,
  assert_sha256_digest,
} = require("./schema");
const {
  assert_no_cross_boundary_dependencies,
  validate_candidate_index,
  validate_source_index,
} = require("./validate");

function validate_change_limits(manifest, replacement_buffer) {
  const limits = normalize_limits(manifest.limits);
  const deleted_bytes = manifest.target.end_byte - manifest.target.start_byte;
  const inserted_bytes = replacement_buffer.length;
  const touched_bytes = deleted_bytes + inserted_bytes;
  if (
    deleted_bytes > limits.max_deleted_bytes ||
    inserted_bytes > limits.max_inserted_bytes ||
    touched_bytes > limits.max_touched_bytes
  ) {
    throw new Yaml_patch_error(
      "CHANGE_LIMIT_EXCEEDED",
      "Patch exceeds its declared byte limits",
      {
        details: { deleted_bytes, inserted_bytes, touched_bytes, limits },
        next_action: "review the patch and explicitly increase its byte limits",
      },
    );
  }
}

function candidate_source_record(original_source, candidate_buffer) {
  return create_source_record(candidate_buffer, {
    file_path: original_source.file_path,
    requested_path: original_source.requested_path,
    file_type: original_source.file_type,
    mode: original_source.mode,
    uid: original_source.uid,
    gid: original_source.gid,
    hard_link_count: original_source.hard_link_count,
    device: original_source.device,
    inode: original_source.inode,
  });
}

function compile_fragment_patch(index, raw_manifest, replacement_buffer) {
  const manifest = validate_manifest(raw_manifest);
  if (!Buffer.isBuffer(replacement_buffer)) {
    throw new TypeError("replacement_buffer must be a Buffer");
  }
  validate_source_index(index);
  if (index.source.digest !== manifest.source.digest) {
    throw new Yaml_patch_error(
      "SOURCE_CHANGED",
      "Source file changed after extract",
      {
        recoverable: true,
        next_action: "run extract again",
        details: {
          expected_digest: manifest.source.digest,
          actual_digest: index.source.digest,
        },
      },
    );
  }
  const { start_byte, end_byte } = manifest.target;
  if (
    !Number.isInteger(start_byte) ||
    !Number.isInteger(end_byte) ||
    start_byte < 0 ||
    end_byte < start_byte ||
    end_byte > index.source.buffer.length
  ) {
    throw new Yaml_patch_error(
      "INVALID_FRAGMENT",
      "Manifest target range is outside the source",
    );
  }
  const current_target = index.source.buffer.subarray(start_byte, end_byte);
  const current_target_digest = sha256_digest(current_target);
  if (current_target_digest !== manifest.target.raw_digest) {
    throw new Yaml_patch_error(
      "TARGET_CHANGED",
      "Target bytes changed after extract",
      {
        recoverable: true,
        next_action: "run extract again",
        details: {
          expected_digest: manifest.target.raw_digest,
          actual_digest: current_target_digest,
        },
      },
    );
  }
  const manifest_entry = entry_from_locator(index, manifest.target.locator);
  if (!manifest_entry) {
    throw new Yaml_patch_error(
      "INVALID_FRAGMENT",
      "Manifest locator is not valid for the current source index",
    );
  }
  const resolved_range = resolve_edit_range(
    index,
    manifest_entry,
    manifest.target.edit_unit,
  );
  if (
    manifest_entry.document !== manifest.target.document ||
    manifest_entry.node_type !== manifest.target.node_type ||
    JSON.stringify(manifest_entry.path) !==
      JSON.stringify(manifest.target.path) ||
    resolved_range.start_byte !== start_byte ||
    resolved_range.end_byte !== end_byte ||
    resolved_range.raw_digest !== manifest.target.raw_digest
  ) {
    throw new Yaml_patch_error(
      "INVALID_FRAGMENT",
      "Manifest locator, path, edit unit, and byte range are inconsistent",
    );
  }
  if (
    manifest.dependencies &&
    manifest.dependencies.cross_boundary_anchor_alias
  ) {
    throw new Yaml_patch_error(
      "CROSS_BOUNDARY_DEPENDENCY",
      "Manifest target has a cross-boundary anchor/alias dependency",
    );
  }

  if (current_target.equals(replacement_buffer)) {
    const proof = create_byte_proof(index.source.buffer, index.source.buffer, {
      start_byte,
      end_byte,
      replacement_buffer: current_target,
    });
    return {
      no_op: true,
      candidate_buffer: index.source.buffer,
      candidate_digest: index.source.digest,
      proof,
      summary: proof.summary,
      text_diff: "",
    };
  }

  validate_change_limits(manifest, replacement_buffer);
  const candidate_buffer = Buffer.concat([
    index.source.buffer.subarray(0, start_byte),
    replacement_buffer,
    index.source.buffer.subarray(end_byte),
  ]);
  const candidate_source = candidate_source_record(
    index.source,
    candidate_buffer,
  );
  const candidate_index = build_node_index(
    candidate_source,
    parse_yaml_source(candidate_source),
  );
  validate_candidate_index(index, candidate_index);

  let candidate_entry;
  try {
    candidate_entry = select_unique_node(candidate_index, {
      version: 1,
      document: manifest.target.document,
      path: manifest.target.path,
    });
  } catch (error) {
    throw new Yaml_patch_error(
      "INVALID_FRAGMENT",
      "Candidate no longer contains the exact target path",
      { cause: error },
    );
  }
  if (candidate_entry.node_type !== manifest.target.node_type) {
    throw new Yaml_patch_error(
      "INVALID_FRAGMENT",
      `Candidate changes node class from ${manifest.target.node_type} to ${candidate_entry.node_type}`,
      {
        details: {
          expected_node_type: manifest.target.node_type,
          actual_node_type: candidate_entry.node_type,
        },
      },
    );
  }
  const candidate_range = {
    start_byte: candidate_entry.source.start_byte,
    end_byte: candidate_entry.source.end_byte,
  };
  if (
    candidate_range.start_byte !== start_byte ||
    candidate_range.end_byte !== start_byte + replacement_buffer.length
  ) {
    throw new Yaml_patch_error(
      "INVALID_FRAGMENT",
      "Replacement bytes do not exactly form the candidate target node",
      {
        details: {
          expected_start_byte: start_byte,
          expected_end_byte: start_byte + replacement_buffer.length,
          ...candidate_range,
        },
      },
    );
  }
  assert_no_cross_boundary_dependencies(candidate_index, candidate_range);

  const proof = create_byte_proof(index.source.buffer, candidate_buffer, {
    start_byte,
    end_byte,
    replacement_buffer,
  });
  return {
    no_op: false,
    candidate_buffer,
    candidate_digest: proof.candidate_digest,
    candidate_index,
    proof,
    summary: proof.summary,
    text_diff: format_text_diff(
      index.source.buffer,
      replacement_buffer,
      manifest.target,
      index.source.file_path,
    ),
  };
}

function entry_from_locator(index, locator) {
  return index.entries.find((entry) => entry.locator === locator) || null;
}

function serialize_operation_value(value) {
  return Buffer.from(YAML.stringify(value).replace(/\n$/, ""), "utf8");
}

const OPERATION_TYPE = new Set([
  "replace_node_value",
  "replace_scalar_token",
  "set_mapping_value",
]);
const PATCH_LIMIT_FIELDS = [
  "expect_matches",
  "max_deleted_bytes",
  "max_inserted_bytes",
  "max_touched_bytes",
];

function validate_operation_request_entry(operation_entry) {
  const error_code = "REQUEST_ERROR";
  assert_known_fields(
    operation_entry,
    ["target", "operation", "limits"],
    "patch operation entry",
    error_code,
  );

  const target = operation_entry.target;
  assert_known_fields(
    target,
    ["locator", "expected_digest"],
    "patch target",
    error_code,
  );
  assert_non_empty_string(target.locator, "patch target locator", error_code);
  if (Object.hasOwn(target, "expected_digest")) {
    assert_sha256_digest(
      target.expected_digest,
      "patch target expected_digest",
      error_code,
    );
  }

  const operation = operation_entry.operation;
  assert_known_fields(
    operation,
    ["type", "key", "value"],
    "patch operation",
    error_code,
  );
  assert_non_empty_string(operation.type, "patch operation type", error_code);

  const limits = Object.hasOwn(operation_entry, "limits")
    ? operation_entry.limits
    : {};
  assert_known_fields(limits, PATCH_LIMIT_FIELDS, "patch limits", error_code);
  for (const field of PATCH_LIMIT_FIELDS) {
    if (!Object.hasOwn(limits, field)) continue;
    assert_non_negative_integer(
      limits[field],
      `patch limits ${field}`,
      error_code,
    );
  }
  if (Object.hasOwn(limits, "expect_matches") && limits.expect_matches !== 1) {
    throw request_error("patch limits expect_matches must equal 1", {
      details: { field: "expect_matches", value: limits.expect_matches },
    });
  }

  if (!OPERATION_TYPE.has(operation.type)) {
    throw new Yaml_patch_error(
      "UNSUPPORTED_EDIT_UNIT",
      `Unsupported first-version operation: ${operation.type}`,
    );
  }
  const operation_fields =
    operation.type === "set_mapping_value"
      ? ["type", "key", "value"]
      : ["type", "value"];
  assert_known_fields(
    operation,
    operation_fields,
    "patch operation",
    error_code,
  );
  if (operation.type === "set_mapping_value") {
    if (
      typeof operation.key !== "string" ||
      !Object.hasOwn(operation, "value")
    ) {
      throw request_error(
        "set_mapping_value requires a mapping target, string key, and value",
      );
    }
  } else if (
    !Object.hasOwn(operation, "value") ||
    typeof operation.value !== "string"
  ) {
    throw request_error(`${operation.type} requires a raw string value`);
  }

  return { limits, operation, target };
}

function prepare_operation_patch(index, patch_document) {
  const validation_code = "REQUEST_ERROR";
  assert_known_fields(
    patch_document,
    new Set(["version", "operations"]),
    "patch",
    validation_code,
  );
  if (patch_document.version !== 1) {
    throw new Yaml_patch_error(
      "PROTOCOL_VERSION_UNSUPPORTED",
      `Unsupported operation document version: ${patch_document.version}`,
      {
        details: { kind: "operation", version: patch_document.version },
      },
    );
  }
  if (!Array.isArray(patch_document.operations)) {
    throw new Yaml_patch_error(
      "REQUEST_ERROR",
      "Patch document must contain a version 1 operations array",
    );
  }
  if (patch_document.operations.length !== 1) {
    throw new Yaml_patch_error(
      "UNSUPPORTED_EDIT_UNIT",
      "The first version requires exactly one patch operation",
      { details: { operation_count: patch_document.operations.length } },
    );
  }
  const operation_entry = patch_document.operations[0];
  const { limits, operation, target } =
    validate_operation_request_entry(operation_entry);
  const selected_entry = entry_from_locator(index, target.locator);
  if (!selected_entry) {
    throw new Yaml_patch_error(
      "NO_MATCH",
      "Patch locator is not valid for source",
    );
  }
  if (
    Object.hasOwn(target, "expected_digest") &&
    target.expected_digest !== selected_entry.raw_digest
  ) {
    throw new Yaml_patch_error("TARGET_CHANGED", "Patch target digest differs");
  }

  let target_entry = selected_entry;
  let edit_unit;
  let replacement_buffer;
  if (operation.type === "set_mapping_value") {
    const selected_node = get_index_node(index, selected_entry);
    if (!YAML.isMap(selected_node)) {
      throw new Yaml_patch_error(
        "INVALID_FRAGMENT",
        "set_mapping_value requires a mapping target",
      );
    }
    target_entry = select_unique_node(index, {
      version: 1,
      document: selected_entry.document,
      path: selected_entry.path.concat({ mapping_key: operation.key }),
    });
    edit_unit = "mapping-value";
    replacement_buffer = serialize_operation_value(operation.value);
  } else if (operation.type === "replace_scalar_token") {
    edit_unit = "scalar-token";
    replacement_buffer = Buffer.from(operation.value, "utf8");
  } else if (operation.type === "replace_node_value") {
    edit_unit = "node-value";
    replacement_buffer = Buffer.from(operation.value, "utf8");
  } else {
    throw new Yaml_patch_error(
      "UNSUPPORTED_EDIT_UNIT",
      `Unsupported first-version operation: ${operation.type}`,
    );
  }

  const edit_package = build_edit_package(index, target_entry, {
    edit_unit,
    limits,
  });
  edit_package.fragment_buffer = replacement_buffer;
  return edit_package;
}

function compile_operation_patch(index, patch_document) {
  const edit_package = prepare_operation_patch(index, patch_document);
  return compile_fragment_patch(
    index,
    edit_package.manifest,
    edit_package.fragment_buffer,
  );
}

module.exports = {
  compile_fragment_patch,
  compile_operation_patch,
  entry_from_locator,
  prepare_operation_patch,
  serialize_operation_value,
  validate_change_limits,
  validate_operation_request_entry,
};
