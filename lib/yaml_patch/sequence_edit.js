"use strict";

const YAML = require("yaml");

const { request_error, Yaml_patch_error } = require("./error");
const { parse_yaml_source } = require("./parser");
const { typed_scalar_metadata } = require("./scalar_metadata");
const { create_source_record } = require("./source");
const { typed_values_equal, validate_typed_value } = require("./typed_value");
const {
  assert_insert_index,
  assert_snapshot_index,
  collection_items,
  join_item_buffers,
  precondition_error,
  rebase_new_item,
  unsupported_shape,
} = require("./layout");

const OPERATION_TYPES = new Set([
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

function assert_operation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    request_error("Sequence operation must be an object");
  }
  if (!OPERATION_TYPES.has(operation.type)) {
    request_error(`Unsupported sequence operation: ${operation.type}`);
  }
  if (typeof operation.id !== "string" || operation.id.length === 0) {
    request_error("Sequence operation id must be a non-empty string");
  }
}

function typed_value_to_javascript(value) {
  if (value.type === "integer" && value.value_encoding === "decimal_string") {
    return BigInt(value.value);
  }
  if (value.type === "float" && value.value_encoding === "non_finite") {
    return {
      nan: Number.NaN,
      negative_infinity: Number.NEGATIVE_INFINITY,
      positive_infinity: Number.POSITIVE_INFINITY,
    }[value.value];
  }
  return value.value;
}

function typed_value_for_record(record) {
  if (!YAML.isScalar(record.item)) return null;
  const raw =
    record.item.srcToken && typeof record.item.srcToken.source === "string"
      ? record.item.srcToken.source
      : record.buffer.toString("utf8");
  const metadata = typed_scalar_metadata(record.item, raw);
  if (metadata.scalar_type === undefined) return null;
  return {
    type: metadata.scalar_type,
    value: metadata.scalar_value,
    ...(metadata.scalar_value_encoding === undefined
      ? {}
      : { value_encoding: metadata.scalar_value_encoding }),
  };
}

function new_item_buffer(value, indent, line_break) {
  const raw = Buffer.from(YAML.stringify([value]), "utf8");
  return rebase_new_item(raw, indent, line_break);
}

function position_index(layout, position) {
  if (!position || typeof position !== "object" || Array.isArray(position)) {
    request_error("Sequence insertion requires a position object");
  }
  if (position.kind === "prepend") return 0;
  if (position.kind === "append") return layout.records.length;
  if (position.kind === "index") {
    return assert_insert_index(
      position.index,
      layout.records.length,
      "sequence position index",
    );
  }
  if (position.kind === "before" || position.kind === "after") {
    const index = assert_snapshot_index(
      position.index,
      layout.records.length,
      "sequence position index",
    );
    return position.kind === "before" ? index : index + 1;
  }
  request_error(`Unsupported sequence position: ${position.kind}`);
}

function candidate_parse(context, start_byte, end_byte, replacement) {
  const source = context.index.source;
  const candidate = Buffer.concat([
    source.buffer.subarray(0, start_byte),
    replacement,
    source.buffer.subarray(end_byte),
  ]);
  const parsed = parse_yaml_source(create_source_record(candidate));
  if (parsed.errors.length > 0) {
    throw new Yaml_patch_error(
      "YAML_DIAGNOSTIC",
      "Sequence edit makes YAML invalid",
      {
        details: { diagnostics: parsed.errors },
      },
    );
  }
}

function collection_result(operation, layout, records) {
  const replacement_buffer =
    records.length === 0
      ? Buffer.from(
          `[]` + (layout.ends_with_line_break ? layout.line_break : ""),
          "utf8",
        )
      : join_item_buffers(records, layout.indent, layout.line_break);
  candidate_parse(
    context_for(layout),
    layout.start_byte,
    layout.end_byte,
    replacement_buffer,
  );
  return {
    splices: [
      {
        start_byte: layout.start_byte,
        end_byte: layout.end_byte,
        replacement_buffer,
        operation_id: operation.id,
      },
    ],
    result_range: {
      start_byte: layout.start_byte,
      end_byte: layout.start_byte + replacement_buffer.length,
    },
    provenance: { operation_id: operation.id, type: operation.type },
    semantic_change: { no_op: false },
  };
}

function context_for(layout) {
  return layout.context;
}

function with_context(context, layout) {
  return { ...layout, context };
}

function compile_insert(context, target, operation, layout) {
  if (!Object.hasOwn(operation, "value"))
    request_error("Sequence insertion requires value");
  let position;
  if (operation.type === "append_sequence_item")
    position = layout.records.length;
  if (operation.type === "prepend_sequence_item") position = 0;
  if (operation.type === "insert_sequence_item") {
    position = position_index(layout, operation.position);
  }
  const records = layout.records.slice();
  records.splice(position, 0, {
    buffer: new_item_buffer(operation.value, layout.indent, layout.line_break),
  });
  return collection_result(operation, layout, records);
}

function compile_delete_index(target, operation, layout, index) {
  const records = layout.records.filter(
    (_, record_index) => record_index !== index,
  );
  return collection_result(operation, layout, records);
}

function compile_delete(context, target, operation, layout) {
  const index = assert_snapshot_index(
    operation.index,
    layout.records.length,
    "sequence item index",
  );
  return compile_delete_index(target, operation, layout, index);
}

