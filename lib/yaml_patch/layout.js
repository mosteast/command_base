"use strict";

const YAML = require("yaml");

const { Yaml_patch_error, request_error } = require("./error");
const { get_index_node } = require("./node_index");
const { utf16_offset_to_byte } = require("./source");

function unsupported_shape(message, target, details = {}) {
  throw new Yaml_patch_error("UNSUPPORTED_EDIT_SHAPE", message, {
    details: { locator: target && target.locator, ...details },
    next_action:
      "use a block mapping or block sequence with verified CST delimiters",
  });
}

function precondition_error(message, details = {}) {
  throw new Yaml_patch_error("PRECONDITION_FAILED", message, {
    details,
    next_action: "refresh the current snapshot and select an existing position",
  });
}

function assert_block_collection(context, target, expected_type) {
  if (!context || !context.index) request_error("Edit context requires index");
  const node = get_index_node(context.index, target);
  const expected = expected_type === "mapping" ? YAML.isMap : YAML.isSeq;
  const cst_type = expected_type === "mapping" ? "block-map" : "block-seq";
  if (
    !node ||
    !expected(node) ||
    !node.srcToken ||
    !Array.isArray(node.range)
  ) {
    unsupported_shape(`Target is not a ${expected_type}`, target);
  }
  if (node.srcToken.type !== cst_type || !Array.isArray(node.srcToken.items)) {
    unsupported_shape(
      `Only ${cst_type} structural edits are supported`,
      target,
      {
        cst_type: node.srcToken.type,
      },
    );
  }
  if (node.items.length === 0) {
    unsupported_shape(
      "Empty block collections have no provable insertion delimiter",
      target,
    );
  }
  return node;
}

function line_break_for(source) {
  return source.line_break_mode === "crlf" ? "\r\n" : "\n";
}

function collection_indent(node) {
  return " ".repeat(node.srcToken.indent || 0);
}

function first_offset(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  const token = tokens.find((candidate) => Number.isInteger(candidate.offset));
  return token ? token.offset : null;
}

function first_meaningful_offset(tokens) {
  if (!Array.isArray(tokens)) return null;
  const token = tokens.find(
    (candidate) =>
      candidate.type !== "space" && Number.isInteger(candidate.offset),
  );
  return token ? token.offset : null;
}

function content_offset(item, item_token, collection_type) {
  if (collection_type === "mapping") {
    if (item.key && Array.isArray(item.key.range)) return item.key.range[0];
    const start = first_meaningful_offset(item_token && item_token.start);
    if (start !== null) return start;
  } else {
    const start = first_meaningful_offset(item_token && item_token.start);
    if (start !== null) return start;
    if (item.value && Array.isArray(item.value.range))
      return item.value.range[0];
    if (Array.isArray(item.range)) return item.range[0];
  }
  return null;
}

function outer_offset(item, item_token, collection_type) {
  const start = first_offset(item_token && item_token.start);
  if (start !== null) return start;
  return content_offset(item, item_token, collection_type);
}

function collection_items(context, target, collection_type) {
  const node = assert_block_collection(context, target, collection_type);
  const source = context.index.source;
  const records = node.items.map((item, index) => {
    const item_token =
      collection_type === "sequence"
        ? node.srcToken.items[index]
        : item.srcToken;
    const start_character = content_offset(item, item_token, collection_type);
    const next_item = node.items[index + 1];
    const next_item_token = next_item
      ? collection_type === "sequence"
        ? node.srcToken.items[index + 1]
        : next_item.srcToken
      : null;
    const end_character = next_item
      ? outer_offset(next_item, next_item_token, collection_type)
      : node.range[1];
    if (
      !Number.isInteger(start_character) ||
      !Number.isInteger(end_character) ||
      start_character >= end_character
    ) {
      unsupported_shape("Collection item boundaries cannot be proven", target, {
        collection_type,
        item_index: index,
      });
    }
    const start_byte = utf16_offset_to_byte(source, start_character);
    const end_byte = utf16_offset_to_byte(source, end_character);
    return {
      index,
      item,
      item_token,
      start_character,
      end_character,
      start_byte,
      end_byte,
      buffer: source.buffer.subarray(start_byte, end_byte),
    };
  });
  const start_byte = utf16_offset_to_byte(source, node.range[0]);
  const end_byte = utf16_offset_to_byte(source, node.range[1]);
  return {
    node,
    records,
    start_byte,
    end_byte,
    collection_type,
    indent: collection_indent(node),
    line_break: line_break_for(source),
    ends_with_line_break: /\r?\n$|\r$/.test(
      source.text.slice(node.range[0], node.range[1]),
    ),
  };
}

function normalize_item_buffer(buffer, line_break) {
  if (!Buffer.isBuffer(buffer))
    throw new TypeError("item buffer must be a Buffer");
  if (buffer.length === 0) return buffer;
  const text = buffer.toString("utf8");
  return text.endsWith("\n") || text.endsWith("\r")
    ? buffer
    : Buffer.concat([buffer, Buffer.from(line_break, "utf8")]);
}

function join_item_buffers(records, indent, line_break) {
  if (!Array.isArray(records) || records.length === 0) return Buffer.alloc(0);
  const pieces = [];
  records.forEach((record, index) => {
    if (index > 0) pieces.push(Buffer.from(indent, "utf8"));
    pieces.push(normalize_item_buffer(record.buffer || record, line_break));
  });
  return Buffer.concat(pieces);
}

function rebase_new_item(buffer, indent, line_break) {
  const lines = buffer
    .toString("utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  return Buffer.from(
    lines
      .map((line, index) =>
        index === 0 || (index === lines.length - 1 && line === "")
          ? line
          : `${indent}${line}`,
      )
      .join(line_break),
    "utf8",
  );
}

function assert_snapshot_index(index, length, label) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    precondition_error(`${label} is outside the current snapshot`, {
      index,
      length,
    });
  }
  return index;
}

function assert_insert_index(index, length, label) {
  if (!Number.isSafeInteger(index) || index < 0 || index > length) {
    precondition_error(`${label} is outside the current snapshot`, {
      index,
      length,
    });
  }
  return index;
}

module.exports = {
  assert_block_collection,
  assert_insert_index,
  assert_snapshot_index,
  collection_items,
  join_item_buffers,
  line_break_for,
  precondition_error,
  rebase_new_item,
  unsupported_shape,
};
