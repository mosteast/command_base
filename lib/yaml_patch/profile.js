"use strict";

const { TextDecoder } = require("node:util");

const YAML = require("yaml");

const {
  canonical_digest,
  clone_json_value,
  validate_artifact_version,
} = require("./artifact_version");
const { Yaml_patch_error } = require("./error");
const { parse_yaml_source } = require("./parser");
const { validate_predicate } = require("./query_predicate");
const { validate_query_v2 } = require("./query_v2");
const {
  assert_known_fields,
  assert_non_empty_string,
  assert_object,
} = require("./schema");
const { create_source_record } = require("./source");
const { validate_profile_scope } = require("./validation_scope");

const DEFAULT_MAX_PROFILE_BYTES = 1024 * 1024;
const PROFILE_FIELDS = Object.freeze([
  "version",
  "scope",
  "node_sets",
  "identity",
  "protected",
  "field_aliases",
]);
const NODE_SET_FIELDS = Object.freeze([
  "query",
  "fields",
  "field_order",
  "diagnostic_projection",
]);
const FIELD_DECLARATION_FIELDS = Object.freeze([
  "allowed",
  "required",
  "optional",
  "rules",
]);
const FIELD_RULE_FIELDS = Object.freeze([
  "types",
  "cardinality",
  "consistent_type",
  "child_node_set",
]);
const IDENTITY_FIELDS = Object.freeze([
  "rule_id",
  "node_set",
  "fields",
  "unique_scope",
  "missing_policy",
  "null_policy",
  "types",
  "immutable_existing",
]);
const PROTECTED_FIELDS = Object.freeze([
  "rule_id",
  "node_set",
  "when",
  "actions",
]);
const FIELD_ALIAS_FIELDS = Object.freeze([
  "rule_id",
  "node_set",
  "canonical",
  "aliases",
  "severity",
]);
const PROFILE_VALUE_TYPES = Object.freeze([
  "mapping",
  "sequence",
  "scalar",
  "alias",
  "string",
  "integer",
  "float",
  "boolean",
  "null",
]);
const PROFILE_VALUE_TYPE_SET = new Set(PROFILE_VALUE_TYPES);
const IDENTITY_VALUE_TYPE_SET = new Set([
  "string",
  "integer",
  "float",
  "boolean",
  "null",
]);
const IDENTITY_SCOPES = Object.freeze(["input", "file", "document"]);
const IDENTITY_SCOPE_SET = new Set(IDENTITY_SCOPES);
const NULL_MISSING_POLICIES = Object.freeze(["allow", "error"]);
const NULL_MISSING_POLICY_SET = new Set(NULL_MISSING_POLICIES);
const PROTECTED_ACTIONS = Object.freeze(["delete", "copy", "identity_modify"]);
const PROTECTED_ACTION_SET = new Set(PROTECTED_ACTIONS);

function profile_error(message, details = {}) {
  throw new Yaml_patch_error("VALIDATION_FAILED", message, {
    details,
    next_action: "correct the declarative profile",
  });
}

function assert_array(value, label) {
  if (!Array.isArray(value)) profile_error(`${label} must be an array`);
  return value;
}

function string_list(value, label, options = {}) {
  assert_array(value, label);
  const result = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || item.length === 0) {
      profile_error(`${label}[${index}] must be a non-empty string`, {
        label,
        index,
      });
    }
    if (seen.has(item)) {
      profile_error(`${label} contains a duplicate value`, { label, item });
    }
    if (options.allowed && !options.allowed.has(item)) {
      profile_error(`${label} contains an unsupported value: ${item}`, {
        label,
        item,
      });
    }
    seen.add(item);
    result.push(item);
  }
  if (options.non_empty && result.length === 0) {
    profile_error(`${label} must not be empty`, { label });
  }
  return result;
}

function assert_boolean(value, label) {
  if (typeof value !== "boolean") profile_error(`${label} must be boolean`);
}

function validate_cardinality(cardinality, label) {
  assert_known_fields(cardinality, ["min", "max"], label, "VALIDATION_FAILED");
  if (
    !Object.hasOwn(cardinality, "min") ||
    !Object.hasOwn(cardinality, "max")
  ) {
    profile_error(`${label} requires min and max`);
  }
  if (
    !Number.isSafeInteger(cardinality.min) ||
    cardinality.min < 0 ||
    !Number.isSafeInteger(cardinality.max) ||
    cardinality.max < cardinality.min
  ) {
    profile_error(`${label} must be a bounded non-negative range`);
  }
}

