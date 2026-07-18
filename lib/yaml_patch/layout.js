"use strict";

const YAML = require("yaml");

const { throw_request_error, Yaml_patch_error } = require("./error");
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
  if (!context || !context.index)
    throw_request_error("Edit context requires index");
  if (
    !target ||
    typeof target !== "object" ||
    !Number.isSafeInteger(target.id)
  ) {
    throw_request_error("Edit target must be a current node entry");
  }
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
  if (source.line_break_mode === "crlf") return "\r\n";
  if (source.line_break_mode === "cr") return "\r";
  return "\n";
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

function token_end_offset(token) {
  return Number.isInteger(token && token.offset) &&
    typeof token.source === "string"
    ? token.offset + token.source.length
    : null;
}

function item_primary_offset(item, item_token, collection_type) {
  if (collection_type === "mapping") {
    return item.key && Array.isArray(item.key.range) ? item.key.range[0] : null;
  }
  const indicator =
    item_token &&
    Array.isArray(item_token.start) &&
    item_token.start.find((token) => token.type === "seq-item-ind");
  return indicator && Number.isInteger(indicator.offset)
    ? indicator.offset
    : content_offset(item, item_token, collection_type);
}

function item_boundary(item, item_token, collection_type, indent_length) {
  const primary_offset = item_primary_offset(item, item_token, collection_type);
  if (!Number.isInteger(primary_offset)) {
    return { content_offset: null, outer_offset: null };
  }
  const start_tokens = Array.isArray(item_token && item_token.start)
    ? item_token.start.filter(
        (token) =>
          Number.isInteger(token.offset) && token.offset < primary_offset,
      )
    : [];
  let cursor = start_tokens.length - 1;
  let item_indent_token = null;
  if (
    cursor >= 0 &&
    start_tokens[cursor].type === "space" &&
    token_end_offset(start_tokens[cursor]) === primary_offset
  ) {
    item_indent_token = start_tokens[cursor];
    cursor -= 1;
  }

  let first_comment = null;
  let first_comment_indent = null;
  while (cursor >= 0 && start_tokens[cursor].type === "newline") {
    cursor -= 1;
    const comment = start_tokens[cursor];
    if (
      !comment ||
      comment.type !== "comment" ||
      comment.indent !== indent_length
    ) {
      break;
    }
    first_comment = comment;
    cursor -= 1;
    const comment_indent = start_tokens[cursor];
    if (
      comment_indent &&
      comment_indent.type === "space" &&
      token_end_offset(comment_indent) === comment.offset
    ) {
      first_comment_indent = comment_indent;
      cursor -= 1;
    } else {
      first_comment_indent = null;
    }
  }

  return {
    content_offset: first_comment ? first_comment.offset : primary_offset,
    outer_offset: first_comment
      ? first_comment_indent
        ? first_comment_indent.offset
        : first_comment.offset
      : item_indent_token
        ? item_indent_token.offset
        : primary_offset,
  };
}

function collection_items(context, target, collection_type) {
  const node = assert_block_collection(context, target, collection_type);
  const source = context.index.source;
  const indent = collection_indent(node);
  const boundaries = node.items.map((item, index) => {
    const item_token =
      collection_type === "sequence"
        ? node.srcToken.items[index]
        : item.srcToken;
    return {
      item,
      item_token,
      ...item_boundary(item, item_token, collection_type, indent.length),
    };
  });
  const records = boundaries.map((boundary, index) => {
    const { item, item_token } = boundary;
    const start_character = boundary.content_offset;
    const coverage_start_character =
      index === 0 ? node.range[0] : boundary.outer_offset;
    const end_character = boundaries[index + 1]
      ? boundaries[index + 1].outer_offset
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
    const coverage_start_byte = utf16_offset_to_byte(
      source,
      coverage_start_character,
    );
    const end_byte = utf16_offset_to_byte(source, end_character);
    return {
      index,
      item,
      item_token,
      start_character,
      end_character,
      start_byte,
      end_byte,
      coverage_start_byte,
      coverage_end_byte: end_byte,
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
    indent,
    line_break: line_break_for(source),
    ends_with_line_break: /\r?\n$|\r$/.test(
      source.text.slice(node.range[0], node.range[1]),
    ),
  };
}

function normalize_item_buffer(buffer, line_break, require_line_break) {
  if (!Buffer.isBuffer(buffer))
    throw new TypeError("item buffer must be a Buffer");
  if (buffer.length === 0) return buffer;
  const text = buffer.toString("utf8");
  const trailing_line_break = text.endsWith("\r\n")
    ? 2
    : text.endsWith("\n") || text.endsWith("\r")
      ? 1
      : 0;
  if (require_line_break) {
    return trailing_line_break > 0
      ? buffer
      : Buffer.concat([buffer, Buffer.from(line_break, "utf8")]);
  }
  return trailing_line_break > 0
    ? buffer.subarray(0, buffer.length - trailing_line_break)
    : buffer;
}

function join_item_buffers(
  records,
  indent,
  line_break,
  ends_with_line_break = true,
) {
  if (!Array.isArray(records) || records.length === 0) return Buffer.alloc(0);
  const pieces = [];
  records.forEach((record, index) => {
    if (index > 0) pieces.push(Buffer.from(indent, "utf8"));
    pieces.push(
      normalize_item_buffer(
        record.buffer || record,
        line_break,
        index < records.length - 1 || ends_with_line_break,
      ),
    );
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
