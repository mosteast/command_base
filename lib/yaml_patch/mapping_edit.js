"use strict";

const path = require("node:path");
const YAML = require("yaml");

const { clone_json_value } = require("./artifact_version");
const { throw_request_error, Yaml_patch_error } = require("./error");
const {
  build_addressable_index,
  resolve_alias_target,
} = require("./addressable");
const { validate_addressable_index_binding } = require("./addressable_graph");
const { build_node_index, get_index_node } = require("./node_index");
const { validate_operation } = require("./operation_schema");
const { parse_yaml_source } = require("./parser");
const { evaluate_predicate } = require("./query_predicate");
const { select_query_results, validate_query_v2 } = require("./query_v2");
const { create_source_record, utf16_offset_to_byte } = require("./source");
const scalar_edit = require("./scalar_edit");
const { assert_current_target } = require("./snapshot_guard");
const {
  assert_insert_index,
  assert_snapshot_index,
  collection_items,
  join_item_buffers,
  line_break_for,
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
  validate_operation(operation, OPERATION_TYPES, "Mapping");
}

function pair_index_for(context, target, layout, reference, label = "pair") {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw_request_error(`${label} must identify a mapping pair`);
  }
  const fields = Object.keys(reference);
  if (
    fields.length !== 1 ||
    !["index", "key_raw_digest", "locator"].includes(fields[0])
  ) {
    throw_request_error(
      `${label} must use exactly one of index, key_raw_digest, or locator`,
    );
  }
  if (fields[0] === "index") {
    if (!Number.isSafeInteger(reference.index)) {
      throw_request_error(`${label} index must be a safe integer`);
    }
    return assert_snapshot_index(
      reference.index,
      layout.records.length,
      `${label} index`,
    );
  }
  if (fields[0] === "key_raw_digest") {
    if (typeof reference.key_raw_digest !== "string") {
      throw_request_error(`${label} key_raw_digest must be a string`);
    }
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
  if (typeof reference.locator !== "string" || reference.locator.length === 0) {
    throw_request_error(`${label} locator must be a non-empty string`);
  }
  const addressable_index =
    context.addressable_index || build_addressable_index(context.index);
  validate_addressable_index_binding(context.index, addressable_index);
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

function profile_record(entry, context) {
  return {
    entry,
    index: context.index,
    addressable_index: context.addressable_index,
    source_path: context.source_path,
    source_digest: context.index.source.digest,
  };
}

function profile_node_set_matches_target(context, target_entry, query) {
  const validated_query = validate_query_v2(query, { mode: "read" });
  const query_context = {
    ...context,
    limits: validated_query.limits,
    state: { relation_visits: 0 },
  };
  if (
    validated_query.select.kind === "self" &&
    validated_query.resolve_alias === "preserve"
  ) {
    return evaluate_predicate(
      target_entry,
      validated_query.where,
      query_context,
    );
  }
  const candidates = [];
  for (const entry of context.addressable_index.entries) {
    if (!evaluate_predicate(entry, validated_query.where, query_context)) {
      continue;
    }
    let record = profile_record(entry, context);
    if (
      validated_query.resolve_alias === "target" &&
      entry.addressable_type === "alias"
    ) {
      const resolution = resolve_alias_target(context.index, entry, {
        addressable_index: context.addressable_index,
      });
      record = profile_record(resolution.target_entry, context);
      record.alias_resolution = resolution;
    }
    candidates.push(record);
  }
  return select_query_results(candidates, validated_query.select).some(
    (record) => record.entry.locator === target_entry.locator,
  );
}

function profile_field_order(context, target) {
  if (!context.profile || !context.profile.node_sets) return null;
  const addressable_index =
    context.addressable_index || build_addressable_index(context.index);
  validate_addressable_index_binding(context.index, addressable_index);
  const target_entry = addressable_index.node_entry_by_id.get(target.id);
  if (!target_entry) return null;
  const query_context = {
    index: context.index,
    addressable_index,
    source_path: path.resolve(
      context.index.source.requested_path ||
        context.index.source.file_path ||
        "",
    ),
  };
  const matches = Object.entries(context.profile.node_sets).filter(
    ([, node_set]) =>
      Array.isArray(node_set.field_order) &&
      profile_node_set_matches_target(
        query_context,
        target_entry,
        node_set.query,
      ),
  );
  if (matches.length === 0) return null;
  const [first_name, first_node_set] = matches[0];
  for (const [name, node_set] of matches.slice(1)) {
    if (
      node_set.field_order.length !== first_node_set.field_order.length ||
      node_set.field_order.some(
        (field, index) => field !== first_node_set.field_order[index],
      )
    ) {
      throw_request_error(
        "Matching profile node sets have conflicting field_order",
        {
          details: { node_sets: [first_name, name] },
        },
      );
    }
  }
  return first_node_set.field_order;
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
    throw_request_error("Mapping position must be an object");
  }
  if (position.kind === "prepend" || position.kind === "append") {
    if (Object.keys(position).length !== 1) {
      throw_request_error(
        `Mapping ${position.kind} position only accepts kind`,
      );
    }
    return position.kind === "prepend" ? 0 : layout.records.length;
  }
  if (position.kind === "index") {
    if (
      Object.keys(position).length !== 2 ||
      !Object.hasOwn(position, "index") ||
      !Number.isSafeInteger(position.index)
    ) {
      throw_request_error(
        "Mapping index position requires only an integer index",
      );
    }
    return assert_insert_index(
      position.index,
      layout.records.length,
      "mapping position index",
    );
  }
  if (["before", "after"].includes(position.kind)) {
    if (
      Object.keys(position).length !== 2 ||
      !Object.hasOwn(position, "pair")
    ) {
      throw_request_error(
        `Mapping ${position.kind} position requires only pair`,
      );
    }
    const target_index = pair_index_for(
      context,
      target,
      layout,
      position.pair,
      "mapping position pair",
    );
    return position.kind === "before" ? target_index : target_index + 1;
  }
  throw_request_error(`Unsupported mapping position: ${position.kind}`);
}