function validate_field_rule(rule, label) {
  assert_known_fields(rule, FIELD_RULE_FIELDS, label, "VALIDATION_FAILED");
  if (Object.hasOwn(rule, "types")) {
    string_list(rule.types, `${label}.types`, {
      allowed: PROFILE_VALUE_TYPE_SET,
      non_empty: true,
    });
  }
  if (Object.hasOwn(rule, "cardinality")) {
    validate_cardinality(rule.cardinality, `${label}.cardinality`);
  }
  if (Object.hasOwn(rule, "consistent_type")) {
    assert_boolean(rule.consistent_type, `${label}.consistent_type`);
  }
  if (Object.hasOwn(rule, "child_node_set")) {
    assert_non_empty_string(
      rule.child_node_set,
      `${label}.child_node_set`,
      "VALIDATION_FAILED",
    );
  }
  if (Object.keys(rule).length === 0) {
    profile_error(`${label} must declare at least one constraint`);
  }
}

function assert_subset(values, allowed, label) {
  for (const value of values) {
    if (!allowed.has(value)) {
      profile_error(`${label} contains undeclared field: ${value}`, {
        label,
        field: value,
      });
    }
  }
}

function identity_field_path(value, label) {
  if (typeof value === "string") {
    if (value.length === 0) profile_error(`${label} must not be empty`);
    return [value];
  }
  return string_list(value, label, { non_empty: true });
}

function validate_identity_fields(value, label) {
  assert_array(value, label);
  if (value.length === 0) profile_error(`${label} must not be empty`);
  const paths = value.map((field, index) =>
    identity_field_path(field, `${label}[${index}]`),
  );
  const seen = new Set();
  for (const field_path of paths) {
    const key = JSON.stringify(field_path);
    if (seen.has(key)) {
      profile_error(`${label} contains a duplicate field path`, {
        field_path,
      });
    }
    seen.add(key);
  }
  return paths;
}

function validate_field_declaration(fields, node_set_name) {
  const label = `node set ${node_set_name} fields`;
  assert_known_fields(
    fields,
    FIELD_DECLARATION_FIELDS,
    label,
    "VALIDATION_FAILED",
  );
  const allowed = string_list(fields.allowed || [], `${label}.allowed`);
  const allowed_set = new Set(allowed);
  const required = string_list(fields.required || [], `${label}.required`);
  const optional = string_list(fields.optional || [], `${label}.optional`);
  assert_subset(required, allowed_set, `${label}.required`);
  assert_subset(optional, allowed_set, `${label}.optional`);
  for (const field of required) {
    if (optional.includes(field)) {
      profile_error(`${label} field cannot be required and optional`, {
        field,
      });
    }
  }
  const rules = fields.rules || {};
  assert_object(rules, `${label}.rules`, "VALIDATION_FAILED");
  for (const field of Object.keys(rules)) {
    if (!allowed_set.has(field)) {
      profile_error(`${label}.rules contains undeclared field: ${field}`);
    }
    validate_field_rule(rules[field], `${label}.rules.${field}`);
  }
  return { allowed_set };
}

function validate_node_set(name, node_set) {
  assert_non_empty_string(name, "node set name", "VALIDATION_FAILED");
  assert_known_fields(
    node_set,
    NODE_SET_FIELDS,
    `node set ${name}`,
    "VALIDATION_FAILED",
  );
  if (!Object.hasOwn(node_set, "query")) {
    profile_error(`node set ${name} requires query`);
  }
  validate_query_v2(node_set.query, { mode: "read" });
  if (Object.hasOwn(node_set.query, "expect_matches")) {
    profile_error(
      `node set ${name} query must not constrain result cardinality`,
    );
  }
  if (node_set.query.page && node_set.query.page.cursor) {
    profile_error(`node set ${name} query must not contain a cursor`);
  }
  let allowed_set = null;
  if (Object.hasOwn(node_set, "fields")) {
    allowed_set = validate_field_declaration(node_set.fields, name).allowed_set;
  }
  for (const list_name of ["field_order", "diagnostic_projection"]) {
    if (!Object.hasOwn(node_set, list_name)) continue;
    const values = string_list(
      node_set[list_name],
      `node set ${name}.${list_name}`,
    );
    if (!allowed_set) {
      profile_error(`node set ${name}.${list_name} requires fields.allowed`);
    }
    assert_subset(values, allowed_set, `node set ${name}.${list_name}`);
  }
}

function validate_node_sets(node_sets) {
  assert_object(node_sets, "profile node_sets", "VALIDATION_FAILED");
  for (const [name, node_set] of Object.entries(node_sets)) {
    validate_node_set(name, node_set);
  }
}

