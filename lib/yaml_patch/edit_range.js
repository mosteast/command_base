"use strict";

const YAML = require("yaml");

const { Yaml_patch_error } = require("./error");
const { get_index_node } = require("./node_index");
const { sha256_digest, utf16_offset_to_byte } = require("./source");

const SUPPORTED_EDIT_UNITS = new Set([
  "scalar-token",
  "node-value",
  "mapping-value",
]);
const SUPPORTED_SCALAR_TOKENS = new Set([
  "scalar",
  "single-quoted-scalar",
  "double-quoted-scalar",
]);

function unsupported_shape(message, entry, details = {}) {
  throw new Yaml_patch_error("UNSUPPORTED_EDIT_SHAPE", message, {
    details: { locator: entry.locator, node_type: entry.node_type, ...details },
    next_action: "select a supported non-empty node or a larger ancestor",
  });
}

function collect_cst_source_spans(value, spans = [], visited = new WeakSet()) {
  if (!value || typeof value !== "object") return spans;
  if (visited.has(value)) return spans;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collect_cst_source_spans(item, spans, visited);
    return spans;
  }

  if (value.type === "block-scalar") {
    collect_cst_source_spans(value.props || [], spans, visited);
    const property_end = (value.props || []).reduce(
      (end, token) => Math.max(end, token.offset + (token.source || "").length),
      value.offset,
    );
    spans.push({
      start: property_end,
      end: property_end + (value.source || "").length,
      source: value.source || "",
      type: "block-scalar-source",
    });
    return spans;
  }

  if (Number.isInteger(value.offset) && typeof value.source === "string") {
    spans.push({
      start: value.offset,
      end: value.offset + value.source.length,
      source: value.source,
      type: value.type,
    });
  }
  for (const [field, child] of Object.entries(value)) {
    if (["offset", "source", "type", "indent"].includes(field)) continue;
    collect_cst_source_spans(child, spans, visited);
  }
  return spans;
}

function validate_recursive_cst_span(index, node, entry) {
  const [start_character, end_character] = node.range;
  const spans = collect_cst_source_spans(node.srcToken)
    .filter((span) => span.end > start_character && span.start < end_character)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let cursor = start_character;
  for (const span of spans) {
    if (
      span.start > cursor ||
      span.end > end_character ||
      index.source.text.slice(span.start, span.end) !== span.source
    ) {
      unsupported_shape("Recursive CST span does not match source", entry, {
        range: node.range,
        token_type: span.type,
        token_start: span.start,
        token_end: span.end,
      });
    }
    cursor = Math.max(cursor, span.end);
  }
  if (cursor !== end_character) {
    unsupported_shape("Recursive CST span does not cover Node.range", entry, {
      range: node.range,
      covered_end: cursor,
    });
  }

  if (node.srcToken.type === "flow-collection") {
    const expected_closing_type = YAML.isMap(node)
      ? "flow-map-end"
      : "flow-seq-end";
    const closing_token = (node.srcToken.end || []).find(
      (token) => token.type === expected_closing_type,
    );
    if (
      !closing_token ||
      closing_token.offset + (closing_token.source || "").length !==
        end_character
    ) {
      unsupported_shape("Flow collection closing token is inconsistent", entry);
    }
  }
}

