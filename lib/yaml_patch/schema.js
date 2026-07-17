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
        "VALIDATION_FAILED",
        `${label} cannot contain symbol fields`,
        {
          details: { label, field: field_label, field_type: "symbol" },
          next_action: `remove the symbol field from ${label}`,
        },
      );
    }
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new Yaml_patch_error(
        "VALIDATION_FAILED",
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
