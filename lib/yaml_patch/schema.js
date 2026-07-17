"use strict";

const { Yaml_patch_error } = require("./error");

function assert_object(value, label = "value") {
  const prototype =
    value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    throw new Yaml_patch_error(
      "VALIDATION_FAILED",
      `${label} must be a plain object`,
      { details: { label } },
    );
  }
  return value;
}

function normalize_known_fields(fields, label) {
  const normalized_fields = fields instanceof Set ? Array.from(fields) : fields;
  if (
    !Array.isArray(normalized_fields) ||
    normalized_fields.some((field) => typeof field !== "string")
  ) {
    throw new Yaml_patch_error(
      "VALIDATION_FAILED",
      `${label} known fields must be an array or Set of strings`,
      { details: { label } },
    );
  }
  return new Set(normalized_fields);
}

function assert_known_fields(value, fields, label = "value") {
  assert_object(value, label);
  const known_fields = normalize_known_fields(fields, label);
  const unknown_fields = Object.keys(value)
    .filter((field) => !known_fields.has(field))
    .sort();
  if (unknown_fields.length > 0) {
    throw new Yaml_patch_error(
      "VALIDATION_FAILED",
      `Unknown ${label} field: ${unknown_fields[0]}`,
      {
        details: { label, field: unknown_fields[0] },
        next_action: `remove the unknown ${label} field`,
      },
    );
  }
  return value;
}

module.exports = {
  assert_known_fields,
  assert_object,
};