function validate_identity(identity, index, node_sets) {
  const label = `identity rule ${index}`;
  assert_known_fields(identity, IDENTITY_FIELDS, label, "VALIDATION_FAILED");
  for (const field of ["rule_id", "node_set"]) {
    if (!Object.hasOwn(identity, field))
      profile_error(`${label} requires ${field}`);
    assert_non_empty_string(
      identity[field],
      `${label}.${field}`,
      "VALIDATION_FAILED",
    );
  }
  if (!Object.hasOwn(node_sets, identity.node_set)) {
    profile_error(`${label} references unknown node set: ${identity.node_set}`);
  }
  const identity_paths = validate_identity_fields(
    identity.fields,
    `${label}.fields`,
  );
  const node_set_fields = node_sets[identity.node_set].fields;
  if (node_set_fields) {
    assert_subset(
      identity_paths.map((field_path) => field_path[0]),
      new Set(node_set_fields.allowed || []),
      `${label}.fields`,
    );
  }
  const unique_scope = identity.unique_scope || "input";
  if (!IDENTITY_SCOPE_SET.has(unique_scope)) {
    profile_error(`${label}.unique_scope is unsupported: ${unique_scope}`);
  }
  for (const policy_name of ["missing_policy", "null_policy"]) {
    const policy = identity[policy_name] || "error";
    if (!NULL_MISSING_POLICY_SET.has(policy)) {
      profile_error(`${label}.${policy_name} is unsupported: ${policy}`);
    }
  }
  if (Object.hasOwn(identity, "types")) {
    string_list(identity.types, `${label}.types`, {
      allowed: IDENTITY_VALUE_TYPE_SET,
      non_empty: true,
    });
  }
  if (Object.hasOwn(identity, "immutable_existing")) {
    assert_boolean(identity.immutable_existing, `${label}.immutable_existing`);
  }
}

function validate_protected_rule(rule, index, node_sets) {
  const label = `protected rule ${index}`;
  assert_known_fields(rule, PROTECTED_FIELDS, label, "VALIDATION_FAILED");
  for (const field of ["rule_id", "node_set", "actions"]) {
    if (!Object.hasOwn(rule, field))
      profile_error(`${label} requires ${field}`);
  }
  assert_non_empty_string(
    rule.rule_id,
    `${label}.rule_id`,
    "VALIDATION_FAILED",
  );
  assert_non_empty_string(
    rule.node_set,
    `${label}.node_set`,
    "VALIDATION_FAILED",
  );
  if (!Object.hasOwn(node_sets, rule.node_set)) {
    profile_error(`${label} references unknown node set: ${rule.node_set}`);
  }
  string_list(rule.actions, `${label}.actions`, {
    allowed: PROTECTED_ACTION_SET,
    non_empty: true,
  });
  if (Object.hasOwn(rule, "when")) validate_predicate(rule.when);
}

function validate_field_alias(rule, index, node_sets) {
  const label = `field alias rule ${index}`;
  assert_known_fields(rule, FIELD_ALIAS_FIELDS, label, "VALIDATION_FAILED");
  for (const field of [
    "rule_id",
    "node_set",
    "canonical",
    "aliases",
    "severity",
  ]) {
    if (!Object.hasOwn(rule, field))
      profile_error(`${label} requires ${field}`);
  }
  for (const field of ["rule_id", "node_set", "canonical"]) {
    assert_non_empty_string(
      rule[field],
      `${label}.${field}`,
      "VALIDATION_FAILED",
    );
  }
  if (!Object.hasOwn(node_sets, rule.node_set)) {
    profile_error(`${label} references unknown node set: ${rule.node_set}`);
  }
  const aliases = string_list(rule.aliases, `${label}.aliases`, {
    non_empty: true,
  });
  if (aliases.includes(rule.canonical)) {
    profile_error(`${label}.aliases must not include the canonical field`);
  }
  const node_set_fields = node_sets[rule.node_set].fields;
  if (
    node_set_fields &&
    !(node_set_fields.allowed || []).includes(rule.canonical)
  ) {
    profile_error(`${label}.canonical must be declared in fields.allowed`);
  }
  if (!new Set(["warning", "error"]).has(rule.severity)) {
    profile_error(`${label}.severity must be warning or error`);
  }
}

function validate_cross_references(profile) {
  const node_sets = profile.node_sets || {};
  for (const [name, node_set] of Object.entries(node_sets)) {
    const rules = node_set.fields && node_set.fields.rules;
    for (const [field, rule] of Object.entries(rules || {})) {
      if (
        rule.child_node_set &&
        !Object.hasOwn(node_sets, rule.child_node_set)
      ) {
        profile_error(
          `node set ${name} field ${field} references unknown child node set: ${rule.child_node_set}`,
        );
      }
    }
  }
}