function compile_swap(target, operation, layout) {
  const left = assert_snapshot_index(
    operation.left_index,
    layout.records.length,
    "left sequence item index",
  );
  const right = assert_snapshot_index(
    operation.right_index,
    layout.records.length,
    "right sequence item index",
  );
  if (left === right) {
    return {
      splices: [],
      result_range: null,
      provenance: { operation_id: operation.id, type: operation.type },
      semantic_change: { no_op: true },
    };
  }
  const records = layout.records.slice();
  [records[left], records[right]] = [records[right], records[left]];
  return collection_result(operation, layout, records);
}

function compile_reorder(target, operation, layout) {
  if (
    !Array.isArray(operation.indices) ||
    operation.indices.length !== layout.records.length
  ) {
    request_error(
      "reorder_sequence_items requires every current index exactly once",
    );
  }
  operation.indices.forEach((index) =>
    assert_snapshot_index(
      index,
      layout.records.length,
      "reorder sequence item index",
    ),
  );
  if (new Set(operation.indices).size !== layout.records.length) {
    precondition_error(
      "reorder_sequence_items contains a duplicate or vanished index",
    );
  }
  return collection_result(
    operation,
    layout,
    operation.indices.map((index) => layout.records[index]),
  );
}

function compile_move(target, operation, layout) {
  const index = assert_snapshot_index(
    operation.index,
    layout.records.length,
    "sequence item index",
  );
  const before_removal_destination = position_index(layout, operation.position);
  const records = layout.records.slice();
  const [moved] = records.splice(index, 1);
  const destination =
    before_removal_destination > index
      ? before_removal_destination - 1
      : before_removal_destination;
  records.splice(destination, 0, moved);
  if (
    records.every(
      (record, record_index) => record === layout.records[record_index],
    )
  ) {
    return {
      splices: [],
      result_range: null,
      provenance: { operation_id: operation.id, type: operation.type },
      semantic_change: { no_op: true },
    };
  }
  return collection_result(operation, layout, records);
}

function compile_append_unique(target, operation, layout) {
  validate_typed_value(operation.value, "append_unique_sequence_value value");
  if (
    layout.records.some((record) =>
      typed_values_equal(typed_value_for_record(record), operation.value),
    )
  ) {
    return {
      splices: [],
      result_range: null,
      provenance: { operation_id: operation.id, type: operation.type },
      semantic_change: { no_op: true, reason: "typed_value_present" },
    };
  }
  const records = layout.records.concat({
    buffer: new_item_buffer(
      typed_value_to_javascript(operation.value),
      layout.indent,
      layout.line_break,
    ),
  });
  return collection_result(operation, layout, records);
}

function compile_delete_value(target, operation, layout, delete_all) {
  validate_typed_value(operation.value, `${operation.type} value`);
  const matches = layout.records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) =>
      typed_values_equal(typed_value_for_record(record), operation.value),
    );
  if (matches.length === 0) {
    return {
      splices: [],
      result_range: null,
      provenance: { operation_id: operation.id, type: operation.type },
      semantic_change: { no_op: true, reason: "typed_value_absent" },
    };
  }
  const removed = new Set(
    (delete_all ? matches : matches.slice(0, 1)).map(({ index }) => index),
  );
  const records = layout.records.filter((_, index) => !removed.has(index));
  return collection_result(operation, layout, records);
}

function compile_assert_unique(operation, layout) {
  const seen = new Map();
  for (const record of layout.records) {
    const typed_value = typed_value_for_record(record);
    if (!typed_value) continue;
    const key = JSON.stringify(typed_value);
    if (seen.has(key)) {
      precondition_error("Sequence contains a duplicate typed value", {
        first_index: seen.get(key),
        duplicate_index: record.index,
        value: typed_value,
      });
    }
    seen.set(key, record.index);
  }
  return {
    splices: [],
    result_range: null,
    provenance: { operation_id: operation.id, type: operation.type },
    semantic_change: { no_op: true, unique: true },
  };
}

function compile_operation(context, target, operation) {
  assert_operation(operation);
  const layout = with_context(
    context,
    collection_items(context, target, "sequence"),
  );
  if (
    [
      "append_sequence_item",
      "prepend_sequence_item",
      "insert_sequence_item",
    ].includes(operation.type)
  ) {
    return compile_insert(context, target, operation, layout);
  }
  if (operation.type === "delete_sequence_item")
    return compile_delete(context, target, operation, layout);
  if (operation.type === "swap_sequence_items")
    return compile_swap(target, operation, layout);
  if (operation.type === "reorder_sequence_items")
    return compile_reorder(target, operation, layout);
  if (operation.type === "move_sequence_item")
    return compile_move(target, operation, layout);
  if (operation.type === "append_unique_sequence_value")
    return compile_append_unique(target, operation, layout);
  if (operation.type === "delete_one_sequence_value")
    return compile_delete_value(target, operation, layout, false);
  if (operation.type === "delete_all_sequence_values")
    return compile_delete_value(target, operation, layout, true);
  if (operation.type === "assert_sequence_unique")
    return compile_assert_unique(operation, layout);
  request_error(`Unsupported sequence operation: ${operation.type}`);
}

module.exports = {
  compile_operation,
  position_index,
  typed_value_for_record,
};
