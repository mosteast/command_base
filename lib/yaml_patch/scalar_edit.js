"use strict";

const YAML = require("yaml");

const { Yaml_patch_error, request_error } = require("./error");
const { get_index_node } = require("./node_index");
const { parse_yaml_source } = require("./parser");
const { typed_scalar_metadata } = require("./scalar_metadata");
const { create_source_record } = require("./source");
const { typed_values_equal, validate_typed_value } = require("./typed_value");

function unsupported_shape(message, target, details = {}) {
  throw new Yaml_patch_error("UNSUPPORTED_EDIT_SHAPE", message, {
    details: { locator: target && target.locator, ...details },
    next_action:
      "select a scalar with a provable source token or allow a new style",
  });
}

function assert_operation(operation, expected_type) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    request_error("Scalar operation must be an object");
  }
  if (typeof operation.id !== "string" || operation.id.length === 0) {
    request_error("Scalar operation id must be a non-empty string");
  }
  if (operation.type !== expected_type) {
    request_error(`Expected ${expected_type} scalar operation`);
  }
}

function scalar_raw_range(context, target) {
  if (!context || !context.index)
    request_error("Scalar edit context requires index");
  const node = get_index_node(context.index, target);
  if (
    !node ||
    !YAML.isScalar(node) ||
    !node.srcToken ||
    !Array.isArray(node.range)
  ) {
    unsupported_shape("Scalar target has no verified CST token", target);
  }
  const [start_character, end_character] = node.range;
  if (
    !Number.isInteger(start_character) ||
    !Number.isInteger(end_character) ||
    start_character >= end_character ||
    node.srcToken.offset !== start_character
  ) {
    unsupported_shape("Scalar CST range is inconsistent", target);
  }
  const source_text = context.index.source.text.slice(
    start_character,
    end_character,
  );
  if (node.srcToken.type === "block-scalar") {
    const property_text = (node.srcToken.props || [])
      .map((token) => token.source || "")
      .join("");
    if (source_text !== property_text + (node.srcToken.source || "")) {
      unsupported_shape("Block scalar CST bytes are inconsistent", target);
    }
  } else if (
    typeof node.srcToken.source !== "string" ||
    source_text !== node.srcToken.source
  ) {
    unsupported_shape("Scalar CST bytes are inconsistent", target);
  }
  return {
    node,
    start_byte: target.source.start_byte,
    end_byte: target.source.end_byte,
    raw: context.index.source.buffer
      .subarray(target.source.start_byte, target.source.end_byte)
      .toString("utf8"),
  };
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

function normalize_serialized_scalar(value) {
  return YAML.stringify(typed_value_to_javascript(value)).replace(/\n$/, "");
}

function scalar_token_type(raw) {
  const document = YAML.parseDocument(`value: ${raw}\n`, {
    keepSourceTokens: true,
    prettyErrors: false,
    strict: true,
  });
  const node = document.contents && document.contents.items[0].value;
  return node && node.srcToken && node.srcToken.type;
}

function line_break_for(source) {
  return source.line_break_mode === "crlf" ? "\r\n" : "\n";
}

function block_indent(node) {
  const source = node.srcToken.source || "";
  const first_content_line = source
    .split(/\r?\n/)
    .find((line) => /\S/.test(line));
  if (first_content_line) {
    const indent = first_content_line.match(/^ */)[0];
    if (indent.length > 0) return indent;
  }
  return " ".repeat((node.srcToken.indent || 0) + 2);
}

function block_header(node) {
  const header_token = (node.srcToken.props || []).find(
    (token) => token.type === "block-scalar-header",
  );
  if (!header_token || typeof header_token.source !== "string") return null;
  return header_token.source;
}

function append_indented_lines(value, indent, line_break, folded) {
  const logical_lines = value.split("\n");
  return logical_lines
    .map((line, index) => {
      if (line.length === 0) return "";
      return `${indent}${line}`;
    })
    .join(folded ? `${line_break}${line_break}` : line_break);
}

function render_block_scalar(context, node, typed_value) {
  if (typed_value.type !== "string") return null;
  const header = block_header(node);
  if (!header || !["|", ">"].includes(header[0])) return null;
  const value = typed_value.value;
  if (value.includes("\r")) return null;
  const strip = header.includes("-");
  const keep = header.includes("+");
  const line_break = line_break_for(context.index.source);
  const indent = block_indent(node);
  let content = value;

  if (strip) {
    if (value.endsWith("\n")) return null;
  } else if (keep) {
    if (!value.endsWith("\n")) return null;
    const body = append_indented_lines(
      value.endsWith("\n") ? value.slice(0, -1) : value,
      indent,
      line_break,
      header[0] === ">",
    );
    return `${header}${line_break}${body}${line_break}`;
  } else {
    if (!value.endsWith("\n") || value.endsWith("\n\n")) return null;
    content = value.slice(0, -1);
  }

  const body = append_indented_lines(
    content,
    indent,
    line_break,
    header[0] === ">",
  );
  return `${header}${line_break}${body}${line_break}`;
}

function render_style(context, target, node, typed_value, style) {
  const existing_style =
    node.srcToken.type === "single-quoted-scalar"
      ? "single"
      : node.srcToken.type === "double-quoted-scalar"
        ? "double"
        : node.srcToken.type === "block-scalar"
          ? node.srcToken.props[0] && node.srcToken.props[0].source[0] === ">"
            ? "folded"
            : "literal"
          : node.srcToken.type === "scalar"
            ? "plain"
            : null;
  const requested_style = style || existing_style;
  if (!requested_style) {
    unsupported_shape("Scalar style is not supported", target);
  }
  if (requested_style === "plain") {
    const raw = normalize_serialized_scalar(typed_value);
    return scalar_token_type(raw) === "scalar" ? raw : null;
  }
  if (requested_style === "single") {
    return typed_value.type === "string" && !typed_value.value.includes("\n")
      ? `'${typed_value.value.replaceAll("'", "''")}'`
      : null;
  }
  if (requested_style === "double") {
    return typed_value.type === "string"
      ? JSON.stringify(typed_value.value)
      : null;
  }
  if (requested_style === "literal" || requested_style === "folded") {
    if (style && existing_style !== requested_style) {
      const line_break = line_break_for(context.index.source);
      const header = requested_style === "literal" ? "|" : ">";
      const temporary_node = {
        srcToken: {
          type: "block-scalar",
          indent: node.srcToken.indent,
          source: node.srcToken.source,
          props: [{ type: "block-scalar-header", source: header }],
        },
      };
      return render_block_scalar(context, temporary_node, typed_value);
    }
    return render_block_scalar(context, node, typed_value);
  }
  request_error(`Unsupported scalar style: ${requested_style}`);
}

function parse_candidate(context, target, replacement, expected_typed_value) {
  const source = context.index.source;
  const candidate_buffer = Buffer.concat([
    source.buffer.subarray(0, target.source.start_byte),
    Buffer.from(replacement, "utf8"),
    source.buffer.subarray(target.source.end_byte),
  ]);
  const candidate_source = create_source_record(candidate_buffer, {
    file_path: source.file_path,
  });
  const parsed = parse_yaml_source(candidate_source);
  if (parsed.errors.length > 0) {
    throw new Yaml_patch_error(
      "YAML_DIAGNOSTIC",
      "Scalar replacement makes the YAML candidate invalid",
      { details: { diagnostics: parsed.errors } },
    );
  }
  const candidate_index = require("./node_index").build_node_index(
    candidate_source,
    parsed,
  );
  const candidate_target = candidate_index.entries.find(
    (entry) =>
      entry.document === target.document &&
      JSON.stringify(entry.path) === JSON.stringify(target.path),
  );
  const candidate_node =
    candidate_target && get_index_node(candidate_index, candidate_target);
  if (!candidate_target || !candidate_node || !YAML.isScalar(candidate_node)) {
    unsupported_shape("Scalar replacement does not remain a scalar", target);
  }
  if (expected_typed_value === undefined) return;
  const actual = typed_scalar_metadata(candidate_node, candidate_target.raw);
  const actual_typed_value =
    actual.scalar_type === undefined
      ? null
      : {
          type: actual.scalar_type,
          value: actual.scalar_value,
          ...(actual.scalar_value_encoding === undefined
            ? {}
            : { value_encoding: actual.scalar_value_encoding }),
        };
  if (!typed_values_equal(actual_typed_value, expected_typed_value)) {
    unsupported_shape(
      "Requested value cannot be represented in this scalar style",
      target,
      {
        requested_style: expected_typed_value,
        actual_style_value: actual_typed_value,
      },
    );
  }
}

function compile_raw(context, target, operation) {
  assert_operation(operation, "replace_scalar_raw");
  if (typeof operation.raw !== "string") {
    request_error("replace_scalar_raw requires raw YAML source");
  }
  const range = scalar_raw_range(context, target);
  if (operation.raw === range.raw) {
    return {
      splices: [],
      result_range: null,
      provenance: { operation_id: operation.id, type: operation.type },
      semantic_change: { no_op: true, mode: "raw" },
    };
  }
  parse_candidate(context, target, operation.raw);
  return {
    splices: [
      {
        start_byte: range.start_byte,
        end_byte: range.end_byte,
        replacement_buffer: Buffer.from(operation.raw, "utf8"),
        operation_id: operation.id,
      },
    ],
    result_range: {
      start_byte: range.start_byte,
      end_byte: range.start_byte + Buffer.byteLength(operation.raw, "utf8"),
    },
    provenance: { operation_id: operation.id, type: operation.type },
    semantic_change: { no_op: false, mode: "raw" },
  };
}

function compile_typed(context, target, operation) {
  assert_operation(operation, "set_scalar_value");
  validate_typed_value(operation.value, "scalar operation value");
  const range = scalar_raw_range(context, target);
  const metadata = typed_scalar_metadata(range.node, range.raw);
  const current_value =
    metadata.scalar_type === undefined
      ? null
      : {
          type: metadata.scalar_type,
          value: metadata.scalar_value,
          ...(metadata.scalar_value_encoding === undefined
            ? {}
            : { value_encoding: metadata.scalar_value_encoding }),
        };
  if (!operation.style && typed_values_equal(current_value, operation.value)) {
    return {
      splices: [],
      result_range: null,
      provenance: { operation_id: operation.id, type: operation.type },
      semantic_change: { no_op: true, mode: "typed", before: current_value },
    };
  }
  const replacement = render_style(
    context,
    target,
    range.node,
    operation.value,
    operation.style,
  );
  if (replacement === null) {
    unsupported_shape(
      "Requested value cannot be represented in the old scalar style",
      target,
    );
  }
  if (replacement === range.raw) {
    return {
      splices: [],
      result_range: null,
      provenance: { operation_id: operation.id, type: operation.type },
      semantic_change: { no_op: true, mode: "typed", before: current_value },
    };
  }
  parse_candidate(context, target, replacement, operation.value);
  return {
    splices: [
      {
        start_byte: range.start_byte,
        end_byte: range.end_byte,
        replacement_buffer: Buffer.from(replacement, "utf8"),
        operation_id: operation.id,
      },
    ],
    result_range: {
      start_byte: range.start_byte,
      end_byte: range.start_byte + Buffer.byteLength(replacement, "utf8"),
    },
    provenance: { operation_id: operation.id, type: operation.type },
    semantic_change: {
      no_op: false,
      mode: "typed",
      before: current_value,
      after: operation.value,
    },
  };
}

function compile_operation(context, target, operation) {
  if (!operation || typeof operation !== "object") {
    request_error("Scalar operation must be an object");
  }
  if (operation.type === "replace_scalar_raw") {
    return compile_raw(context, target, operation);
  }
  if (operation.type === "set_scalar_value") {
    return compile_typed(context, target, operation);
  }
  request_error(`Unsupported scalar operation: ${operation.type}`);
}

module.exports = {
  compile_operation,
  render_block_scalar,
  render_style,
  scalar_raw_range,
};
