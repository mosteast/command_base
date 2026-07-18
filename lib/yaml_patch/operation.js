"use strict";

const { request_error } = require("./error");
const scalar_edit = require("./scalar_edit");
const mapping_edit = require("./mapping_edit");
const sequence_edit = require("./sequence_edit");

const SCALAR_OPERATION = new Set(["replace_scalar_raw", "set_scalar_value"]);
const MAPPING_OPERATION = new Set([
  "add_mapping_pair",
  "set_mapping_value",
  "delete_mapping_pair",
  "rename_mapping_key",
  "move_mapping_pair",
  "reorder_mapping_pairs",
]);
const SEQUENCE_OPERATION = new Set([
  "append_sequence_item",
  "prepend_sequence_item",
  "insert_sequence_item",
  "delete_sequence_item",
  "swap_sequence_items",
  "reorder_sequence_items",
  "move_sequence_item",
  "append_unique_sequence_value",
  "delete_one_sequence_value",
  "delete_all_sequence_values",
  "assert_sequence_unique",
]);

function compile_operation(context, target, operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    request_error("Structural operation must be an object");
  }
  if (SCALAR_OPERATION.has(operation.type)) {
    return scalar_edit.compile_operation(context, target, operation);
  }
  if (MAPPING_OPERATION.has(operation.type)) {
    return mapping_edit.compile_operation(context, target, operation);
  }
  if (SEQUENCE_OPERATION.has(operation.type)) {
    return sequence_edit.compile_operation(context, target, operation);
  }
  request_error(`Unsupported structural operation: ${operation.type}`);
}

function compile_cross_file_move(
  source_context,
  source_target,
  destination_context,
  destination_target,
  operation,
) {
  return sequence_edit.compile_cross_file_move(
    source_context,
    source_target,
    destination_context,
    destination_target,
    operation,
  );
}

module.exports = {
  MAPPING_OPERATION,
  SCALAR_OPERATION,
  SEQUENCE_OPERATION,
  compile_cross_file_move,
  compile_operation,
};