function yaml_scalar_source(value) {
  return YAML.stringify(value).replace(/\n$/, "");
}

function new_pair_buffer(key, value, indent, line_break) {
  if (typeof key !== "string")
    throw_request_error("Mapping key must be a string");
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
  return { candidate, parsed };
}

function record_result_range(layout, records, result_index) {
  if (result_index === null) return null;
  if (result_index === undefined) {
    return {
      start_byte: layout.start_byte,
      end_byte:
        layout.start_byte +
        join_item_buffers(
          records,
          layout.indent,
          layout.line_break,
          layout.ends_with_line_break,
        ).length,
    };
  }
  const through_result = join_item_buffers(
    records.slice(0, result_index + 1),
    layout.indent,
    layout.line_break,
    result_index < records.length - 1 || layout.ends_with_line_break,
  ).length;
  const result_length = join_item_buffers(
    [records[result_index]],
    layout.indent,
    layout.line_break,
    result_index < records.length - 1 || layout.ends_with_line_break,
  ).length;
  return {
    start_byte: layout.start_byte + through_result - result_length,
    end_byte: layout.start_byte + through_result,
  };
}

function collection_result(operation, layout, records, result_index) {
  const replacement_buffer =
    records.length === 0
      ? Buffer.from(
          `{}` + (layout.ends_with_line_break ? layout.line_break : ""),
          "utf8",
        )
      : join_item_buffers(
          records,
          layout.indent,
          layout.line_break,
          layout.ends_with_line_break,
        );
  return {
    replacement_buffer,
    splice: {
      start_byte: layout.start_byte,
      end_byte: layout.end_byte,
      replacement_buffer,
      operation_id: operation.id,
    },
    result_range: record_result_range(layout, records, result_index),
  };
}

function no_op_result(operation) {
  return {
    splices: [],
    result_range: null,
    provenance: { operation_id: operation.id, type: operation.type },
    semantic_change: { no_op: true },
  };
}

