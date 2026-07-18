"use strict";

const { clone_json_value } = require("./artifact_version");
const { Yaml_patch_error } = require("./error");

function diff_error(message) {
  throw new Yaml_patch_error("VALIDATION_FAILED", message);
}

function changed_lines(prefix, buffer) {
  return buffer
    .toString("utf8")
    .split(/\r\n|\n|\r/)
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
    .map((line) => `${prefix}${line}`);
}

function text_diff(file_id, original_buffer, candidate_buffer) {
  if (original_buffer.equals(candidate_buffer)) return "";
  return `${[
    `--- ${file_id}`,
    `+++ ${file_id}`,
    `@@ bytes 0,${original_buffer.length} @@`,
    ...changed_lines("-", original_buffer),
    ...changed_lines("+", candidate_buffer),
  ].join("\n")}\n`;
}

function create_file_diff(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    diff_error("File diff input must be an object");
  }
  if (typeof input.file_id !== "string" || input.file_id.length === 0) {
    diff_error("File diff requires file_id");
  }
  if (
    !Buffer.isBuffer(input.original_buffer) ||
    !Buffer.isBuffer(input.candidate_buffer)
  ) {
    diff_error("File diff requires original and candidate buffers");
  }
  if (!input.proof || input.proof.format !== "yaml_patch-byte-proof") {
    diff_error("File diff requires a verified byte proof");
  }
  const operations = clone_json_value(
    input.operations || [],
    "diff operations",
  );
  if (!Array.isArray(operations))
    diff_error("File diff operations must be an array");
  const byte_counts = {
    deleted: input.proof.summary.deleted_bytes,
    inserted: input.proof.summary.inserted_bytes,
    touched: input.proof.summary.touched_bytes,
  };
  const structured = {
    format: "yaml_patch-structured-diff",
    version: 1,
    file_id: input.file_id,
    no_op: input.proof.no_op,
    original_digest: input.proof.original_digest,
    candidate_digest: input.proof.candidate_digest,
    byte_counts,
    operations,
    ranges: clone_json_value(input.proof.ranges, "diff ranges"),
  };
  const semantic_operations = operations.map((operation) => ({
    id: operation.id,
    type: operation.type,
    ...(operation.locator === undefined ? {} : { locator: operation.locator }),
    ...(operation.handle === undefined ? {} : { handle: operation.handle }),
    ...(operation.result_handle === undefined
      ? {}
      : { result_handle: operation.result_handle }),
    ...(operation.original_range === undefined
      ? {}
      : { original_range: operation.original_range }),
    ...(operation.candidate_range === undefined
      ? {}
      : { candidate_range: operation.candidate_range }),
    ...(operation.moved_range === undefined
      ? {}
      : { moved_range: operation.moved_range }),
    ...(operation.source === undefined ? {} : { source: operation.source }),
    ...(operation.destination === undefined
      ? {}
      : { destination: operation.destination }),
    no_op: operation.no_op === true,
  }));
  return {
    text: text_diff(
      input.file_id,
      input.original_buffer,
      input.candidate_buffer,
    ),
    structured,
    semantic: {
      file_id: input.file_id,
      no_op: input.proof.no_op,
      operation_count: semantic_operations.length,
      byte_counts,
      operations: semantic_operations,
    },
  };
}

module.exports = { create_file_diff };
