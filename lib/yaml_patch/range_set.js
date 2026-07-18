"use strict";

const path = require("node:path");
const { types } = require("node:util");

const {
  canonical_digest,
  canonical_json,
  clone_json_value,
  validate_artifact_version,
} = require("./artifact_version");
const { Yaml_patch_error } = require("./error");
const { sha256_digest } = require("./source");

const PIECE_TABLE_FORMAT = "yaml_patch-piece-table";
const PIECE_TABLE_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function byte_error(message, details = {}) {
  throw new Yaml_patch_error("BYTE_GUARANTEE_FAILED", message, {
    details,
    next_action: "provide ordered, non-overlapping byte splices",
  });
}

function ensure_buffer(value, label) {
  if (!Buffer.isBuffer(value)) byte_error(`${label} must be a Buffer`);
}

function assert_proof_object(value, allowed_fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    byte_error(`${label} must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (!allowed_fields.has(field)) {
      byte_error(`Unknown ${label} field: ${field}`);
    }
  }
  return value;
}

function assert_proof_integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    byte_error(`${label} must be a safe integer of at least ${minimum}`);
  }
  return value;
}

function assert_proof_digest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    byte_error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function validate_proof_span(value, label, digest_fields = []) {
  const allowed_fields = new Set([
    "original_start_byte",
    "original_end_byte",
    "candidate_start_byte",
    "candidate_end_byte",
    ...digest_fields,
    "operation_ids",
    "position",
  ]);
  assert_proof_object(value, allowed_fields, label);
  for (const field of [
    "original_start_byte",
    "original_end_byte",
    "candidate_start_byte",
    "candidate_end_byte",
  ]) {
    assert_proof_integer(value[field], `${label}.${field}`);
  }
  if (
    value.original_end_byte < value.original_start_byte ||
    value.candidate_end_byte < value.candidate_start_byte
  ) {
    byte_error(`${label} has a reversed byte range`);
  }
  for (const field of digest_fields) {
    assert_proof_digest(value[field], `${label}.${field}`);
  }
  return value;
}

function validate_proof_operation(operation, index) {
  const label = `byte proof operation ${index}`;
  assert_proof_object(
    operation,
    new Set([
      "operation_id",
      "operation_order",
      "no_op_at_application",
      "present_in_final",
      "final_ranges",
      "steps",
    ]),
    label,
  );
  if (
    typeof operation.operation_id !== "string" ||
    operation.operation_id.length === 0
  ) {
    byte_error(`${label}.operation_id must be non-empty`);
  }
  if (operation.operation_order !== undefined) {
    assert_proof_integer(operation.operation_order, `${label}.operation_order`);
  }
  if (
    typeof operation.no_op_at_application !== "boolean" ||
    typeof operation.present_in_final !== "boolean" ||
    !Array.isArray(operation.final_ranges) ||
    !Array.isArray(operation.steps) ||
    operation.steps.length === 0
  ) {
    byte_error(`${label} has invalid status or range arrays`);
  }
  operation.final_ranges.forEach((range, range_index) => {
    validate_proof_span(range, `${label}.final_ranges[${range_index}]`);
    if (
      range.operation_ids !== undefined ||
      range.position !== undefined ||
      (range.original_start_byte === range.original_end_byte &&
        range.candidate_start_byte === range.candidate_end_byte)
    ) {
      byte_error(`${label}.final_ranges[${range_index}] is invalid`);
    }
  });
  if (operation.present_in_final !== operation.final_ranges.length > 0) {
    byte_error(`${label}.present_in_final is inconsistent`);
  }
  for (const [step_index, step] of operation.steps.entries()) {
    const step_label = `${label}.steps[${step_index}]`;
    assert_proof_object(
      step,
      new Set([
        "no_op",
        "snapshot_start_byte",
        "snapshot_end_byte",
        "anchor_original_byte",
        "removed_original_ranges",
        "removed_digest",
        "replacement_digest",
      ]),
      step_label,
    );
    if (typeof step.no_op !== "boolean") {
      byte_error(`${step_label}.no_op must be boolean`);
    }
    for (const field of [
      "snapshot_start_byte",
      "snapshot_end_byte",
      "anchor_original_byte",
    ]) {
      assert_proof_integer(step[field], `${step_label}.${field}`);
    }
    if (step.snapshot_end_byte < step.snapshot_start_byte) {
      byte_error(`${step_label} has a reversed snapshot range`);
    }
    if (!Array.isArray(step.removed_original_ranges)) {
      byte_error(`${step_label}.removed_original_ranges must be an array`);
    }
    for (const [range_index, range] of step.removed_original_ranges.entries()) {
      const range_label = `${step_label}.removed_original_ranges[${range_index}]`;
      assert_proof_object(
        range,
        new Set(["start_byte", "end_byte"]),
        range_label,
      );
      assert_proof_integer(range.start_byte, `${range_label}.start_byte`);
      assert_proof_integer(range.end_byte, `${range_label}.end_byte`);
      if (range.end_byte < range.start_byte) {
        byte_error(`${range_label} is reversed`);
      }
    }
    assert_proof_digest(step.removed_digest, `${step_label}.removed_digest`);
    assert_proof_digest(
      step.replacement_digest,
      `${step_label}.replacement_digest`,
    );
  }
  if (
    operation.no_op_at_application !==
    operation.steps.every((step) => step.no_op)
  ) {
    byte_error(`${label}.no_op_at_application is inconsistent`);
  }
  return operation.operation_id;
}

function compare_proof_ranges(left, right) {
  for (const field of [
    "original_start_byte",
    "original_end_byte",
    "candidate_start_byte",
    "candidate_end_byte",
  ]) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  return 0;
}

function proof_range_coordinates_equal(left, right) {
  return compare_proof_ranges(left, right) === 0;
}

function validate_operation_provenance(
  operations,
  ranges,
  original_extent,
  candidate_extent,
  snapshot_extent_limit,
) {
  for (const [index, operation] of operations.entries()) {
    const label = `byte proof operation ${index}`;
    for (const [step_index, step] of operation.steps.entries()) {
      if (
        step.anchor_original_byte > original_extent ||
        (snapshot_extent_limit !== null &&
          step.snapshot_end_byte > snapshot_extent_limit)
      ) {
        byte_error(`${label}.steps[${step_index}] snapshot is out of bounds`);
      }
      let previous_end_byte = -1;
      for (const [
        range_index,
        range,
      ] of step.removed_original_ranges.entries()) {
        if (
          range.end_byte > original_extent ||
          range.end_byte === range.start_byte ||
          range.start_byte < previous_end_byte
        ) {
          byte_error(
            `${label}.steps[${step_index}].removed_original_ranges[${range_index}] is noncanonical or out of bounds`,
          );
        }
        previous_end_byte = range.end_byte;
      }
    }

    const named_ranges = ranges.filter((range) =>
      range.operation_ids.includes(operation.operation_id),
    );
    if (operation.present_in_final !== named_ranges.length > 0) {
      byte_error(`${label}.present_in_final conflicts with root ranges`);
    }
    if (operation.final_ranges.length !== named_ranges.length) {
      byte_error(`${label}.final_ranges do not match named root ranges`);
    }
    for (const [range_index, range] of operation.final_ranges.entries()) {
      if (
        range.original_end_byte > original_extent ||
        range.candidate_end_byte > candidate_extent ||
        !proof_range_coordinates_equal(range, named_ranges[range_index])
      ) {
        byte_error(
          `${label}.final_ranges[${range_index}] does not match its named root range`,
        );
      }
    }
  }
}

function validate_reconstructible_step_digests(
  operations,
  original_buffer,
  candidate_buffer,
) {
  if (operations.length !== 1) return;
  for (const [index, operation] of operations.entries()) {
    if (
      !operation.present_in_final ||
      operation.final_ranges.length !== 1 ||
      operation.steps.length !== 1
    ) {
      continue;
    }
    const final_range = operation.final_ranges[0];
    const step = operation.steps[0];
    const removed_range = step.removed_original_ranges[0];
    if (
      step.snapshot_start_byte !== final_range.candidate_start_byte ||
      step.snapshot_end_byte !== final_range.candidate_end_byte ||
      !removed_range ||
      removed_range.start_byte !== final_range.original_start_byte ||
      removed_range.end_byte !== final_range.original_end_byte
    ) {
      continue;
    }
    if (
      sha256_digest(
        original_buffer.subarray(
          final_range.original_start_byte,
          final_range.original_end_byte,
        ),
      ) !== step.removed_digest ||
      sha256_digest(
        candidate_buffer.subarray(
          final_range.candidate_start_byte,
          final_range.candidate_end_byte,
        ),
      ) !== step.replacement_digest
    ) {
      byte_error(
        `Byte proof operation ${index} step digests do not bind the supplied buffers`,
      );
    }
  }
}

function validate_named_step_digests(operations, ranges) {
  if (operations.length !== 1) return;
  const operation = operations[0];
  if (
    !operation.present_in_final ||
    operation.final_ranges.length !== 1 ||
    operation.steps.length !== 1
  ) {
    return;
  }
  const named_ranges = ranges.filter((range) =>
    range.operation_ids.includes(operation.operation_id),
  );
  if (named_ranges.length !== 1) return;
  const final_range = operation.final_ranges[0];
  const root_range = named_ranges[0];
  const step = operation.steps[0];
  if (
    !proof_range_coordinates_equal(final_range, root_range) ||
    step.snapshot_start_byte !== final_range.candidate_start_byte ||
    step.snapshot_end_byte !== final_range.candidate_end_byte
  ) {
    return;
  }
  const removed_ranges = step.removed_original_ranges;
  const removed_range_matches =
    final_range.original_start_byte === final_range.original_end_byte
      ? removed_ranges.length === 0
      : removed_ranges.length === 1 &&
        removed_ranges[0].start_byte === final_range.original_start_byte &&
        removed_ranges[0].end_byte === final_range.original_end_byte;
  if (!removed_range_matches) return;
  if (
    step.removed_digest !== root_range.original_digest ||
    step.replacement_digest !== root_range.replacement_digest
  ) {
    byte_error(
      `Byte proof operation ${operation.operation_id} step digests do not bind its root range`,
    );
  }
}

function validate_proof_partition(spans, start_field, end_field, total, label) {
  const ordered = spans
    .map((span) => ({ start: span[start_field], end: span[end_field] }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let cursor = 0;
  for (const span of ordered) {
    if (span.start !== cursor || span.end > total) {
      byte_error(`${label} does not cover the buffer exactly`, {
        cursor,
        span,
        total,
      });
    }
    cursor = span.end;
  }
  if (cursor !== total) {
    byte_error(`${label} does not reach the end of the buffer`, {
      cursor,
      total,
    });
  }
}

function validate_byte_proof(proof, options = {}) {
  let validated;
  try {
    validated = clone_json_value(proof, "byte proof");
  } catch (error) {
    byte_error("Byte proof must contain plain JSON data", {
      reason: error.message,
    });
  }
  if (!validated || typeof validated !== "object" || Array.isArray(validated)) {
    byte_error("Byte proof must be an object");
  }
  validate_artifact_version("proof", validated.version);
  const root_fields = new Set([
    "format",
    "version",
    "verified",
    "no_op",
    "original_digest",
    "candidate_digest",
    "ranges",
    "unchanged_regions",
    "summary",
    ...(validated.version === 2 ? ["operations"] : []),
  ]);
  assert_proof_object(validated, root_fields, "byte proof");
  if (
    validated.format !== "yaml_patch-byte-proof" ||
    validated.verified !== true ||
    typeof validated.no_op !== "boolean" ||
    !Array.isArray(validated.ranges) ||
    !Array.isArray(validated.unchanged_regions)
  ) {
    byte_error("Invalid or unverified byte proof");
  }
  assert_proof_digest(validated.original_digest, "byte proof original_digest");
  assert_proof_digest(
    validated.candidate_digest,
    "byte proof candidate_digest",
  );
  const summary = assert_proof_object(
    validated.summary,
    new Set(["deleted_bytes", "inserted_bytes", "touched_bytes", "size_delta"]),
    "byte proof summary",
  );
  for (const field of ["deleted_bytes", "inserted_bytes", "touched_bytes"]) {
    assert_proof_integer(summary[field], `byte proof summary.${field}`);
  }
  if (!Number.isSafeInteger(summary.size_delta)) {
    byte_error("byte proof summary.size_delta must be a safe integer");
  }

  const operation_ids = new Set();
  const operations = validated.version === 2 ? validated.operations : [];
  if (validated.version === 2) {
    if (!Array.isArray(operations)) {
      byte_error("Version 2 byte proof operations must be an array");
    }
    for (const [index, operation] of operations.entries()) {
      const operation_id = validate_proof_operation(operation, index);
      if (operation_ids.has(operation_id)) {
        byte_error("Byte proof contains duplicate operation IDs", {
          operation_id,
        });
      }
      operation_ids.add(operation_id);
    }
  }

  let previous_root_range;
  for (const [index, range] of validated.ranges.entries()) {
    validate_proof_span(range, `byte proof range ${index}`, [
      "original_digest",
      "replacement_digest",
    ]);
    if (validated.version === 2) {
      if (
        !Array.isArray(range.operation_ids) ||
        range.operation_ids.length === 0 ||
        new Set(range.operation_ids).size !== range.operation_ids.length ||
        range.operation_ids.some(
          (operation_id) =>
            typeof operation_id !== "string" ||
            !operation_ids.has(operation_id),
        )
      ) {
        byte_error(`byte proof range ${index} has invalid operation IDs`);
      }
    } else if (range.operation_ids !== undefined) {
      byte_error(`Version 1 byte proof range ${index} has operation IDs`);
    }
    if (range.position !== undefined) {
      byte_error(`byte proof range ${index} has an invalid position`);
    }
    if (
      range.original_start_byte === range.original_end_byte &&
      range.candidate_start_byte === range.candidate_end_byte &&
      !(validated.version === 1 && validated.no_op)
    ) {
      byte_error(`byte proof range ${index} describes no changed bytes`);
    }
    if (
      previous_root_range &&
      compare_proof_ranges(previous_root_range, range) >= 0
    ) {
      byte_error("Byte proof root ranges are not in canonical order");
    }
    previous_root_range = range;
  }
  for (const [index, region] of validated.unchanged_regions.entries()) {
    validate_proof_span(region, `byte proof unchanged region ${index}`, [
      "digest",
    ]);
    if (region.operation_ids !== undefined) {
      byte_error(`byte proof unchanged region ${index} has operation IDs`);
    }
    if (
      (validated.version === 1 &&
        !["before", "after"].includes(region.position)) ||
      (validated.version === 2 && region.position !== undefined)
    ) {
      byte_error(
        `byte proof unchanged region ${index} has an invalid position`,
      );
    }
  }

  const deleted_bytes = validated.ranges.reduce(
    (total, range) =>
      total + range.original_end_byte - range.original_start_byte,
    0,
  );
  const inserted_bytes = validated.ranges.reduce(
    (total, range) =>
      total + range.candidate_end_byte - range.candidate_start_byte,
    0,
  );
  const expected_deleted_bytes =
    validated.version === 1 && validated.no_op ? 0 : deleted_bytes;
  const expected_inserted_bytes =
    validated.version === 1 && validated.no_op ? 0 : inserted_bytes;
  if (
    summary.deleted_bytes !== expected_deleted_bytes ||
    summary.inserted_bytes !== expected_inserted_bytes ||
    summary.touched_bytes !==
      expected_deleted_bytes + expected_inserted_bytes ||
    summary.size_delta !== expected_inserted_bytes - expected_deleted_bytes
  ) {
    byte_error("Byte proof summary is inconsistent with its ranges");
  }
  if (
    validated.no_op !==
      (validated.original_digest === validated.candidate_digest) ||
    (validated.version === 2 &&
      validated.no_op &&
      validated.ranges.length !== 0) ||
    (!validated.no_op && validated.ranges.length === 0)
  ) {
    byte_error("Byte proof no_op status is inconsistent");
  }

  const spans = validated.ranges.concat(validated.unchanged_regions);
  if (spans.length === 0) {
    byte_error("Byte proof must describe at least one byte span");
  }
  const original_extent = spans.reduce(
    (maximum, span) => Math.max(maximum, span.original_end_byte),
    0,
  );
  const candidate_extent = spans.reduce(
    (maximum, span) => Math.max(maximum, span.candidate_end_byte),
    0,
  );
  validate_proof_partition(
    spans,
    "original_start_byte",
    "original_end_byte",
    original_extent,
    "Byte proof original spans",
  );
  validate_proof_partition(
    spans,
    "candidate_start_byte",
    "candidate_end_byte",
    candidate_extent,
    "Byte proof candidate spans",
  );
  if (candidate_extent - original_extent !== summary.size_delta) {
    byte_error("Byte proof span sizes conflict with its summary");
  }
  if (validated.version === 2) {
    validate_operation_provenance(
      operations,
      validated.ranges,
      original_extent,
      candidate_extent,
      operations.length === 1
        ? Math.max(original_extent, candidate_extent) + summary.touched_bytes
        : null,
    );
    validate_named_step_digests(operations, validated.ranges);
  }

  const has_original = Object.hasOwn(options, "original_buffer");
  const has_candidate = Object.hasOwn(options, "candidate_buffer");
  if (has_original !== has_candidate) {
    byte_error("Byte proof validation requires both buffers or neither");
  }
  if (!has_original) return validated;
  ensure_buffer(options.original_buffer, "original_buffer");
  ensure_buffer(options.candidate_buffer, "candidate_buffer");
  const original_buffer = options.original_buffer;
  const candidate_buffer = options.candidate_buffer;
  if (
    sha256_digest(original_buffer) !== validated.original_digest ||
    sha256_digest(candidate_buffer) !== validated.candidate_digest ||
    original_buffer.equals(candidate_buffer) !== validated.no_op ||
    candidate_buffer.length - original_buffer.length !== summary.size_delta
  ) {
    byte_error("Byte proof does not bind the supplied buffers");
  }
  for (const [index, range] of validated.ranges.entries()) {
    if (
      range.original_end_byte > original_buffer.length ||
      range.candidate_end_byte > candidate_buffer.length ||
      sha256_digest(
        original_buffer.subarray(
          range.original_start_byte,
          range.original_end_byte,
        ),
      ) !== range.original_digest ||
      sha256_digest(
        candidate_buffer.subarray(
          range.candidate_start_byte,
          range.candidate_end_byte,
        ),
      ) !== range.replacement_digest
    ) {
      byte_error(
        `Byte proof range ${index} does not bind the supplied buffers`,
      );
    }
  }
  for (const [index, region] of validated.unchanged_regions.entries()) {
    const original = original_buffer.subarray(
      region.original_start_byte,
      region.original_end_byte,
    );
    const candidate = candidate_buffer.subarray(
      region.candidate_start_byte,
      region.candidate_end_byte,
    );
    if (
      region.original_end_byte > original_buffer.length ||
      region.candidate_end_byte > candidate_buffer.length ||
      !original.equals(candidate) ||
      sha256_digest(original) !== region.digest
    ) {
      byte_error(
        `Byte proof unchanged region ${index} does not bind the supplied buffers`,
      );
    }
  }
  validate_proof_partition(
    spans,
    "original_start_byte",
    "original_end_byte",
    original_buffer.length,
    "Byte proof original spans",
  );
  validate_proof_partition(
    spans,
    "candidate_start_byte",
    "candidate_end_byte",
    candidate_buffer.length,
    "Byte proof candidate spans",
  );
  if (validated.version === 2) {
    validate_reconstructible_step_digests(
      operations,
      original_buffer,
      candidate_buffer,
    );
  }
  return validated;
}

function piece_length(piece) {
  return piece.kind === "original"
    ? piece.original_end_byte - piece.original_start_byte
    : piece.buffer.length;
}

function clone_piece(piece) {
  return piece.kind === "original"
    ? { ...piece }
    : {
        ...piece,
        buffer: Buffer.from(piece.buffer),
        operation_ids: [...piece.operation_ids],
      };
}

function clone_edit(edit) {
  return {
    ...edit,
    removed_original_ranges: edit.removed_original_ranges.map((range) => ({
      ...range,
    })),
  };
}

function assert_piece_table(table) {
  if (
    !table ||
    typeof table !== "object" ||
    types.isProxy(table) ||
    table.format !== PIECE_TABLE_FORMAT ||
    table.version !== PIECE_TABLE_VERSION ||
    !Buffer.isBuffer(table.original_buffer) ||
    !Array.isArray(table.pieces) ||
    !Array.isArray(table.edit_log) ||
    !Number.isSafeInteger(table.next_edit_sequence) ||
    table.next_edit_sequence < 0
  ) {
    byte_error("Invalid piece table");
  }
  if (sha256_digest(table.original_buffer) !== table.original_digest) {
    byte_error("Piece table original buffer digest is inconsistent");
  }
  const declared_operation_ids = new Set();
  for (const [index, edit] of table.edit_log.entries()) {
    if (
      !edit ||
      typeof edit !== "object" ||
      types.isProxy(edit) ||
      typeof edit.operation_id !== "string" ||
      edit.operation_id.length === 0 ||
      typeof edit.no_op !== "boolean" ||
      !Number.isSafeInteger(edit.sequence) ||
      edit.sequence < 0 ||
      !Number.isSafeInteger(edit.anchor_original_byte) ||
      edit.anchor_original_byte < 0 ||
      edit.anchor_original_byte > table.original_buffer.length ||
      !Array.isArray(edit.removed_original_ranges) ||
      !Number.isSafeInteger(edit.snapshot_start_byte) ||
      !Number.isSafeInteger(edit.snapshot_end_byte) ||
      edit.snapshot_start_byte < 0 ||
      edit.snapshot_end_byte < edit.snapshot_start_byte ||
      !/^[a-f0-9]{64}$/.test(edit.removed_digest || "") ||
      !/^[a-f0-9]{64}$/.test(edit.replacement_digest || "")
    ) {
      byte_error("Piece table edit log is invalid", { index });
    }
    declared_operation_ids.add(edit.operation_id);
  }
  let previous_original_end = 0;
  for (const [index, piece] of table.pieces.entries()) {
    if (!piece || typeof piece !== "object" || types.isProxy(piece)) {
      byte_error("Piece table contains an invalid piece", { index });
    }
    if (piece.kind === "original") {
      if (
        !Number.isSafeInteger(piece.original_start_byte) ||
        !Number.isSafeInteger(piece.original_end_byte) ||
        piece.original_start_byte < previous_original_end ||
        piece.original_end_byte <= piece.original_start_byte ||
        piece.original_end_byte > table.original_buffer.length
      ) {
        byte_error("Piece table original pieces are invalid or unordered", {
          index,
        });
      }
      previous_original_end = piece.original_end_byte;
      continue;
    }
    if (
      piece.kind !== "insert" ||
      !Buffer.isBuffer(piece.buffer) ||
      piece.buffer.length === 0 ||
      !Number.isSafeInteger(piece.anchor_original_byte) ||
      piece.anchor_original_byte < 0 ||
      piece.anchor_original_byte > table.original_buffer.length ||
      !Array.isArray(piece.operation_ids)
    ) {
      byte_error("Piece table insert piece is invalid", { index });
    }
    if (
      piece.operation_ids.length === 0 ||
      piece.operation_ids.some(
        (operation_id) =>
          typeof operation_id !== "string" ||
          !declared_operation_ids.has(operation_id),
      )
    ) {
      byte_error("Insert piece is not bound to a declared operation", {
        index,
      });
    }
  }
  return table;
}

function create_piece_table(original_buffer) {
  ensure_buffer(original_buffer, "original_buffer");
  const original_copy = Buffer.from(original_buffer);
  return {
    format: PIECE_TABLE_FORMAT,
    version: PIECE_TABLE_VERSION,
    original_buffer: original_copy,
    original_digest: sha256_digest(original_copy),
    pieces:
      original_copy.length === 0
        ? []
        : [
            {
              kind: "original",
              original_start_byte: 0,
              original_end_byte: original_copy.length,
            },
          ],
    edit_log: [],
    next_edit_sequence: 0,
  };
}

function clone_piece_table(table) {
  assert_piece_table(table);
  return {
    format: PIECE_TABLE_FORMAT,
    version: PIECE_TABLE_VERSION,
    original_buffer: Buffer.from(table.original_buffer),
    original_digest: table.original_digest,
    pieces: table.pieces.map(clone_piece),
    edit_log: table.edit_log.map(clone_edit),
    next_edit_sequence: table.next_edit_sequence,
  };
}

function materialize_piece_table(table) {
  assert_piece_table(table);
  return Buffer.concat(
    table.pieces.map((piece) =>
      piece.kind === "original"
        ? table.original_buffer.subarray(
            piece.original_start_byte,
            piece.original_end_byte,
          )
        : piece.buffer,
    ),
  );
}

function candidate_length(pieces) {
  return pieces.reduce((total, piece) => total + piece_length(piece), 0);
}

function validate_splice(splice, index, snapshot_length) {
  if (
    !splice ||
    typeof splice !== "object" ||
    Array.isArray(splice) ||
    types.isProxy(splice)
  ) {
    byte_error(`Splice ${index} must be an object`);
  }
  const allowed = new Set([
    "start_byte",
    "end_byte",
    "replacement_buffer",
    "operation_id",
    "operation_order",
  ]);
  for (const field of Reflect.ownKeys(splice)) {
    if (typeof field !== "string" || !allowed.has(field)) {
      byte_error(`Unknown splice field: ${String(field)}`, { index });
    }
    const descriptor = Object.getOwnPropertyDescriptor(splice, field);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      byte_error(`Splice field must not be an accessor: ${field}`, { index });
    }
  }
  if (
    !Number.isSafeInteger(splice.start_byte) ||
    !Number.isSafeInteger(splice.end_byte) ||
    splice.start_byte < 0 ||
    splice.end_byte < splice.start_byte ||
    splice.end_byte > snapshot_length
  ) {
    byte_error("Splice range is outside the current snapshot", {
      index,
      start_byte: splice.start_byte,
      end_byte: splice.end_byte,
      snapshot_length,
    });
  }
  ensure_buffer(
    splice.replacement_buffer,
    `splice ${index} replacement_buffer`,
  );
  if (
    typeof splice.operation_id !== "string" ||
    splice.operation_id.length === 0
  ) {
    byte_error(`Splice ${index} operation_id must be non-empty`);
  }
  if (
    Object.hasOwn(splice, "operation_order") &&
    (!Number.isSafeInteger(splice.operation_order) ||
      splice.operation_order < 0)
  ) {
    byte_error(`Splice ${index} operation_order must be non-negative`);
  }
  return {
    start_byte: splice.start_byte,
    end_byte: splice.end_byte,
    replacement_buffer: Buffer.from(splice.replacement_buffer),
    operation_id: splice.operation_id,
    operation_order: splice.operation_order,
    declaration_order: index,
  };
}

function compare_splices(left, right) {
  return (
    left.start_byte - right.start_byte ||
    left.end_byte - right.end_byte ||
    (left.operation_order ?? left.declaration_order) -
      (right.operation_order ?? right.declaration_order) ||
    left.declaration_order - right.declaration_order
  );
}

function normalize_splices(splices, snapshot_length) {
  if (!Array.isArray(splices)) byte_error("splices must be an array");
  const normalized = splices.map((splice, index) =>
    validate_splice(splice, index, snapshot_length),
  );
  const operation_orders = new Map();
  for (const splice of normalized) {
    if (!operation_orders.has(splice.operation_id)) {
      operation_orders.set(splice.operation_id, splice.operation_order);
      continue;
    }
    if (operation_orders.get(splice.operation_id) !== splice.operation_order) {
      byte_error(
        "One operation_id cannot declare conflicting operation_order",
        {
          operation_id: splice.operation_id,
        },
      );
    }
  }
  normalized.sort(compare_splices);
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (current.start_byte < previous.end_byte) {
      byte_error("Splice ranges overlap or cross", {
        previous: previous.declaration_order,
        current: current.declaration_order,
      });
    }
    if (current.start_byte !== previous.start_byte) continue;
    const both_insertions =
      previous.start_byte === previous.end_byte &&
      current.start_byte === current.end_byte;
    if (!both_insertions) {
      byte_error("Splices with the same start are ambiguous", {
        previous: previous.declaration_order,
        current: current.declaration_order,
      });
    }
    if (
      previous.operation_order === undefined ||
      current.operation_order === undefined ||
      previous.operation_order === current.operation_order
    ) {
      byte_error("Same-offset insertions require unique operation_order", {
        previous: previous.declaration_order,
        current: current.declaration_order,
      });
    }
  }
  return normalized;
}

function split_piece(piece, relative_offset) {
  if (piece.kind === "original") {
    const split = piece.original_start_byte + relative_offset;
    return [
      { ...piece, original_end_byte: split },
      { ...piece, original_start_byte: split },
    ];
  }
  return [
    { ...piece, buffer: piece.buffer.subarray(0, relative_offset) },
    { ...piece, buffer: piece.buffer.subarray(relative_offset) },
  ];
}

function split_at(pieces, offset) {
  let cursor = 0;
  for (let index = 0; index < pieces.length; index += 1) {
    const length = piece_length(pieces[index]);
    const end = cursor + length;
    if (offset === cursor) return index;
    if (offset === end) return index + 1;
    if (offset > cursor && offset < end) {
      const split = split_piece(pieces[index], offset - cursor);
      pieces.splice(index, 1, ...split);
      return index + 1;
    }
    cursor = end;
  }
  if (offset === cursor) return pieces.length;
  byte_error("Piece split offset is outside the current snapshot", { offset });
}

function original_anchor_at(pieces, offset, original_length) {
  let cursor = 0;
  for (const piece of pieces) {
    const length = piece_length(piece);
    const end = cursor + length;
    if (offset >= cursor && offset < end) {
      return piece.kind === "original"
        ? piece.original_start_byte + (offset - cursor)
        : piece.anchor_original_byte;
    }
    if (offset === end) {
      return piece.kind === "original"
        ? piece.original_end_byte
        : piece.anchor_original_byte;
    }
    cursor = end;
  }
  if (offset === cursor) return original_length;
  byte_error("Cannot map snapshot offset to original source", { offset });
}

function original_ranges_in_pieces(pieces) {
  const ranges = pieces
    .filter((piece) => piece.kind === "original")
    .map((piece) => ({
      start_byte: piece.original_start_byte,
      end_byte: piece.original_end_byte,
    }));
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && previous.end_byte === range.start_byte) {
      previous.end_byte = range.end_byte;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function merge_pieces(pieces) {
  const merged = [];
  for (const piece of pieces) {
    if (piece_length(piece) === 0) continue;
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.kind === "original" &&
      piece.kind === "original" &&
      previous.original_end_byte === piece.original_start_byte
    ) {
      previous.original_end_byte = piece.original_end_byte;
      continue;
    }
    if (
      previous &&
      previous.kind === "insert" &&
      piece.kind === "insert" &&
      previous.anchor_original_byte === piece.anchor_original_byte &&
      canonical_json(previous.operation_ids) ===
        canonical_json(piece.operation_ids)
    ) {
      previous.buffer = Buffer.concat([previous.buffer, piece.buffer]);
      continue;
    }
    merged.push(clone_piece(piece));
  }
  return merged;
}

function replace_snapshot_range(table, splice) {
  const snapshot = materialize_piece_table(table);
  const current = snapshot.subarray(splice.start_byte, splice.end_byte);
  if (current.equals(splice.replacement_buffer)) {
    return {
      ...table,
      edit_log: table.edit_log.concat({
        operation_id: splice.operation_id,
        operation_order: splice.operation_order,
        declaration_order: splice.declaration_order,
        sequence: splice.sequence,
        no_op: true,
        snapshot_start_byte: splice.start_byte,
        snapshot_end_byte: splice.end_byte,
        anchor_original_byte: original_anchor_at(
          table.pieces,
          splice.start_byte,
          table.original_buffer.length,
        ),
        removed_original_ranges: [],
        removed_digest: sha256_digest(current),
        replacement_digest: sha256_digest(splice.replacement_buffer),
      }),
    };
  }
  const pieces = table.pieces.map(clone_piece);
  const anchor_original_byte = original_anchor_at(
    pieces,
    splice.start_byte,
    table.original_buffer.length,
  );
  const start_index = split_at(pieces, splice.start_byte);
  const end_index = split_at(pieces, splice.end_byte);
  const removed = pieces.slice(start_index, end_index);
  const replacement_pieces =
    splice.replacement_buffer.length === 0
      ? []
      : [
          {
            kind: "insert",
            buffer: Buffer.from(splice.replacement_buffer),
            anchor_original_byte,
            operation_ids: [splice.operation_id],
          },
        ];
  pieces.splice(start_index, end_index - start_index, ...replacement_pieces);
  return {
    ...table,
    pieces: merge_pieces(pieces),
    edit_log: table.edit_log.concat({
      operation_id: splice.operation_id,
      operation_order: splice.operation_order,
      declaration_order: splice.declaration_order,
      sequence: splice.sequence,
      no_op: false,
      snapshot_start_byte: splice.start_byte,
      snapshot_end_byte: splice.end_byte,
      anchor_original_byte,
      removed_original_ranges: original_ranges_in_pieces(removed),
      removed_digest: sha256_digest(current),
      replacement_digest: sha256_digest(splice.replacement_buffer),
    }),
  };
}

function apply_snapshot_splices(piece_table, splices) {
  const table = clone_piece_table(piece_table);
  const snapshot_length = candidate_length(table.pieces);
  const normalized = normalize_splices(splices, snapshot_length).map(
    (splice) => ({
      ...splice,
      sequence: table.next_edit_sequence + splice.declaration_order,
    }),
  );
  for (const splice of normalized) {
    const existing = table.edit_log.find(
      (edit) => edit.operation_id === splice.operation_id,
    );
    if (existing && existing.operation_order !== splice.operation_order) {
      byte_error("Existing operation_id has a different operation_order", {
        operation_id: splice.operation_id,
      });
    }
  }
  let result = table;
  for (const splice of [...normalized].reverse()) {
    result = replace_snapshot_range(result, splice);
  }
  const completed = {
    ...result,
    next_edit_sequence: table.next_edit_sequence + normalized.length,
  };
  assert_piece_table(completed);
  return completed;
}

function operation_ids_for_range(
  table,
  candidate_start_byte,
  candidate_end_byte,
  original_start_byte,
  original_end_byte,
) {
  const operations = new Map();
  let candidate_cursor = 0;
  for (const piece of table.pieces) {
    const piece_end = candidate_cursor + piece_length(piece);
    if (
      piece.kind === "insert" &&
      piece_end > candidate_start_byte &&
      candidate_cursor < candidate_end_byte
    ) {
      for (const operation_id of piece.operation_ids) {
        operations.set(operation_id, {
          operation_id,
          operation_order: undefined,
          declaration_order: Number.MAX_SAFE_INTEGER,
          sequence: Number.MAX_SAFE_INTEGER,
        });
      }
    }
    candidate_cursor = piece_end;
  }
  for (const edit of table.edit_log) {
    const removes_original = edit.removed_original_ranges.some(
      (range) =>
        range.end_byte > original_start_byte &&
        range.start_byte < original_end_byte,
    );
    const anchored_in_range =
      edit.anchor_original_byte >= original_start_byte &&
      edit.anchor_original_byte <= original_end_byte;
    if (!removes_original && !anchored_in_range) continue;
    operations.set(edit.operation_id, edit);
  }
  return [...operations.values()]
    .sort(
      (left, right) =>
        (left.operation_order ?? left.sequence) -
          (right.operation_order ?? right.sequence) ||
        left.sequence - right.sequence ||
        (left.operation_id < right.operation_id ? -1 : 1),
    )
    .map((edit) => edit.operation_id);
}

function original_ranges_from_pieces(piece_table) {
  const table = assert_piece_table(piece_table);
  const unchanged_regions = [];
  let candidate_cursor = 0;
  for (const piece of table.pieces) {
    const length = piece_length(piece);
    if (piece.kind === "original") {
      const previous = unchanged_regions[unchanged_regions.length - 1];
      if (
        previous &&
        previous.original_end_byte === piece.original_start_byte &&
        previous.candidate_end_byte === candidate_cursor
      ) {
        previous.original_end_byte = piece.original_end_byte;
        previous.candidate_end_byte = candidate_cursor + length;
      } else {
        unchanged_regions.push({
          original_start_byte: piece.original_start_byte,
          original_end_byte: piece.original_end_byte,
          candidate_start_byte: candidate_cursor,
          candidate_end_byte: candidate_cursor + length,
        });
      }
    }
    candidate_cursor += length;
  }
  const ranges = [];
  let original_cursor = 0;
  let prior_candidate_cursor = 0;
  for (const unchanged of unchanged_regions) {
    if (
      unchanged.original_start_byte !== original_cursor ||
      unchanged.candidate_start_byte !== prior_candidate_cursor
    ) {
      ranges.push({
        original_start_byte: original_cursor,
        original_end_byte: unchanged.original_start_byte,
        candidate_start_byte: prior_candidate_cursor,
        candidate_end_byte: unchanged.candidate_start_byte,
      });
    }
    original_cursor = unchanged.original_end_byte;
    prior_candidate_cursor = unchanged.candidate_end_byte;
  }
  if (
    original_cursor !== table.original_buffer.length ||
    prior_candidate_cursor !== candidate_cursor
  ) {
    ranges.push({
      original_start_byte: original_cursor,
      original_end_byte: table.original_buffer.length,
      candidate_start_byte: prior_candidate_cursor,
      candidate_end_byte: candidate_cursor,
    });
  }
  for (const range of ranges) {
    range.operation_ids = operation_ids_for_range(
      table,
      range.candidate_start_byte,
      range.candidate_end_byte,
      range.original_start_byte,
      range.original_end_byte,
    );
  }
  return { ranges, unchanged_regions };
}

function create_operation_proofs(table, ranges) {
  const grouped = new Map();
  for (const edit of table.edit_log) {
    let operation = grouped.get(edit.operation_id);
    if (!operation) {
      operation = {
        operation_id: edit.operation_id,
        operation_order: edit.operation_order,
        sequence: edit.sequence,
        steps: [],
      };
      grouped.set(edit.operation_id, operation);
    }
    operation.steps.push({
      no_op: edit.no_op,
      snapshot_start_byte: edit.snapshot_start_byte,
      snapshot_end_byte: edit.snapshot_end_byte,
      anchor_original_byte: edit.anchor_original_byte,
      removed_original_ranges: edit.removed_original_ranges.map((range) => ({
        ...range,
      })),
      removed_digest: edit.removed_digest,
      replacement_digest: edit.replacement_digest,
    });
    operation.sequence = Math.min(operation.sequence, edit.sequence);
  }
  return [...grouped.values()]
    .sort(
      (left, right) =>
        (left.operation_order ?? left.sequence) -
          (right.operation_order ?? right.sequence) ||
        left.sequence - right.sequence ||
        (left.operation_id < right.operation_id ? -1 : 1),
    )
    .map((operation) => {
      const final_ranges = ranges
        .filter((range) => range.operation_ids.includes(operation.operation_id))
        .map((range) => ({
          original_start_byte: range.original_start_byte,
          original_end_byte: range.original_end_byte,
          candidate_start_byte: range.candidate_start_byte,
          candidate_end_byte: range.candidate_end_byte,
        }));
      return {
        operation_id: operation.operation_id,
        ...(operation.operation_order === undefined
          ? {}
          : { operation_order: operation.operation_order }),
        no_op_at_application: operation.steps.every((step) => step.no_op),
        present_in_final: final_ranges.length > 0,
        final_ranges,
        steps: operation.steps,
      };
    });
}

function create_multi_range_byte_proof(
  original_buffer,
  candidate_buffer,
  piece_table,
) {
  ensure_buffer(original_buffer, "original_buffer");
  ensure_buffer(candidate_buffer, "candidate_buffer");
  const table = assert_piece_table(piece_table);
  if (!original_buffer.equals(table.original_buffer)) {
    byte_error("Piece table is bound to a different original source", {
      expected_digest: table.original_digest,
      actual_digest: sha256_digest(original_buffer),
    });
  }
  const materialized = materialize_piece_table(table);
  if (!materialized.equals(candidate_buffer)) {
    byte_error("Candidate contains changes outside the piece table", {
      expected_digest: sha256_digest(materialized),
      actual_digest: sha256_digest(candidate_buffer),
    });
  }
  if (original_buffer.equals(candidate_buffer)) {
    const operations = create_operation_proofs(table, []);
    return {
      format: "yaml_patch-byte-proof",
      version: 2,
      verified: true,
      no_op: true,
      original_digest: sha256_digest(original_buffer),
      candidate_digest: sha256_digest(candidate_buffer),
      ranges: [],
      operations,
      unchanged_regions: [
        {
          original_start_byte: 0,
          original_end_byte: original_buffer.length,
          candidate_start_byte: 0,
          candidate_end_byte: candidate_buffer.length,
          digest: sha256_digest(original_buffer),
        },
      ],
      summary: {
        deleted_bytes: 0,
        inserted_bytes: 0,
        touched_bytes: 0,
        size_delta: 0,
      },
    };
  }
  const derived = original_ranges_from_pieces(table);
  const undeclared_range = derived.ranges.find(
    (range) => range.operation_ids.length === 0,
  );
  if (undeclared_range) {
    byte_error("Changed range is not bound to a declared operation", {
      range: undeclared_range,
    });
  }
  const unchanged_regions = derived.unchanged_regions.map((region) => {
    const original = original_buffer.subarray(
      region.original_start_byte,
      region.original_end_byte,
    );
    const candidate = candidate_buffer.subarray(
      region.candidate_start_byte,
      region.candidate_end_byte,
    );
    if (!original.equals(candidate)) {
      byte_error("An unchanged piece differs in the candidate", { region });
    }
    return { ...region, digest: sha256_digest(original) };
  });
  const ranges = derived.ranges.map((range) => {
    const original = original_buffer.subarray(
      range.original_start_byte,
      range.original_end_byte,
    );
    const replacement = candidate_buffer.subarray(
      range.candidate_start_byte,
      range.candidate_end_byte,
    );
    return {
      ...range,
      original_digest: sha256_digest(original),
      replacement_digest: sha256_digest(replacement),
    };
  });
  const operations = create_operation_proofs(table, ranges);
  const deleted_bytes = ranges.reduce(
    (total, range) =>
      total + range.original_end_byte - range.original_start_byte,
    0,
  );
  const inserted_bytes = ranges.reduce(
    (total, range) =>
      total + range.candidate_end_byte - range.candidate_start_byte,
    0,
  );
  return {
    format: "yaml_patch-byte-proof",
    version: 2,
    verified: true,
    no_op: false,
    original_digest: sha256_digest(original_buffer),
    candidate_digest: sha256_digest(candidate_buffer),
    ranges,
    operations,
    unchanged_regions,
    summary: {
      deleted_bytes,
      inserted_bytes,
      touched_bytes: deleted_bytes + inserted_bytes,
      size_delta: candidate_buffer.length - original_buffer.length,
    },
  };
}

function apply_range_set(original_buffer, splices) {
  const piece_table = apply_snapshot_splices(
    create_piece_table(original_buffer),
    splices,
  );
  const candidate_buffer = materialize_piece_table(piece_table);
  const proof = create_multi_range_byte_proof(
    original_buffer,
    candidate_buffer,
    piece_table,
  );
  return { piece_table, candidate_buffer, proof };
}

function create_transaction_proof(file_proofs, operation_order) {
  if (!Array.isArray(file_proofs) || !Array.isArray(operation_order)) {
    byte_error(
      "Transaction proof requires file_proofs and operation_order arrays",
    );
  }
  const seen_operations = new Set();
  for (const [index, operation_id] of operation_order.entries()) {
    if (typeof operation_id !== "string" || operation_id.length === 0) {
      byte_error(`operation_order[${index}] must be non-empty`);
    }
    if (seen_operations.has(operation_id)) {
      byte_error("operation_order contains a duplicate operation", {
        operation_id,
      });
    }
    seen_operations.add(operation_id);
  }
  const seen_paths = new Set();
  const files = file_proofs.map((item, index) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.source_path !== "string" ||
      !item.proof ||
      item.proof.format !== "yaml_patch-byte-proof" ||
      item.proof.version !== 2 ||
      item.proof.verified !== true
    ) {
      byte_error(`Invalid transaction file proof at index ${index}`);
    }
    const source_path = path.resolve(item.source_path);
    if (seen_paths.has(source_path)) {
      byte_error("Transaction proof contains duplicate source path", {
        source_path,
      });
    }
    seen_paths.add(source_path);
    const proof = clone_json_value(item.proof, "file byte proof");
    return {
      source_path,
      original_digest: proof.original_digest,
      candidate_digest: proof.candidate_digest,
      no_op: proof.no_op,
      proof_digest: canonical_digest(proof),
    };
  });
  files.sort((left, right) =>
    left.source_path === right.source_path
      ? 0
      : left.source_path < right.source_path
        ? -1
        : 1,
  );
  const binding = {
    format: "yaml_patch-transaction-proof",
    version: 1,
    verified: true,
    operation_order: [...operation_order],
    files,
  };
  return { ...binding, transaction_digest: canonical_digest(binding) };
}

module.exports = {
  PIECE_TABLE_FORMAT,
  PIECE_TABLE_VERSION,
  apply_range_set,
  apply_snapshot_splices,
  create_multi_range_byte_proof,
  create_piece_table,
  create_transaction_proof,
  materialize_piece_table,
  original_ranges_from_pieces,
  validate_byte_proof,
};
