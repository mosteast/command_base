"use strict";

const YAML = require("yaml");

const { request_error, Yaml_patch_error } = require("./error");
const { build_addressable_index } = require("./addressable");
const { get_index_node } = require("./node_index");
const { parse_yaml_source } = require("./parser");
const { run_query_v2 } = require("./query_v2");
const { create_source_record, utf16_offset_to_byte } = require("./source");
const scalar_edit = require("./scalar_edit");
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
  "add_mapping_pair",
  "set_mapping_value",
  "delete_mapping_pair",
  "rename_mapping_key",
  "move_mapping_pair",
  "reorder_mapping_pairs",
]);

function assert_operation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    request_error("Mapping operation must be an object");
  }
  if (!OPERATION_TYPES.has(operation.type)) {
    request_error(`Unsupported mapping operation: ${operation.type}`);
  }
  if (typeof operation.id !== "string" || operation.id.length === 0) {
    request_error("Mapping operation id must be a non-empty string");
  }
}

function pair_index_for(context, target, layout, reference, label = "pair") {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    request_error(`${label} must identify a mapping pair`);
  }
  const fields = Object.keys(reference);
  if (
    fields.length !== 1 ||
    !["index", "key_raw_digest", "locator"].includes(fields[0])
  ) {
    request_error(
      `${label} must use exactly one of index, key_raw_digest, or locator`,
    );
  }
  if (fields[0] === "index") {
    return assert_snapshot_index(
      reference.index,
      layout.records.length,
      `${label} index`,
    );
  }
  if (fields[0] === "key_raw_digest") {
    const matches = target.child_key_digests
      .map((digest, index) => ({ digest, index }))
      .filter(({ digest }) => digest === reference.key_raw_digest);
    if (matches.length !== 1) {
      precondition_error(
        `${label} key digest does not identify one current pair`,
        {
          key_raw_digest: reference.key_raw_digest,
          match_count: matches.length,
        },
      );
    }
    return matches[0].index;
  }
  const addressable_index = context.addressable_index;
  const target_addressable =
    addressable_index && addressable_index.node_entry_by_id.get(target.id);
  const addressable =
    addressable_index &&
    addressable_index.entries.find(
      (entry) =>
        entry.addressable_type === "mapping_pair" &&
        entry.locator === reference.locator &&
        target_addressable &&
        entry.parent_id === target_addressable.id,
    );
  if (!addressable || !Number.isSafeInteger(addressable.mapping_pair_index)) {
    precondition_error(
      `${label} locator does not identify a current mapping pair`,
      {
        locator: reference.locator,
      },
    );
  }
  return assert_snapshot_index(
    addressable.mapping_pair_index,
    layout.records.length,
    `${label} locator index`,
  );
}

function profile_field_order(context, target) {
  if (!context.profile || !context.profile.node_sets) return null;
  const addressable_index =
    context.addressable_index || build_addressable_index(context.index);
  const target_entry = addressable_index.node_entry_by_id.get(target.id);
  if (!target_entry) return null;
  for (const node_set of Object.values(context.profile.node_sets)) {
    if (!Array.isArray(node_set.field_order)) continue;
    const max_result = Math.max(
      (node_set.query.limits && node_set.query.limits.max_result) || 0,
      addressable_index.entries.length,
    );
    const result = run_query_v2(
      [{ index: context.index, addressable_index }],
      {
        ...node_set.query,
        projection: { fields: ["locator"], missing: "error" },
        page: { limit: max_result },
        limits: {
          ...(node_set.query.limits || {}),
          max_result,
          max_output_bytes: Math.max(
            (node_set.query.limits && node_set.query.limits.max_output_bytes) ||
              0,
            1024 * 1024,
          ),
        },
      },
      { mode: "read" },
    );
    if (
      result.matches.some((match) => match.locator === target_entry.locator)
    ) {
      return node_set.field_order;
    }
  }
  return null;
}

function position_index(context, target, layout, position, key) {
  if (position === undefined) {
    const order = profile_field_order(context, target);
    if (!Array.isArray(order) || typeof key !== "string")
      return layout.records.length;
    const target_order = order.indexOf(key);
    if (target_order < 0) return layout.records.length;
    const node = layout.node;
    const existing_index = node.items.findIndex((pair) => {
      const value = pair.key && pair.key.value;
      const position = typeof value === "string" ? order.indexOf(value) : -1;
      return position > target_order;
    });
    return existing_index < 0 ? layout.records.length : existing_index;
  }
  if (!position || typeof position !== "object" || Array.isArray(position)) {
    request_error("Mapping position must be an object");
  }
  if (position.kind === "prepend") return 0;
  if (position.kind === "append") return layout.records.length;
  if (position.kind === "index") {
    return assert_insert_index(
      position.index,
      layout.records.length,
      "mapping position index",
    );
  }
  if (["before", "after"].includes(position.kind)) {
    const target_index = pair_index_for(
      context,
      target,
      layout,
      position.pair,
      "mapping position pair",
    );
    return position.kind === "before" ? target_index : target_index + 1;
  }
  request_error(`Unsupported mapping position: ${position.kind}`);
}

