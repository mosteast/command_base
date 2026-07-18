"use strict";

const { throw_request_error, Yaml_patch_error } = require("./error");

function precondition_error(message, details = {}) {
  throw new Yaml_patch_error("PRECONDITION_FAILED", message, {
    details,
    next_action:
      "refresh the current source snapshot and resolve the target again",
  });
}

function assert_current_target(context, target, label = "Structural edit") {
  if (
    !context ||
    typeof context !== "object" ||
    !context.index ||
    !context.index.source ||
    typeof context.index.source.digest !== "string" ||
    typeof context.index.source.snapshot_id !== "string" ||
    !context.index._internal ||
    !(context.index._internal.entry_by_id instanceof Map)
  ) {
    throw_request_error(`${label} context requires a node index`);
  }
  if (
    !target ||
    typeof target !== "object" ||
    !Number.isSafeInteger(target.id) ||
    typeof target.locator !== "string" ||
    typeof target.raw_digest !== "string" ||
    typeof target.source_digest !== "string" ||
    typeof target.source_snapshot_id !== "string" ||
    !target.source ||
    !Number.isSafeInteger(target.source.start_byte) ||
    !Number.isSafeInteger(target.source.end_byte)
  ) {
    throw_request_error(
      `${label} target must be a node entry with snapshot metadata`,
    );
  }
  const current = context.index._internal.entry_by_id.get(target.id);
  const source_digest = context.index.source.digest;
  const source_snapshot_id = context.index.source.snapshot_id;
  if (
    !current ||
    current.locator !== target.locator ||
    current.raw_digest !== target.raw_digest ||
    current.source_digest !== source_digest ||
    target.source_digest !== source_digest ||
    current.source_snapshot_id !== source_snapshot_id ||
    target.source_snapshot_id !== source_snapshot_id ||
    current.source.start_byte !== target.source.start_byte ||
    current.source.end_byte !== target.source.end_byte
  ) {
    precondition_error(
      `${label} target does not belong to the current snapshot`,
      {
        locator: target.locator,
        expected_source_digest: target.source_digest,
        actual_source_digest: source_digest,
        expected_source_snapshot_id: target.source_snapshot_id,
        actual_source_snapshot_id: source_snapshot_id,
      },
    );
  }
  return current;
}

module.exports = {
  assert_current_target,
};