function compile_add(context, target, operation, layout) {
  if (!Object.hasOwn(operation, "key") || !Object.hasOwn(operation, "value")) {
    throw_request_error("add_mapping_pair requires key and value");
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
  return collection_result(operation, layout, records, position);
}

function compile_delete(context, target, operation, layout) {
  const pair_index = pair_index_for(context, target, layout, operation.pair);
  const records = layout.records.filter((_, index) => index !== pair_index);
  return collection_result(operation, layout, records, null);
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
  if (
    records.every(
      (record, record_index) => record === layout.records[record_index],
    )
  ) {
    return { no_op: true };
  }
  return collection_result(operation, layout, records, destination);
}

function compile_reorder(context, target, operation, layout) {
  if (
    !Array.isArray(operation.pairs) ||
    operation.pairs.length !== layout.records.length
  ) {
    throw_request_error(
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
  if (indices.every((index, record_index) => index === record_index)) {
    return { no_op: true };
  }
  return collection_result(
    operation,
    layout,
    indices.map((index) => layout.records[index]),
  );
}

function compile_rename(context, target, operation, layout) {
  if (typeof operation.key !== "string")
    throw_request_error("rename_mapping_key requires key");
  if (/[\r\n]/.test(operation.key)) {
    unsupported_shape("Mapping key rename must remain a single-line scalar");
  }
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
  const { candidate, parsed } = candidate_parse(
    context,
    start_byte,
    end_byte,
    replacement_buffer,
  );
  const candidate_source = create_source_record(candidate);
  const candidate_index = build_node_index(candidate_source, parsed);
  const candidate_target = candidate_index.entries.find(
    (entry) =>
      entry.document === target.document &&
      entry.node_type === "mapping" &&
      JSON.stringify(entry.path) === JSON.stringify(target.path),
  );
  const candidate_node =
    candidate_target && get_index_node(candidate_index, candidate_target);
  const original_values = context.index.entries
    .filter(
      (entry) =>
        entry.parent_id === target.id && entry.relationship === "mapping_value",
    )
    .sort((left, right) => left.mapping_pair_index - right.mapping_pair_index);
  const candidate_values = candidate_target
    ? candidate_index.entries
        .filter(
          (entry) =>
            entry.parent_id === candidate_target.id &&
            entry.relationship === "mapping_value",
        )
        .sort(
          (left, right) => left.mapping_pair_index - right.mapping_pair_index,
        )
    : [];
  if (
    !candidate_node ||
    !YAML.isMap(candidate_node) ||
    candidate_node.items.length !== layout.node.items.length ||
    !candidate_node.items[pair_index] ||
    !YAML.isScalar(candidate_node.items[pair_index].key) ||
    candidate_node.items[pair_index].key.value !== operation.key ||
    candidate_values.length !== original_values.length ||
    candidate_values.some(
      (entry, index) => entry.raw_digest !== original_values[index].raw_digest,
    )
  ) {
    unsupported_shape(
      "Mapping key rename does not preserve the current mapping structure",
      target,
    );
  }
  if (
    replacement_buffer.equals(
      context.index.source.buffer.subarray(start_byte, end_byte),
    )
  ) {
    return no_op_result(operation);
  }
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

function json_safe_mapping_value(value) {
  try {
    return clone_json_value(value, "set_mapping_value value");
  } catch (error) {
    throw_request_error("set_mapping_value value must be JSON-safe data", {
      cause: error,
      details: error && error.details ? error.details : {},
    });
  }
}

function subtree_pair_buffer(context, pair, value, layout) {
  if (
    !pair.key ||
    !YAML.isScalar(pair.key) ||
    !Array.isArray(pair.key.range) ||
    !pair.srcToken ||
    !Array.isArray(pair.srcToken.start) ||
    !Array.isArray(pair.srcToken.sep) ||
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
  const colon_token = pair.srcToken.sep.find(
    (token) => token.type === "map-value-ind",
  );
  if (
    !colon_token ||
    !Number.isSafeInteger(colon_token.offset) ||
    typeof colon_token.source !== "string"
  ) {
    unsupported_shape("Mapping pair separator has no verified colon token");
  }
  const colon_end_byte = utf16_offset_to_byte(
    context.index.source,
    colon_token.offset + colon_token.source.length,
  );
  const pair_prefix = context.index.source.buffer.subarray(
    key_start_byte,
    colon_end_byte,
  );
  const value_start_byte = utf16_offset_to_byte(
    context.index.source,
    pair.value.range[0],
  );
  const separator_tail = context.index.source.buffer.subarray(
    colon_end_byte,
    value_start_byte,
  );
  const separator_comment_index = pair.srcToken.sep.findIndex(
    (token) => token.type === "comment",
  );
  const separator_newline =
    separator_comment_index < 0
      ? null
      : pair.srcToken.sep
          .slice(separator_comment_index + 1)
          .find((token) => token.type === "newline");
  const value_end_tokens =
    pair.value.srcToken && Array.isArray(pair.value.srcToken.end)
      ? pair.value.srcToken.end
      : [];
  const comment_token = value_end_tokens.find(
    (token) => token.type === "comment",
  );
  let header_suffix = Buffer.alloc(0);
  if (separator_comment_index >= 0) {
    if (
      !separator_newline ||
      !Number.isSafeInteger(separator_newline.offset) ||
      typeof separator_newline.source !== "string"
    ) {
      unsupported_shape("Mapping separator comment has no verified line break");
    }
    const newline_end_byte = utf16_offset_to_byte(
      context.index.source,
      separator_newline.offset + separator_newline.source.length,
    );
    header_suffix = context.index.source.buffer.subarray(
      colon_end_byte,
      newline_end_byte,
    );
  } else if (comment_token) {
    const comment_start_byte = utf16_offset_to_byte(
      context.index.source,
      comment_token.offset,
    );
    const comment_end_byte = utf16_offset_to_byte(
      context.index.source,
      comment_token.offset + comment_token.source.length,
    );
    header_suffix = Buffer.concat([
      separator_tail.length > 0 ? separator_tail : Buffer.from(" ", "utf8"),
      context.index.source.buffer.subarray(
        comment_start_byte,
        comment_end_byte,
      ),
    ]);
  }
  const child_indent = `${layout.indent}  `;
  const serialized_value = rebase_new_item(
    Buffer.from(YAML.stringify(value), "utf8"),
    child_indent,
    layout.line_break,
  );
  const value_prefix = Buffer.from(
    `${separator_comment_index >= 0 ? "" : layout.line_break}${child_indent}`,
    "utf8",
  );
  const buffer = Buffer.concat([
    pair_prefix,
    header_suffix,
    value_prefix,
    serialized_value,
  ]);
  const value_start_offset =
    pair_prefix.length + header_suffix.length + value_prefix.length;
  return {
    buffer,
    value_start_offset,
    value_end_offset: value_start_offset + serialized_value.length,
  };
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
    line_break_for(context.index.source),
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
    throw_request_error("set_mapping_value requires value");
  const pair_index = pair_index_for(context, target, layout, operation.pair);
  const safe_value = json_safe_mapping_value(operation.value);
  if (
    operation.style !== undefined &&
    safe_value !== null &&
    typeof safe_value === "object"
  ) {
    throw_request_error(
      "set_mapping_value style is only supported for scalar replacements",
    );
  }
  const safe_operation = { ...operation, value: safe_value };
  const value = layout.records[pair_index].item.value;
  if (!value || !Array.isArray(value.range)) {
    unsupported_shape(
      "set_mapping_value requires an existing value with a source range",
      target,
    );
  }
  if (!YAML.isScalar(value)) {
    return compile_collection_value_set(context, target, safe_operation, value);
  }
  const typed_value = typed_value_from_javascript(safe_value);
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
  const rebuilt_pair = subtree_pair_buffer(
    context,
    layout.records[pair_index].item,
    safe_value,
    layout,
  );
  records[pair_index] = rebuilt_pair;
  const compiled = collection_result(operation, layout, records);
  const rebuilt_pair_range = record_result_range(layout, records, pair_index);
  candidate_parse(
    context,
    compiled.splice.start_byte,
    compiled.splice.end_byte,
    compiled.splice.replacement_buffer,
  );
  return {
    splices: [compiled.splice],
    result_range: {
      start_byte:
        rebuilt_pair_range.start_byte + rebuilt_pair.value_start_offset,
      end_byte: rebuilt_pair_range.start_byte + rebuilt_pair.value_end_offset,
    },
    provenance: { operation_id: operation.id, type: operation.type },
    semantic_change: { no_op: false },
  };
}

function compile_operation(context, target, operation) {
  assert_operation(operation);
  assert_current_target(context, target, "Mapping edit");
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
    throw_request_error(`Unsupported mapping operation: ${operation.type}`);
  if (compiled.no_op) return no_op_result(operation);
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