function validate_node_value_shape(index, node, entry) {
  if (!Array.isArray(node.range) || node.range.length < 2 || !node.srcToken) {
    unsupported_shape("Node has no verified source range or CST token", entry);
  }
  const [start_character, end_character] = node.range;
  if (
    !Number.isInteger(start_character) ||
    !Number.isInteger(end_character) ||
    start_character >= end_character ||
    node.srcToken.offset !== start_character
  ) {
    unsupported_shape("Node source range is empty or inconsistent", entry, {
      range: node.range,
      token_offset: node.srcToken.offset,
    });
  }

  if (YAML.isScalar(node)) {
    if (node.srcToken.type === "block-scalar") {
      const property_size = (node.srcToken.props || []).reduce(
        (size, token) => size + (token.source || "").length,
        0,
      );
      const source_size = (node.srcToken.source || "").length;
      if (start_character + property_size + source_size !== end_character) {
        unsupported_shape(
          "Block scalar token span does not match Node.range",
          entry,
        );
      }
    } else if (
      typeof node.srcToken.source !== "string" ||
      node.srcToken.offset + node.srcToken.source.length !== end_character
    ) {
      unsupported_shape("Scalar token span does not match Node.range", entry);
    }
    validate_recursive_cst_span(index, node, entry);
    return;
  }

  if (YAML.isMap(node)) {
    if (!["block-map", "flow-collection"].includes(node.srcToken.type)) {
      unsupported_shape("Mapping CST token shape is not supported", entry);
    }
    validate_recursive_cst_span(index, node, entry);
    return;
  }
  if (YAML.isSeq(node)) {
    if (!["block-seq", "flow-collection"].includes(node.srcToken.type)) {
      unsupported_shape("Sequence CST token shape is not supported", entry);
    }
    validate_recursive_cst_span(index, node, entry);
    return;
  }

  unsupported_shape(
    "Only scalar, mapping, and sequence values are writable",
    entry,
  );
}

function build_edit_range(
  index,
  entry,
  edit_unit,
  start_character,
  end_character,
) {
  const start_byte = utf16_offset_to_byte(index.source, start_character);
  const end_byte = utf16_offset_to_byte(index.source, end_character);
  const raw_buffer = index.source.buffer.subarray(start_byte, end_byte);
  return {
    edit_unit,
    document: entry.document,
    locator: entry.locator,
    node_type: entry.node_type,
    start_character,
    end_character,
    start_byte,
    end_byte,
    raw_digest: sha256_digest(raw_buffer),
    size_bytes: raw_buffer.length,
  };
}

function resolve_edit_range(index, entry, edit_unit) {
  if (!SUPPORTED_EDIT_UNITS.has(edit_unit)) {
    throw new Yaml_patch_error(
      "UNSUPPORTED_EDIT_UNIT",
      `Unsupported first-version edit unit: ${edit_unit}`,
      {
        details: {
          edit_unit,
          supported_edit_units: Array.from(SUPPORTED_EDIT_UNITS),
        },
      },
    );
  }
  const node = get_index_node(index, entry);
  if (!node) unsupported_shape("Indexed node is unavailable", entry);

  if (edit_unit === "scalar-token") {
    if (
      !YAML.isScalar(node) ||
      !node.srcToken ||
      !SUPPORTED_SCALAR_TOKENS.has(node.srcToken.type) ||
      typeof node.srcToken.source !== "string"
    ) {
      unsupported_shape(
        "scalar-token supports only plain, single-quoted, and double-quoted scalars",
        entry,
      );
    }
    const start_character = node.srcToken.offset;
    const end_character = start_character + node.srcToken.source.length;
    if (
      !node.range ||
      node.range[0] !== start_character ||
      node.range[1] !== end_character ||
      index.source.text.slice(start_character, end_character) !==
        node.srcToken.source
    ) {
      unsupported_shape("Scalar token span does not match Node.range", entry);
    }
    return build_edit_range(
      index,
      entry,
      edit_unit,
      start_character,
      end_character,
    );
  }

  if (edit_unit === "mapping-value" && entry.relationship !== "mapping_value") {
    unsupported_shape("mapping-value requires a selected mapping value", entry);
  }
  validate_node_value_shape(index, node, entry);
  return build_edit_range(
    index,
    entry,
    edit_unit,
    node.range[0],
    node.range[1],
  );
}

module.exports = {
  SUPPORTED_EDIT_UNITS,
  collect_cst_source_spans,
  resolve_edit_range,
  validate_recursive_cst_span,
  validate_node_value_shape,
};
