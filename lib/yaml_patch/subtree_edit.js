"use strict";

const YAML = require("yaml");

const { Yaml_patch_error, throw_request_error } = require("./error");
const { collection_items, join_item_buffers } = require("./layout");
const { get_index_node } = require("./node_index");
const { assert_current_target } = require("./snapshot_guard");

const SUBTREE_OPERATION = new Set([
  "add_subtree",
  "copy_subtree",
  "delete_subtree",
  "move_subtree",
]);

function unsupported_shape(message, target) {
  throw new Yaml_patch_error("UNSUPPORTED_EDIT_SHAPE", message, {
    details: { locator: target && target.locator },
  });
}

function cross_boundary(message, details = {}) {
  throw new Yaml_patch_error("CROSS_BOUNDARY_DEPENDENCY", message, { details });
}

function visit_yaml(node, callback, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  callback(node);
  if (YAML.isMap(node)) {
    for (const pair of node.items) {
      visit_yaml(pair.key, callback, seen);
      visit_yaml(pair.value, callback, seen);
    }
  } else if (YAML.isSeq(node)) {
    for (const item of node.items) visit_yaml(item, callback, seen);
  }
}

function subtree_dependency(context, target) {
  const root = get_index_node(context.index, target);
  if (!root) unsupported_shape("The subtree node is not available", target);
  if (/(?:^|\r?\n)%[A-Z]+(?:\s|$)/.test(context.index.source.text)) {
    unsupported_shape("Document directives cannot be relocated safely", target);
  }
  const subtree_nodes = new Set();
  const anchors = new Set();
  const aliases = [];
  visit_yaml(root, (node) => {
    subtree_nodes.add(node);
    if (
      (YAML.isMap(node) || YAML.isSeq(node)) &&
      (node.flow || node.srcToken?.type === "flow-collection")
    ) {
      unsupported_shape("Flow collections cannot be relocated safely", target);
    }
    if (YAML.isScalar(node) && node.srcToken?.type === "block-scalar") {
      unsupported_shape("Block scalars cannot be relocated safely", target);
    }
    if (node.tag && !node.tag.startsWith("tag:yaml.org,2002:")) {
      unsupported_shape("Custom tags cannot be relocated safely", target);
    }
    if (typeof node.anchor === "string" && node.anchor.length > 0)
      anchors.add(node.anchor);
    if (YAML.isAlias(node)) aliases.push(node.source);
  });
  for (const alias of aliases) {
    if (!anchors.has(alias)) {
      cross_boundary("Subtree alias depends on an external anchor", {
        anchor: alias,
      });
    }
  }
  const document = context.index.parser_result.documents[target.document];
  visit_yaml(document && document.contents, (node) => {
    if (
      YAML.isAlias(node) &&
      !subtree_nodes.has(node) &&
      anchors.has(node.source)
    ) {
      cross_boundary("An external alias depends on a moved subtree anchor", {
        anchor: node.source,
      });
    }
  });
  return { anchors, subtree_nodes };
}

function assert_destination_anchor_safety(
  source_context,
  destination_context,
  destination_target,
  operation,
  dependency,
) {
  if (dependency.anchors.size === 0) return;
  const destination_document =
    destination_context.index.parser_result.documents[
      destination_target.document
    ];
  visit_yaml(destination_document && destination_document.contents, (node) => {
    if (typeof node.anchor !== "string" || !dependency.anchors.has(node.anchor))
      return;
    const moving_within_document =
      operation.type === "move_subtree" &&
      source_context.index === destination_context.index &&
      dependency.subtree_nodes.has(node);
    if (!moving_within_document) {
      cross_boundary("Subtree relocation would create a duplicate anchor", {
        anchor: node.anchor,
      });
    }
  });
}

function source_layout_for(context, target) {
  const collection_type =
    target.relationship === "mapping_value"
      ? "mapping"
      : target.relationship === "sequence_item"
        ? "sequence"
        : null;
  if (!collection_type)
    unsupported_shape("The subtree must be a collection item", target);
  const parent = context.index._internal.entry_by_id.get(target.parent_id);
  if (!parent)
    unsupported_shape("The subtree parent is not addressable", target);
  return collection_items(context, parent, collection_type);
}

function destination_position(operation, record_count) {
  const position = operation.position;
  if (!position || typeof position !== "object" || Array.isArray(position)) {
    throw_request_error("Subtree destination requires a position object");
  }
  if (position.kind === "append") return record_count;
  if (position.kind === "prepend") return 0;
  throw_request_error(`Unsupported subtree position: ${position.kind}`);
}

function line_end_after(buffer, byte_offset) {
  let end_byte = byte_offset;
  while (
    end_byte < buffer.length &&
    buffer[end_byte] !== 0x0a &&
    buffer[end_byte] !== 0x0d
  ) {
    end_byte += 1;
  }
  if (buffer[end_byte] === 0x0d && buffer[end_byte + 1] === 0x0a)
    return end_byte + 2;
  return end_byte < buffer.length ? end_byte + 1 : end_byte;
}

