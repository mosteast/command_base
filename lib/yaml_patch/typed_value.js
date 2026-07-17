"use strict";

const { Yaml_patch_error } = require("./error");

const TYPED_VALUE_TYPES = new Set([
  "string",
  "integer",
  "float",
  "boolean",
  "null",
]);
const NON_FINITE_VALUES = new Set([
  "nan",
  "negative_infinity",
  "positive_infinity",
]);

function request_error(message, details = {}) {
  throw new Yaml_patch_error("REQUEST_ERROR", message, { details });
}

function assert_plain_fields(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    request_error(`${label} must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      request_error(`Unknown ${label} field: ${field}`, { field });
    }
  }
}

function validate_typed_value(value, label = "typed value") {
  assert_plain_fields(
    value,
    new Set(["type", "value", "value_encoding"]),
    label,
  );
  if (!Object.hasOwn(value, "type") || !Object.hasOwn(value, "value")) {
    request_error(`${label} requires type and value`);
  }
  if (!TYPED_VALUE_TYPES.has(value.type)) {
    request_error(`${label} has unsupported type: ${value.type}`);
  }
  const has_encoding = Object.hasOwn(value, "value_encoding");
  if (value.type === "string" && typeof value.value !== "string") {
    request_error(`${label} string value must be a string`);
  }
  if (value.type === "boolean" && typeof value.value !== "boolean") {
    request_error(`${label} boolean value must be a boolean`);
  }
  if (value.type === "null" && value.value !== null) {
    request_error(`${label} null value must be null`);
  }
  if (["string", "boolean", "null"].includes(value.type) && has_encoding) {
    request_error(`${label} ${value.type} must not use value_encoding`);
  }
  if (value.type === "integer") {
    const encoded =
      value.value_encoding === "decimal_string" &&
      typeof value.value === "string" &&
      /^-?(?:0|[1-9][0-9]*)$/.test(value.value);
    const direct = !has_encoding && Number.isSafeInteger(value.value);
    if (!encoded && !direct) {
      request_error(
        `${label} integer must be a safe integer or decimal_string`,
      );
    }
    if (encoded && BigInt(value.value).toString(10) !== value.value) {
      request_error(`${label} decimal_string must be canonical`);
    }
  }
  if (value.type === "float") {
    const encoded =
      value.value_encoding === "non_finite" &&
      typeof value.value === "string" &&
      NON_FINITE_VALUES.has(value.value);
    const direct = !has_encoding && Number.isFinite(value.value);
    if (!encoded && !direct) {
      request_error(`${label} float must be finite or use non_finite encoding`);
    }
  }
  return value;
}

function entry_typed_value(entry) {
  if (
    !entry ||
    !TYPED_VALUE_TYPES.has(entry.scalar_type) ||
    !Object.hasOwn(entry, "scalar_value")
  ) {
    return null;
  }
  return {
    type: entry.scalar_type,
    value: entry.scalar_value,
    ...(entry.scalar_value_encoding === undefined
      ? {}
      : { value_encoding: entry.scalar_value_encoding }),
  };
}

function typed_values_equal(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.type === right.type &&
    left.value === right.value &&
    left.value_encoding === right.value_encoding
  );
}

function typed_entry_equals(entry, expected) {
  return typed_values_equal(entry_typed_value(entry), expected);
}

function validate_range(range, label = "numeric range") {
  assert_plain_fields(
    range,
    new Set(["min", "max", "include_min", "include_max"]),
    label,
  );
  if (!Object.hasOwn(range, "min") && !Object.hasOwn(range, "max")) {
    request_error(`${label} requires min or max`);
  }
  for (const field of ["min", "max"]) {
    if (Object.hasOwn(range, field) && !Number.isFinite(range[field])) {
      request_error(`${label} ${field} must be finite`);
    }
  }
  for (const field of ["include_min", "include_max"]) {
    if (Object.hasOwn(range, field) && typeof range[field] !== "boolean") {
      request_error(`${label} ${field} must be boolean`);
    }
  }
  if (
    Object.hasOwn(range, "min") &&
    Object.hasOwn(range, "max") &&
    range.min > range.max
  ) {
    request_error(`${label} min must not exceed max`);
  }
  return range;
}

function validate_comparison(comparison, label = "comparison", options = {}) {
  const validate_value = (value, value_label) => {
    if (typeof options.before_typed_value === "function") {
      options.before_typed_value(value, value_label);
    }
    return validate_typed_value(value, value_label);
  };
  assert_plain_fields(
    comparison,
    new Set([
      "equals",
      "not_equals",
      "in",
      "eq",
      "ne",
      "lt",
      "lte",
      "gt",
      "gte",
      "range",
    ]),
    label,
  );
  const keys = Object.keys(comparison);
  if (keys.length !== 1) request_error(`${label} requires exactly one form`);
  const kind = keys[0];
  if (kind === "equals" || kind === "not_equals") {
    validate_value(comparison[kind], `${label}.${kind}`);
  } else if (kind === "in") {
    if (!Array.isArray(comparison.in) || comparison.in.length === 0) {
      request_error(`${label}.in must be a non-empty array`);
    }
    comparison.in.forEach((value, index) => {
      validate_value(value, `${label}.in[${index}]`);
    });
  } else if (kind === "range") {
    validate_range(comparison.range, `${label}.range`);
  } else if (!Number.isFinite(comparison[kind])) {
    request_error(`${label}.${kind} must be finite`);
  }
  return comparison;
}

function numeric_entry_value(entry) {
  if (!entry || !["integer", "float"].includes(entry.scalar_type)) return null;
  if (entry.scalar_value_encoding === "decimal_string") {
    return { kind: "bigint", value: BigInt(entry.scalar_value) };
  }
  if (
    entry.scalar_value_encoding === undefined &&
    Number.isFinite(entry.scalar_value)
  ) {
    return { kind: "number", value: entry.scalar_value };
  }
  return null;
}

function compare_numeric_value(value, expected) {
  if (value.kind === "number") {
    return value.value === expected ? 0 : value.value < expected ? -1 : 1;
  }
  if (Number.isInteger(expected)) {
    const expected_bigint = BigInt(expected);
    return value.value === expected_bigint
      ? 0
      : value.value < expected_bigint
        ? -1
        : 1;
  }
  const floor = BigInt(Math.floor(expected));
  return value.value <= floor ? -1 : 1;
}

function number_in_range(value, range) {
  if (!value) return false;
  if (Object.hasOwn(range, "min")) {
    const comparison = compare_numeric_value(value, range.min);
    if (comparison < 0 || (comparison === 0 && range.include_min === false)) {
      return false;
    }
  }
  if (Object.hasOwn(range, "max")) {
    const comparison = compare_numeric_value(value, range.max);
    if (comparison > 0 || (comparison === 0 && range.include_max === false)) {
      return false;
    }
  }
  return true;
}

function evaluate_comparison(entry, comparison) {
  const kind = Object.keys(comparison)[0];
  if (kind === "equals") return typed_entry_equals(entry, comparison.equals);
  if (kind === "not_equals") {
    return !typed_entry_equals(entry, comparison.not_equals);
  }
  if (kind === "in") {
    return comparison.in.some((value) => typed_entry_equals(entry, value));
  }
  const numeric_value = numeric_entry_value(entry);
  if (!numeric_value) return false;
  if (kind === "range") return number_in_range(numeric_value, comparison.range);
  const result = compare_numeric_value(numeric_value, comparison[kind]);
  return {
    eq: result === 0,
    ne: result !== 0,
    lt: result < 0,
    lte: result <= 0,
    gt: result > 0,
    gte: result >= 0,
  }[kind];
}

module.exports = {
  entry_typed_value,
  evaluate_comparison,
  number_in_range,
  numeric_entry_value,
  typed_entry_equals,
  typed_values_equal,
  validate_comparison,
  validate_range,
  validate_typed_value,
};