function yaml_scalar_source(value) {
  return YAML.stringify(value).replace(/\n$/, "");
}

function new_pair_buffer(key, value, indent, line_break) {
  if (typeof key !== "string") request_error("Mapping key must be a string");
  const raw = Buffer.from(YAML.stringify({ [key]: value }), "utf8");
  return rebase_new_item(raw, indent, line_break);
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
      "Mapping edit makes YAML invalid",
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
          `{}` + (layout.ends_with_line_break ? layout.line_break : ""),
          "utf8",
        )
      : join_item_buffers(records, layout.indent, layout.line_break);
  return {
    replacement_buffer,
    splice: {
      start_byte: layout.start_byte,
      end_byte: layout.end_byte,
      replacement_buffer,
      operation_id: operation.id,
    },
    result_range: {
      start_byte: layout.start_byte,
      end_byte: layout.start_byte + replacement_buffer.length,
    },
  };
}

function compile_add(context, target, operation, layout) {
  if (!Object.hasOwn(operation, "key") || !Object.hasOwn(operation, "value")) {
    request_error("add_mapping_pair requires key and value");
  }
  const position = position_index(
    context,
    target,
    layout,
    operation.position,
    operation.key,
  );
  const records = layout.records.slice();
  records.splice(position, 0, {
    buffer: new_pair_buffer(
      operation.key,
      operation.value,
      layout.indent,
      layout.line_break,
    ),
  });
  return collection_result(operation, layout, records);
}

function compile_delete(context, target, operation, layout) {
  const pair_index = pair_index_for(context, target, layout, operation.pair);
  const records = layout.records.filter((_, index) => index !== pair_index);
  return collection_result(operation, layout, records);
}

function compile_move(context, target, operation, layout) {
  const pair_index = pair_index_for(context, target, layout, operation.pair);
  const before_removal_destination = position_index(
    context,
    target,
    layout,
    operation.position,
  );
  const records = layout.records.slice();
  const [moved] = records.splice(pair_index, 1);
  const destination =
    before_removal_destination > pair_index
      ? before_removal_destination - 1
      : before_removal_destination;
  records.splice(destination, 0, moved);
  return collection_result(operation, layout, records);
}

function compile_reorder(context, target, operation, layout) {
  if (
    !Array.isArray(operation.pairs) ||
    operation.pairs.length !== layout.records.length
  ) {
    request_error(
      "reorder_mapping_pairs requires every current pair exactly once",
    );
  }
  const indices = operation.pairs.map((reference) =>
    pair_index_for(context, target, layout, reference, "reorder pair"),
  );
  if (new Set(indices).size !== layout.records.length) {
    precondition_error(
      "reorder_mapping_pairs contains a duplicate or vanished pair",
    );
  }
  return collection_result(
    operation,
    layout,
    indices.map((index) => layout.records[index]),
  );
}

function compile_rename(context, target, operation, layout) {
  if (typeof operation.key !== "string")
    request_error("rename_mapping_key requires key");
  const pair_index = pair_index_for(context, target, layout, operation.pair);
  const pair = layout.records[pair_index].item;
  if (!pair.key || !Array.isArray(pair.key.range)) {
    unsupported_shape("Mapping key has no verified source range", target);
  }
  const start_byte = utf16_offset_to_byte(
    context.index.source,
    pair.key.range[0],
  );
  const end_byte = utf16_offset_to_byte(
    context.index.source,
    pair.key.range[1],
  );
  const replacement_buffer = Buffer.from(
    yaml_scalar_source(operation.key),
    "utf8",
  );
  candidate_parse(context, start_byte, end_byte, replacement_buffer);
  return {
    splices: [
      { start_byte, end_byte, replacement_buffer, operation_id: operation.id },
    ],
    result_range: {
      start_byte,
      end_byte: start_byte + replacement_buffer.length,
    },
    provenance: { operation_id: operation.id, type: operation.type },
    semantic_change: {
      no_op: replacement_buffer.equals(
        context.index.source.buffer.subarray(start_byte, end_byte),
      ),
    },
  };
}

function typed_value_from_javascript(value) {
  if (value === null) return { type: "null", value: null };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isSafeInteger(value)
      ? { type: "integer", value }
      : { type: "float", value };
  }
  return null;
}

function subtree_pair_buffer(context, pair, value, layout) {
  if (
    !pair.key ||
    !YAML.isScalar(pair.key) ||
    !Array.isArray(pair.key.range) ||
    !pair.srcToken ||
    !Array.isArray(pair.srcToken.start) ||
    pair.srcToken.start.some((token) => token.type === "explicit-key-ind")
  ) {
    unsupported_shape(
      "Mapping subtree replacement requires a simple key declaration",
    );
  }
  const key_start_byte = utf16_offset_to_byte(
    context.index.source,
    pair.key.range[0],
  );
  const key_end_byte = utf16_offset_to_byte(
    context.index.source,
    pair.key.range[1],
  );
  const key_buffer = context.index.source.buffer.subarray(
    key_start_byte,
    key_end_byte,
  );
  const child_indent = `${layout.indent}  `;
  const serialized_value = rebase_new_item(
    Buffer.from(YAML.stringify(value), "utf8"),
    child_indent,
    layout.line_break,
  );
  return Buffer.concat([
    key_buffer,
    Buffer.from(`:${layout.line_break}${child_indent}`, "utf8"),
    serialized_value,
  ]);
}