function owned_comment_start(buffer, item_start_byte, indent) {
  const indent_buffer = Buffer.from(indent);
  let line_start = item_start_byte - indent_buffer.length;
  if (
    line_start < 0 ||
    !buffer.subarray(line_start, item_start_byte).equals(indent_buffer)
  ) {
    return item_start_byte;
  }
  let owned_start_byte = item_start_byte;
  while (line_start > 0) {
    let previous_end = line_start;
    if (buffer[previous_end - 1] === 0x0a) previous_end -= 1;
    if (buffer[previous_end - 1] === 0x0d) previous_end -= 1;
    let previous_start = previous_end;
    while (
      previous_start > 0 &&
      buffer[previous_start - 1] !== 0x0a &&
      buffer[previous_start - 1] !== 0x0d
    ) {
      previous_start -= 1;
    }
    const previous_line = buffer.subarray(previous_start, previous_end);
    if (
      previous_line.length <= indent_buffer.length ||
      !previous_line.subarray(0, indent_buffer.length).equals(indent_buffer) ||
      previous_line[indent_buffer.length] !== 0x23
    ) {
      break;
    }
    owned_start_byte = previous_start + indent_buffer.length;
    line_start = previous_start;
  }
  return owned_start_byte;
}

function movable_record(context, target, layout, record) {
  const source_buffer = context.index.source.buffer;
  const target_end_byte = target.source.node_end_byte;
  const prior_byte = source_buffer[target_end_byte - 1];
  const movable_end_byte =
    prior_byte === 0x0a || prior_byte === 0x0d
      ? target_end_byte
      : line_end_after(source_buffer, target_end_byte);
  if (movable_end_byte > record.end_byte) {
    unsupported_shape("The collection item boundary cannot be proven", target);
  }
  const start_byte = Math.min(
    record.start_byte,
    owned_comment_start(source_buffer, record.start_byte, layout.indent),
  );
  return {
    ...record,
    start_byte,
    buffer: source_buffer.subarray(start_byte, movable_end_byte),
    trailing_buffer: context.index.source.buffer.subarray(
      movable_end_byte,
      record.end_byte,
    ),
  };
}

function rebase_record(record, source_indent, destination_indent) {
  if (source_indent === destination_indent) return record;
  const pieces = record.buffer.toString("utf8").split(/(\r\n|\n|\r)/);
  for (let index = 2; index < pieces.length; index += 2) {
    if (pieces[index].length === 0) continue;
    if (!pieces[index].startsWith(source_indent)) {
      unsupported_shape("Subtree continuation indentation cannot be proven");
    }
    pieces[index] =
      `${destination_indent}${pieces[index].slice(source_indent.length)}`;
  }
  return { ...record, buffer: Buffer.from(pieces.join(""), "utf8") };
}

function replacement_result(operation, layout, records, result_index) {
  const replacement_buffer = join_item_buffers(
    records,
    layout.indent,
    layout.line_break,
    layout.ends_with_line_break,
  );
  const collection_replacement =
    records.length === 0
      ? Buffer.from(
          `${layout.collection_type === "sequence" ? "[]" : "{}"}${
            layout.ends_with_line_break ? layout.line_break : ""
          }`,
        )
      : replacement_buffer;
  return {
    splices: [
      {
        start_byte: layout.start_byte,
        end_byte: layout.end_byte,
        replacement_buffer: collection_replacement,
        operation_id: operation.id,
      },
    ],
    result_range: record_result_range(layout, records, result_index),
    provenance: { operation_id: operation.id, type: operation.type },
    semantic_change: { no_op: false },
  };
}

function record_result_range(layout, records, result_index) {
  if (result_index === null) return null;
  const before = join_item_buffers(
    records.slice(0, result_index),
    layout.indent,
    layout.line_break,
    result_index > 0,
  );
  const result = join_item_buffers(
    [records[result_index]],
    layout.indent,
    layout.line_break,
    result_index < records.length - 1 || layout.ends_with_line_break,
  );
  const separator_length =
    result_index === 0 ? 0 : Buffer.byteLength(layout.indent);
  const start_byte = layout.start_byte + before.length + separator_length;
  return { start_byte, end_byte: start_byte + result.length };
}

function raw_subtree_record(operation, destination_layout) {
  if (typeof operation.raw !== "string" || operation.raw.length === 0) {
    throw_request_error("add_subtree requires non-empty raw YAML");
  }
  const parsed = YAML.parseDocument(operation.raw, {
    strict: true,
    uniqueKeys: true,
  });
  if (parsed.errors.length > 0 || !parsed.contents) {
    throw new Yaml_patch_error(
      "YAML_DIAGNOSTIC",
      "add_subtree raw is not one YAML node",
      {
        details: {
          diagnostics: parsed.errors.map((error) =>
            String(error.message || error),
          ),
        },
      },
    );
  }
  const normalized = operation.raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n+$/, "");
  const lines = normalized.split("\n");
  let record_lines;
  if (destination_layout.collection_type === "sequence") {
    record_lines = [
      `- ${lines[0]}`,
      ...lines.slice(1).map((line) => `${destination_layout.indent}  ${line}`),
    ];
  } else {
    if (typeof operation.key !== "string" || operation.key.length === 0) {
      throw_request_error("add_subtree to a mapping requires key");
    }
    const key = YAML.stringify(operation.key).trim();
    record_lines =
      lines.length === 1
        ? [`${key}: ${lines[0]}`]
        : [
            `${key}:`,
            ...lines.map((line) => `${destination_layout.indent}  ${line}`),
          ];
  }
  return {
    buffer: Buffer.from(
      `${record_lines.join(destination_layout.line_break)}${destination_layout.line_break}`,
    ),
  };
}