function validate_unique_rule_ids(profile) {
  const seen = new Set();
  for (const [collection_name, rules] of [
    ["identity", profile.identity || []],
    ["protected", profile.protected || []],
    ["field_aliases", profile.field_aliases || []],
  ]) {
    for (const rule of rules) {
      if (seen.has(rule.rule_id)) {
        profile_error(`Duplicate profile rule_id: ${rule.rule_id}`, {
          collection: collection_name,
          rule_id: rule.rule_id,
        });
      }
      seen.add(rule.rule_id);
    }
  }
}

function validate_profile(profile) {
  assert_known_fields(profile, PROFILE_FIELDS, "profile", "VALIDATION_FAILED");
  validate_artifact_version("profile", profile.version);
  if (Object.hasOwn(profile, "scope")) validate_profile_scope(profile.scope);
  const node_sets = profile.node_sets || {};
  validate_node_sets(node_sets);
  const identity = profile.identity || [];
  assert_array(identity, "profile identity");
  identity.forEach((rule, index) => validate_identity(rule, index, node_sets));
  const protected_rules = profile.protected || [];
  assert_array(protected_rules, "profile protected");
  protected_rules.forEach((rule, index) =>
    validate_protected_rule(rule, index, node_sets),
  );
  const field_aliases = profile.field_aliases || [];
  assert_array(field_aliases, "profile field_aliases");
  field_aliases.forEach((rule, index) =>
    validate_field_alias(rule, index, node_sets),
  );
  validate_cross_references(profile);
  validate_unique_rule_ids(profile);
  const cloned_profile = clone_json_value(profile, "profile");
  return {
    profile: cloned_profile,
    profile_digest: canonical_digest(cloned_profile),
    diagnostics: [],
  };
}

function contains_alias(document) {
  let alias_found = false;
  YAML.visit(document, {
    Alias() {
      alias_found = true;
      return YAML.visit.BREAK;
    },
  });
  return alias_found;
}

function load_profile(input, options = {}) {
  assert_known_fields(
    options,
    ["max_bytes", "source_path"],
    "profile load options",
    "VALIDATION_FAILED",
  );
  if (!Buffer.isBuffer(input)) profile_error("profile input must be a Buffer");
  const max_bytes =
    options.max_bytes === undefined
      ? DEFAULT_MAX_PROFILE_BYTES
      : options.max_bytes;
  if (!Number.isSafeInteger(max_bytes) || max_bytes < 1) {
    profile_error("profile max_bytes must be a positive integer");
  }
  if (input.length > max_bytes) {
    throw new Yaml_patch_error(
      "CHANGE_LIMIT_EXCEEDED",
      "Profile input exceeds max_bytes",
      {
        details: {
          limit_name: "max_profile_bytes",
          limit: max_bytes,
          actual: input.length,
        },
      },
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch (error) {
    throw new Yaml_patch_error("VALIDATION_FAILED", "Profile is not UTF-8", {
      cause: error,
    });
  }
  const source = create_source_record(input, {
    requested_path: options.source_path || "<profile>",
  });
  const parsed = parse_yaml_source(source);
  if (parsed.errors.length > 0 || parsed.warnings.length > 0) {
    throw new Yaml_patch_error(
      "VALIDATION_FAILED",
      "Profile YAML contains parser diagnostics",
      { details: { errors: parsed.errors, warnings: parsed.warnings } },
    );
  }
  if (parsed.documents.length !== 1 || !parsed.documents[0].contents) {
    profile_error("Profile must contain exactly one non-empty document");
  }
  const document = parsed.documents[0];
  if (contains_alias(document)) {
    profile_error("Profile aliases are not allowed");
  }
  let profile;
  try {
    profile = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  } catch (error) {
    throw new Yaml_patch_error(
      "VALIDATION_FAILED",
      "Profile cannot be converted to plain JSON data",
      { cause: error },
    );
  }
  return validate_profile(profile).profile;
}

module.exports = {
  DEFAULT_MAX_PROFILE_BYTES,
  FIELD_ALIAS_FIELDS,
  FIELD_DECLARATION_FIELDS,
  FIELD_RULE_FIELDS,
  IDENTITY_FIELDS,
  IDENTITY_SCOPES,
  NODE_SET_FIELDS,
  NULL_MISSING_POLICIES,
  PROFILE_FIELDS,
  PROFILE_VALUE_TYPES,
  PROTECTED_ACTIONS,
  PROTECTED_FIELDS,
  load_profile,
  validate_profile,
};
