"use strict";

const { throw_request_error } = require("./error");
const { assert_known_fields } = require("./schema");

const OPERATION_FIELDS = Object.freeze({
  replace_scalar_raw: ["id", "type", "raw"],
  set_scalar_value: ["id", "type", "value", "style"],
  add_mapping_pair: ["id", "type", "key", "value", "position"],
  set_mapping_value: ["id", "type", "pair", "value", "style"],
  delete_mapping_pair: ["id", "type", "pair"],
  rename_mapping_key: ["id", "type", "pair", "key"],
  move_mapping_pair: ["id", "type", "pair", "position"],
  reorder_mapping_pairs: ["id", "type", "pairs"],
  append_sequence_item: ["id", "type", "value"],
  prepend_sequence_item: ["id", "type", "value"],
  insert_sequence_item: ["id", "type", "value", "position"],
  delete_sequence_item: ["id", "type", "index"],
  swap_sequence_items: ["id", "type", "left_index", "right_index"],
  reorder_sequence_items: ["id", "type", "indices"],
  move_sequence_item: ["id", "type", "index", "position"],
  append_unique_sequence_value: ["id", "type", "value"],
  delete_one_sequence_value: ["id", "type", "value"],
  delete_all_sequence_values: ["id", "type", "value"],
  assert_sequence_unique: ["id", "type"],
});

function require_field(operation, field) {
  if (!Object.hasOwn(operation, field)) {
    throw_request_error(`${operation.type} requires ${field}`);
  }
}

function assert_index(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw_request_error(`${label} must be a safe integer`);
  }
}

function validate_operation(operation, allowed_types, label) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw_request_error(`${label} operation must be an object`);
  }
  if (!allowed_types.has(operation.type)) {
    throw_request_error(
      `Unsupported ${label.toLowerCase()} operation: ${operation.type}`,
    );
  }
  assert_known_fields(
    operation,
    OPERATION_FIELDS[operation.type],
    `${operation.type} operation`,
    "REQUEST_ERROR",
  );
  if (typeof operation.id !== "string" || operation.id.length === 0) {
    throw_request_error(`${label} operation id must be a non-empty string`);
  }

  const required_fields = OPERATION_FIELDS[operation.type].filter(
    (field) => !["id", "type", "style", "position"].includes(field),
  );
  required_fields.forEach((field) => require_field(operation, field));
  if (["insert_sequence_item", "move_sequence_item"].includes(operation.type)) {
    require_field(operation, "position");
  }
  if (
    operation.style !== undefined &&
    (typeof operation.style !== "string" || operation.style.length === 0)
  ) {
    throw_request_error(`${operation.type} style must be a non-empty string`);
  }
  if (
    operation.type === "replace_scalar_raw" &&
    typeof operation.raw !== "string"
  ) {
    throw_request_error("replace_scalar_raw raw must be a string");
  }
  if (
    ["add_mapping_pair", "rename_mapping_key"].includes(operation.type) &&
    typeof operation.key !== "string"
  ) {
    throw_request_error(`${operation.type} key must be a string`);
  }
  if (["delete_sequence_item", "move_sequence_item"].includes(operation.type)) {
    assert_index(operation.index, `${operation.type} index`);
  }
  if (operation.type === "swap_sequence_items") {
    assert_index(operation.left_index, "swap_sequence_items left_index");
    assert_index(operation.right_index, "swap_sequence_items right_index");
  }
  if (operation.type === "reorder_sequence_items") {
    if (!Array.isArray(operation.indices)) {
      throw_request_error("reorder_sequence_items indices must be an array");
    }
    operation.indices.forEach((index, item_index) =>
      assert_index(index, `reorder_sequence_items indices[${item_index}]`),
    );
  }
  if (
    operation.type === "reorder_mapping_pairs" &&
    !Array.isArray(operation.pairs)
  ) {
    throw_request_error("reorder_mapping_pairs pairs must be an array");
  }
  return operation;
}

module.exports = {
  validate_operation,
};
