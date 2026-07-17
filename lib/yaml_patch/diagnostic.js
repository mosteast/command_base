"use strict";

const { clone_json_value } = require("./artifact_version");
const { Yaml_patch_error } = require("./error");
const { assert_known_fields, assert_object } = require("./schema");

const DIAGNOSTIC_FIELDS = Object.freeze([
  "code",
  "severity",
  "rule_id",
  "file",
  "document",
  "line",
  "column",
  "path",
  "violation",
  "suggested_action",
  "projection",
]);
const REQUIRED_DIAGNOSTIC_FIELDS = DIAGNOSTIC_FIELDS.filter(
  (field) => field !== "projection",
);
const DIAGNOSTIC_SEVERITIES = Object.freeze(["error", "warning", "info"]);
const DIAGNOSTIC_SEVERITY_SET = new Set(DIAGNOSTIC_SEVERITIES);

function diagnostic_validation_error(message, details = {}) {
  return new Yaml_patch_error("VALIDATION_FAILED", message, {
    details,
    next_action: "provide a complete diagnostic with valid core fields",
  });
}

function assert_non_empty_string(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw diagnostic_validation_error(
      `Diagnostic ${field} must be a non-empty string`,
      { field },
    );
  }
}

function assert_position(value, field, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    throw diagnostic_validation_error(
      `Diagnostic ${field} must be an integer of at least ${minimum}`,
      { field, value },
    );
  }
}

function create_diagnostic(input) {
  assert_known_fields(input, DIAGNOSTIC_FIELDS, "diagnostic");
  const missing_fields = REQUIRED_DIAGNOSTIC_FIELDS.filter(
    (field) => !Object.hasOwn(input, field),
  );
  if (missing_fields.length > 0) {
    throw diagnostic_validation_error(
      `Diagnostic is missing required field: ${missing_fields[0]}`,
      { field: missing_fields[0] },
    );
  }

  for (const field of [
    "code",
    "rule_id",
    "file",
    "violation",
    "suggested_action",
  ]) {
    assert_non_empty_string(input[field], field);
  }
  if (!DIAGNOSTIC_SEVERITY_SET.has(input.severity)) {
    throw diagnostic_validation_error(
      "Diagnostic severity must be error, warning, or info",
      { field: "severity", value: input.severity },
    );
  }
  assert_position(input.document, "document", 0);
  assert_position(input.line, "line", 1);
  assert_position(input.column, "column", 1);
  if (!Array.isArray(input.path)) {
    throw diagnostic_validation_error("Diagnostic path must be an array", {
      field: "path",
    });
  }
  if (Object.hasOwn(input, "projection")) {
    assert_object(input.projection, "diagnostic projection");
  }

  const path = clone_json_value(input.path, "diagnostic path");
  const projection = Object.hasOwn(input, "projection")
    ? clone_json_value(input.projection, "diagnostic projection")
    : undefined;

  return {
    code: input.code,
    severity: input.severity,
    rule_id: input.rule_id,
    file: input.file,
    document: input.document,
    line: input.line,
    column: input.column,
    path,
    violation: input.violation,
    suggested_action: input.suggested_action,
    ...(projection === undefined ? {} : { projection }),
  };
}

module.exports = {
  DIAGNOSTIC_FIELDS,
  DIAGNOSTIC_SEVERITIES,
  create_diagnostic,
};