function source_removal_records(
  source_layout,
  source_record,
  source_index,
  source_target,
) {
  const source_records = source_layout.records.slice();
  source_records.splice(source_index, 1);
  if (source_record.trailing_buffer.length > 0) {
    if (source_index === 0) {
      unsupported_shape(
        "A leading separator cannot be preserved after subtree removal",
        source_target,
      );
    }
    const previous = source_records[source_index - 1];
    source_records[source_index - 1] = {
      ...previous,
      buffer: Buffer.concat([previous.buffer, source_record.trailing_buffer]),
    };
  }
  return source_records;
}

function compile_subtree_operation(
  source_context,
  source_target,
  destination_context,
  destination_target,
  operation,
) {
  if (
    !operation ||
    typeof operation !== "object" ||
    !SUBTREE_OPERATION.has(operation.type)
  ) {
    throw_request_error("Unsupported subtree operation");
  }
  if (typeof operation.id !== "string" || operation.id.length === 0) {
    throw_request_error("Subtree operation id must be non-empty");
  }
  if (operation.type === "add_subtree") {
    assert_current_target(
      destination_context,
      destination_target,
      "Subtree destination",
    );
    if (!new Set(["mapping", "sequence"]).has(destination_target.node_type)) {
      unsupported_shape(
        "Subtree destination must be a block collection",
        destination_target,
      );
    }
    const destination_layout = collection_items(
      destination_context,
      destination_target,
      destination_target.node_type,
    );
    const destination_records = destination_layout.records.slice();
    const result_index = destination_position(
      operation,
      destination_records.length,
    );
    destination_records.splice(
      result_index,
      0,
      raw_subtree_record(operation, destination_layout),
    );
    return {
      source: {
        splices: [],
        result_range: null,
        semantic_change: { no_op: true },
      },
      destination: replacement_result(
        operation,
        destination_layout,
        destination_records,
        result_index,
      ),
      moved_ranges: [],
    };
  }

  assert_current_target(source_context, source_target, "Subtree source");
  const dependency = subtree_dependency(source_context, source_target);
  const source_layout = source_layout_for(source_context, source_target);
  const source_index =
    source_layout.collection_type === "mapping"
      ? source_target.mapping_pair_index
      : source_target.sequence_index;
  const source_record = movable_record(
    source_context,
    source_target,
    source_layout,
    source_layout.records[source_index],
  );
  if (operation.type === "delete_subtree") {
    return {
      source: replacement_result(
        operation,
        source_layout,
        source_removal_records(
          source_layout,
          source_record,
          source_index,
          source_target,
        ),
        null,
      ),
      destination: {
        splices: [],
        result_range: null,
        semantic_change: { no_op: true },
      },
      moved_ranges: [
        {
          operation_id: operation.id,
          owner: "source",
          start_byte: source_record.start_byte,
          end_byte: source_record.start_byte + source_record.buffer.length,
          includes_owned_comment:
            source_record.start_byte < source_target.source.start_byte,
        },
      ],
    };
  }

  assert_current_target(
    destination_context,
    destination_target,
    "Subtree destination",
  );
  assert_destination_anchor_safety(
    source_context,
    destination_context,
    destination_target,
    operation,
    dependency,
  );
  if (destination_target.node_type !== source_layout.collection_type) {
    unsupported_shape(
      "Source and destination collection types must match",
      destination_target,
    );
  }
  const destination_layout = collection_items(
    destination_context,
    destination_target,
    source_layout.collection_type,
  );
  const destination_records = destination_layout.records.slice();
  const result_index = destination_position(
    operation,
    destination_records.length,
  );
  destination_records.splice(
    result_index,
    0,
    rebase_record(
      source_record,
      source_layout.indent,
      destination_layout.indent,
    ),
  );

  const source_records = source_layout.records.slice();
  if (operation.type === "move_subtree") {
    source_records.splice(
      0,
      source_records.length,
      ...source_removal_records(
        source_layout,
        source_record,
        source_index,
        source_target,
      ),
    );
  }
  return {
    source:
      operation.type === "move_subtree"
        ? replacement_result(operation, source_layout, source_records, null)
        : { splices: [], result_range: null, semantic_change: { no_op: true } },
    destination: replacement_result(
      operation,
      destination_layout,
      destination_records,
      result_index,
    ),
    moved_ranges: [
      {
        operation_id: operation.id,
        owner: "source",
        start_byte: source_record.start_byte,
        end_byte: source_record.start_byte + source_record.buffer.length,
        includes_owned_comment:
          source_record.start_byte < source_target.source.start_byte,
      },
    ],
  };
}

module.exports = { compile_subtree_operation };
