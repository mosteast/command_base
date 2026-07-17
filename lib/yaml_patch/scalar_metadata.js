"use strict";

const YAML = require("yaml");

const STANDARD_SCALAR_TAG_TYPE = Object.freeze({
  "tag:yaml.org,2002:bool": "boolean",
  "tag:yaml.org,2002:float": "float",
  "tag:yaml.org,2002:int": "integer",
  "tag:yaml.org,2002:null": "null",
  "tag:yaml.org,2002:str": "string",
});

function standard_tag_type(node) {
  if (!node.tag) return null;
  const scalar_type = STANDARD_SCALAR_TAG_TYPE[node.tag];
  const resolved_type_matches =
    (scalar_type === "string" && typeof node.value === "string") ||
    (scalar_type === "integer" &&
      ((typeof node.value === "number" && Number.isInteger(node.value)) ||
        typeof node.value === "bigint")) ||
    (scalar_type === "float" && typeof node.value === "number") ||
    (scalar_type === "boolean" && typeof node.value === "boolean") ||
    (scalar_type === "null" && node.value === null);
  return resolved_type_matches ? scalar_type : null;
}

function implicit_scalar_type(node, raw) {
  if (node.value === null) return "null";
  if (typeof node.value === "string") return "string";
  if (typeof node.value === "boolean") return "boolean";
  if (typeof node.value === "bigint") return "integer";
  if (typeof node.value !== "number") return null;
  const float_syntax =
    node.format === "EXP" ||
    Number.isInteger(node.minFractionDigits) ||
    !Number.isInteger(node.value) ||
    /^(?:[-+]?\.(?:inf|nan))$/i.test(String(raw));
  return float_syntax ? "float" : "integer";
}

function exact_integer_decimal(raw, format) {
  const source = String(raw);
  const syntax_matches =
    (format === "HEX" && /^0x[0-9a-fA-F]+$/.test(source)) ||
    (format === "OCT" && /^0o[0-7]+$/.test(source)) ||
    ((!format || format === "DEC") && /^[-+]?[0-9]+$/.test(source));
  if (!syntax_matches) return null;
  try {
    return BigInt(source).toString(10);
  } catch {
    return null;
  }
}

function integer_metadata(node, raw) {
  if (typeof node.value === "bigint") {
    return {
      scalar_type: "integer",
      scalar_value: node.value.toString(10),
      scalar_value_encoding: "decimal_string",
    };
  }
  if (Number.isSafeInteger(node.value)) {
    return { scalar_type: "integer", scalar_value: node.value };
  }
  const exact_value = exact_integer_decimal(raw, node.format);
  if (exact_value === null) return {};
  return {
    scalar_type: "integer",
    scalar_value: exact_value,
    scalar_value_encoding: "decimal_string",
  };
}

function float_metadata(value) {
  if (Number.isFinite(value)) {
    return { scalar_type: "float", scalar_value: value };
  }
  const scalar_value = Number.isNaN(value)
    ? "nan"
    : value < 0
      ? "negative_infinity"
      : "positive_infinity";
  return {
    scalar_type: "float",
    scalar_value,
    scalar_value_encoding: "non_finite",
  };
}

function typed_scalar_metadata(node, raw) {
  if (!YAML.isScalar(node)) return {};
  const scalar_type = node.tag
    ? standard_tag_type(node)
    : implicit_scalar_type(node, raw);
  if (!scalar_type) return {};
  if (scalar_type === "integer") return integer_metadata(node, raw);
  if (scalar_type === "float") return float_metadata(node.value);
  return { scalar_type, scalar_value: node.value };
}

module.exports = {
  STANDARD_SCALAR_TAG_TYPE,
  exact_integer_decimal,
  typed_scalar_metadata,
};
