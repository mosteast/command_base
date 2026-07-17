"use strict";

const { types } = require("node:util");

const { Yaml_patch_error } = require("./error");

function assert_object(
  value,
  label = "value",
  error_code = "VALIDATION_FAILED",
) {
  if (value !== null && typeof value === "object" && types.isProxy(value)) {
    throw new Yaml_patch_error(error_code, `${label} must not be a Proxy`, {
      details: { label },
    });
  }
  const prototype =
    value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    throw new Yaml_patch_error(error_code, `${label} must be a plain object`, {
      details: { label },
    });
  }
  return value;
}

function normalize_known_fields(fields, label, error_code) {
  const normalized_fields = fields instanceof Set ? Array.from(fields) : fields;
  if (
    !Array.isArray(normalized_fields) ||
    normalized_fields.some((field) => typeof field !== "string")
  ) {
    throw new Yaml_patch_error(
      error_code,
      `${label} known fields must be an array or Set of strings`,
      { details: { label } },
    );
  }
  return new Set(normalized_fields);
}

function assert_known_fields(
  value,
  fields,
  label = "value",
  error_code = "VALIDATION_FAILED",
) {
  assert_object(value, label, error_code);
  const known_fields = normalize_known_fields(fields, label, error_code);
  const own_fields = Reflect.ownKeys(value)
    .map((field) => ({
      field,
      field_label: typeof field === "symbol" ? String(field) : field,
      descriptor: Object.getOwnPropertyDescriptor(value, field),
    }))
    .sort((left, right) =>
      left.field_label < right.field_label
        ? -1
        : left.field_label > right.field_label
          ? 1
          : 0,
    );
  for (const { field, field_label, descriptor } of own_fields) {
    if (typeof field === "symbol") {
      throw new Yaml_patch_error(
        error_code,
        `${label} cannot contain symbol fields`,
        {
          details: { label, field: field_label, field_type: "symbol" },
          next_action: `remove the symbol field from ${label}`,
        },
      );
    }
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new Yaml_patch_error(
        error_code,
        `${label} field must not be an accessor: ${field}`,
        {
          details: { label, field, field_type: "accessor" },
          next_action: `replace the ${label} accessor with JSON data`,
        },
      );
    }
  }
  const unknown_fields = own_fields
    .map(({ field }) => field)
    .filter((field) => !known_fields.has(field));
  if (unknown_fields.length > 0) {
    throw new Yaml_patch_error(
      error_code,
      `Unknown ${label} field: ${unknown_fields[0]}`,
      {
        details: { label, field: unknown_fields[0] },
        next_action: `remove the unknown ${label} field`,
      },
    );
  }
  return value;
}

function assert_non_empty_string(
  value,
  label,
  error_code = "VALIDATION_FAILED",
) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Yaml_patch_error(
      error_code,
      `${label} must be a non-empty string`,
      { details: { label, value_type: typeof value } },
    );
  }
  return value;
}

function assert_sha256_digest(value, label, error_code = "VALIDATION_FAILED") {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Yaml_patch_error(
      error_code,
      `${label} must be a lowercase SHA-256 digest`,
      { details: { label, value_type: typeof value } },
    );
  }
  return value;
}

function assert_non_negative_integer(
  value,
  label,
  error_code = "VALIDATION_FAILED",
) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Yaml_patch_error(
      error_code,
      `${label} must be a non-negative finite integer`,
      { details: { label, value } },
    );
  }
  return value;
}

module.exports = {
  assert_known_fields,
  assert_non_empty_string,
  assert_non_negative_integer,
  assert_object,
  assert_sha256_digest,
};
