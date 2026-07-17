"use strict";

const { clone_json_value } = require("./artifact_version");
const { Yaml_patch_error } = require("./error");

const PROJECTION_FIELDS = new Set([
  "source_path",
  "document",
  "addressable_type",
  "node_type",
  "scalar_type",
  "scalar_value",
  "scalar_value_encoding",
  "raw",
  "path",
  "line",
  "column",
  "start_byte",
  "end_byte",
  "raw_digest",
  "parent_path",
  "sibling_position",
  "depth",
  "direct_child_count",
  "descendant_count",
  "locator",
  "alias_location",
  "target_location",
]);

function request_error(message, details = {}) {
  throw new Yaml_patch_error("REQUEST_ERROR", message, { details });
}

function validate_projection(projection) {
  if (
    !projection ||
    typeof projection !== "object" ||
    Array.isArray(projection)
  ) {
    request_error("Query projection must be an object");
  }
  for (const field of Object.keys(projection)) {
    if (!["fields", "missing"].includes(field)) {
      request_error(`Unknown projection field: ${field}`, { field });
    }
  }
  if (!Array.isArray(projection.fields)) {
    request_error("Projection fields must be an array");
  }
  const seen = new Set();
  for (const field of projection.fields) {
    if (typeof field !== "string" || !PROJECTION_FIELDS.has(field)) {
      request_error(`Unknown projected field: ${field}`, { field });
    }
    if (seen.has(field)) request_error(`Duplicate projected field: ${field}`);
    seen.add(field);
  }
  if (!["null", "omit", "error"].includes(projection.missing)) {
    request_error("Projection missing must be null, omit, or error");
  }
  return projection;
}

function projected_value(record, field) {
  const entry = record.entry || record;
  if (field === "source_path") return record.source_path ?? entry.source_path;
  if (["line", "column", "start_byte", "end_byte"].includes(field)) {
    return entry.source && entry.source[field];
  }
  if (field === "alias_location" || field === "target_location") {
    return record.alias_resolution && record.alias_resolution[field];
  }
  return entry[field];
}

function project_query_results(results, projection) {
  validate_projection(projection);
  return results.map((record) => {
    const projected = {};
    for (const field of projection.fields) {
      const value = projected_value(record, field);
      if (value === undefined) {
        if (projection.missing === "error") {
          request_error(`Projected field is unavailable: ${field}`, { field });
        }
        if (projection.missing === "null") projected[field] = null;
      } else {
        projected[field] = value;
      }
    }
    return clone_json_value(projected, "query projection");
  });
}

module.exports = {
  PROJECTION_FIELDS,
  project_query_results,
  validate_projection,
};