function compile_collection_value_set(context, target, operation, value) {
  if (
    !value.srcToken ||
    !["block-map", "block-seq"].includes(value.srcToken.type) ||
    !Number.isSafeInteger(value.srcToken.indent) ||
    value.srcToken.indent < 0
  ) {
    unsupported_shape(
      "set_mapping_value requires a provable block collection value",
      target,
    );
  }
  const start_byte = utf16_offset_to_byte(context.index.source, value.range[0]);
  let end_byte = utf16_offset_to_byte(context.index.source, value.range[1]);
  const source_buffer = context.index.source.buffer;
  if (
    end_byte - start_byte >= 2 &&
    source_buffer[end_byte - 2] === 0x0d &&
    source_buffer[end_byte - 1] === 0x0a
  ) {
    end_byte -= 2;
  } else if (
    end_byte > start_byte &&
    (source_buffer[end_byte - 1] === 0x0a ||
      source_buffer[end_byte - 1] === 0x0d)
  ) {
    end_byte -= 1;
  }
  const serialized = YAML.stringify(operation.value).replace(/\n$/, "");
  const replacement_buffer = rebase_new_item(
    Buffer.from(serialized, "utf8"),
    " ".repeat(value.srcToken.indent),
    context.index.source.line_break_mode === "crlf" ? "\r\n" : "\n",
  );
  candidate_parse(context, start_byte, end_byte, replacement_buffer);
  return {
    splices: [
      { start_byte, end_byte, replacement_buffer, operation_id: operation.id },
    ],
    result_range: {
      start_byte,
      end_byte: start_byte + replacement_buffer.length,
    },
    provenance: { operation_id: operation.id, type: operation.type },
    semantic_change: { no_op: false },
  };
}

function compile_set(context, target, operation, layout) {
  if (!Object.hasOwn(operation, "value"))
    request_error("set_mapping_value requires value");
  const pair_index = pair_index_for(context, target, layout, operation.pair);
  const value = layout.records[pair_index].item.value;
  if (!value || !Array.isArray(value.range)) {
    unsupported_shape(
      "set_mapping_value requires an existing value with a source range",
      target,
    );
  }
  if (!YAML.isScalar(value)) {
    return compile_collection_value_set(context, target, operation, value);
  }
  const typed_value = typed_value_from_javascript(operation.value);
  const value_entry = context.index.entries.find(
    (entry) =>
      entry.parent_id === target.id &&
      entry.relationship === "mapping_value" &&
      entry.mapping_pair_index === pair_index,
  );
  if (typed_value && value_entry) {
    const compiled = scalar_edit.compile_operation(context, value_entry, {
      id: operation.id,
      type: "set_scalar_value",
      value: typed_value,
      ...(operation.style === undefined ? {} : { style: operation.style }),
    });
    return {
      ...compiled,
      provenance: { operation_id: operation.id, type: operation.type },
    };
  }
  const records = layout.records.slice();
  records[pair_index] = {
    buffer: subtree_pair_buffer(
      context,
      layout.records[pair_index].item,
      operation.value,
      layout,
    ),
  };
  const compiled = collection_result(operation, layout, records);
  candidate_parse(
    context,
    compiled.splice.start_byte,
    compiled.splice.end_byte,
    compiled.splice.replacement_buffer,
  );
  return {
    splices: [compiled.splice],
    result_range: compiled.result_range,
    provenance: { operation_id: operation.id, type: operation.type },
    semantic_change: { no_op: false },
  };
}

function compile_operation(context, target, operation) {
  assert_operation(operation);
  const layout = collection_items(context, target, "mapping");
  if (operation.type === "set_mapping_value") {
    return compile_set(context, target, operation, layout);
  }
  if (operation.type === "rename_mapping_key") {
    return compile_rename(context, target, operation, layout);
  }
  let compiled;
  if (operation.type === "add_mapping_pair")
    compiled = compile_add(context, target, operation, layout);
  if (operation.type === "delete_mapping_pair")
    compiled = compile_delete(context, target, operation, layout);
  if (operation.type === "move_mapping_pair")
    compiled = compile_move(context, target, operation, layout);
  if (operation.type === "reorder_mapping_pairs")
    compiled = compile_reorder(context, target, operation, layout);
  if (!compiled)
    request_error(`Unsupported mapping operation: ${operation.type}`);
  candidate_parse(
    context,
    compiled.splice.start_byte,
    compiled.splice.end_byte,
    compiled.splice.replacement_buffer,
  );
  return {
    splices: [compiled.splice],
    result_range: compiled.result_range,
    provenance: { operation_id: operation.id, type: operation.type },
    semantic_change: { no_op: false },
  };
}

module.exports = {
  compile_operation,
  pair_index_for,
  position_index,
};
