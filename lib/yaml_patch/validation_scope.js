"use strict";

const path = require("node:path");

const { minimatch } = require("minimatch");

const { clone_json_value } = require("./artifact_version");
const { Yaml_patch_error } = require("./error");
const { assert_known_fields, assert_object } = require("./schema");

const PROFILE_SCOPE_FIELDS = Object.freeze(["include", "ignore"]);

function validation_error(message, details = {}) {
  throw new Yaml_patch_error("VALIDATION_FAILED", message, {
    details,
    next_action: "correct the profile scope declaration",
  });
}

function validate_pattern_list(value, label) {
  if (!Array.isArray(value)) validation_error(`${label} must be an array`);
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const pattern = value[index];
    if (typeof pattern !== "string" || pattern.length === 0) {
      validation_error(`${label}[${index}] must be a non-empty string`, {
        label,
        index,
      });
    }
    if (pattern.includes("\0")) {
      validation_error(`${label}[${index}] must not contain NUL`, {
        label,
        index,
      });
    }
    if (seen.has(pattern)) {
      validation_error(`${label} contains a duplicate pattern`, {
        label,
        pattern,
      });
    }
    seen.add(pattern);
  }
  return Array.from(value);
}

function validate_profile_scope(scope = {}) {
  assert_known_fields(
    scope,
    PROFILE_SCOPE_FIELDS,
    "profile scope",
    "VALIDATION_FAILED",
  );
  return {
    include: Object.hasOwn(scope, "include")
      ? validate_pattern_list(scope.include, "profile scope include")
      : [],
    ignore: Object.hasOwn(scope, "ignore")
      ? validate_pattern_list(scope.ignore, "profile scope ignore")
      : [],
  };
}

function slash_path(value) {
  return value.split(path.sep).join("/");
}

function relative_path(file_path, root_path) {
  return slash_path(path.relative(root_path, file_path));
}

function literal_pattern_path(pattern, root_path) {
  return path.resolve(root_path, pattern);
}

function pattern_matches(candidate, pattern, available_paths, root_path) {
  const literal_path = literal_pattern_path(pattern, root_path);
  if (available_paths.has(literal_path)) return candidate === literal_path;
  return minimatch(relative_path(candidate, root_path), slash_path(pattern), {
    dot: true,
    nocase: false,
    nocomment: true,
    nonegate: true,
    windowsPathsNoEscape: true,
  });
}

function normalize_source_paths(file_paths) {
  if (!Array.isArray(file_paths)) {
    validation_error("profile source paths must be an array");
  }
  const normalized = new Set();
  for (let index = 0; index < file_paths.length; index += 1) {
    if (
      typeof file_paths[index] !== "string" ||
      file_paths[index].length === 0
    ) {
      validation_error(`profile source path ${index} must be non-empty`, {
        index,
      });
    }
    normalized.add(path.resolve(file_paths[index]));
  }
  return normalized;
}

function select_profile_paths(file_paths, scope = {}, options = {}) {
  assert_object(options, "profile scope options", "VALIDATION_FAILED");
  assert_known_fields(
    options,
    ["root_path"],
    "profile scope options",
    "VALIDATION_FAILED",
  );
  const normalized_scope = validate_profile_scope(scope);
  const root_path = path.resolve(options.root_path || process.cwd());
  const available_paths = normalize_source_paths(file_paths);
  const selected = [];
  for (const candidate of available_paths) {
    const included =
      normalized_scope.include.length === 0 ||
      normalized_scope.include.some((pattern) =>
        pattern_matches(candidate, pattern, available_paths, root_path),
      );
    const ignored = normalized_scope.ignore.some((pattern) =>
      pattern_matches(candidate, pattern, available_paths, root_path),
    );
    if (included && !ignored) selected.push(candidate);
  }
  return selected.sort((left, right) =>
    left === right ? 0 : left < right ? -1 : 1,
  );
}

function normalize_validation_scope(scope = { kind: "all_inputs" }) {
  assert_known_fields(
    scope,
    ["kind", "files", "node_locators"],
    "validation scope",
    "VALIDATION_FAILED",
  );
  const kinds = new Set([
    "all_inputs",
    "specified_files",
    "changed_nodes",
    "changed_files",
    "reference_closure",
  ]);
  if (!kinds.has(scope.kind)) {
    validation_error(`Unsupported validation scope: ${scope.kind}`);
  }
  if (scope.kind === "specified_files" && !Array.isArray(scope.files)) {
    validation_error("specified_files scope requires files");
  }
  if (scope.kind === "changed_nodes" && !Array.isArray(scope.node_locators)) {
    validation_error("changed_nodes scope requires node_locators");
  }
  return clone_json_value(scope, "validation scope");
}

module.exports = {
  PROFILE_SCOPE_FIELDS,
  normalize_validation_scope,
  select_profile_paths,
  validate_profile_scope,
};
