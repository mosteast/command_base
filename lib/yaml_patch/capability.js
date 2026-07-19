"use strict";

const package_json = require("../../package.json");
const { ARTIFACT_VERSION } = require("./artifact_version");
const { SUPPORTED_EDIT_UNITS } = require("./edit_range");
const { get_yaml_parser_version } = require("./parser");
const { get_writer_capabilities } = require("./writer");

const OPERATION_TYPES = Object.freeze([
  "bind",
  "replace_scalar_raw",
  "replace_scalar_typed",
  "set_scalar_style",
  "add_mapping_pair",
  "set_mapping_value",
  "delete_mapping_pair",
  "rename_mapping_key",
  "move_mapping_pair",
  "reorder_mapping_pairs",
  "prepend_sequence_item",
  "append_sequence_item",
  "insert_sequence_item",
  "delete_sequence_item",
  "swap_sequence_items",
  "reorder_sequence_items",
  "move_sequence_item",
  "append_unique_sequence_value",
  "delete_one_sequence_value",
  "delete_all_sequence_values",
  "add_subtree",
  "delete_subtree",
  "copy_subtree",
  "move_subtree",
]);

function list_capabilities(options = {}) {
  const writer = get_writer_capabilities(options);
  return {
    protocol_version: 1,
    capability_protocol_version: 2,
    tool_version: package_json.version,
    parser_version: get_yaml_parser_version(),
    artifact_versions: { ...ARTIFACT_VERSION },
    query_version: [1, 2],
    operation_version: [1, 2],
    transaction_version: 1,
    profile_version: 1,
    manifest_version: [1, 2],
    proof_version: [1, 2],
    journal_version: 1,
    migration_version: 1,
    migration_rules: [
      "normalize_key_alias",
      "convert_typed_value",
      "wrap_value",
      "unwrap_value",
      "normalize_child_keys",
      "move_node",
    ],
    edit_units: Array.from(SUPPORTED_EDIT_UNITS),
    operations: OPERATION_TYPES,
    profile_rules: [
      "fields",
      "identity",
      "protected",
      "field_aliases",
      "references",
      "cycles",
      "per_operation_rule",
    ],
    writer: {
      ...writer,
      multi_file_journal: writer.write,
      recovery: writer.write,
      simultaneous_multi_file_visibility: false,
      unsupported_platform_guarantee:
        "dry-run remains available when atomic write is unsupported",
    },
    resource_defaults: {
      max_file_bytes: 8 * 1024 * 1024,
      max_json_input_bytes: 1024 * 1024,
      max_result: 1000,
      max_output_bytes: 4 * 1024 * 1024,
    },
  };
}

module.exports = {
  OPERATION_TYPES,
  list_capabilities,
};
