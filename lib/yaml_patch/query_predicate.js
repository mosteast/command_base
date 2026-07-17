"use strict";

const node_path = require("node:path");

const { canonical_json } = require("./artifact_version");
const { Yaml_patch_error } = require("./error");
const { validate_safe_regex } = require("./regex_policy");
const {
  evaluate_comparison,
  number_in_range,
  numeric_entry_value,
  typed_entry_equals,
  validate_comparison,
  validate_range,
  validate_typed_value,
} = require("./typed_value");

const DEFAULT_MAX_PREDICATE_DEPTH = 64;
const DEFAULT_MAX_PREDICATE_NODES = 1000;
const DEFAULT_MAX_PREDICATE_VALUES = 1000;
const DEFAULT_MAX_PATH_STEPS = 1000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ADDRESSABLE_TYPES = new Set([
  "stream",
  "document",
  "mapping",
  "mapping_pair",
  "mapping_key",
  "mapping_value",
  "sequence",
  "sequence_item",
  "scalar",
  "alias",
]);
const NODE_TYPES = new Set(["mapping", "sequence", "scalar", "alias"]);
const SCALAR_TYPES = new Set(["string", "integer", "float", "boolean", "null"]);

function request_error(message, details = {}) {
  throw new Yaml_patch_error("REQUEST_ERROR", message, { details });
}

function limit_error(limit_name, limit, actual) {
  throw new Yaml_patch_error(
    "CHANGE_LIMIT_EXCEEDED",
    `Query exceeds ${limit_name}`,
    { details: { limit_name, limit, actual } },
  );
}

function bounded_validation_option(options, name, default_value) {
  const value = options[name] === undefined ? default_value : options[name];
  if (!Number.isSafeInteger(value) || value < 0) {
    request_error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function consume_ast_node(state) {
  state.nodes += 1;
  if (state.nodes > state.max_nodes) {
    limit_error("max_predicate_nodes", state.max_nodes, state.nodes);
  }
}

function validate_bounded_typed_value(value, label, state) {
  state.values += 1;
  if (state.values > state.max_values) {
    limit_error("max_predicate_values", state.max_values, state.values);
  }
  consume_ast_node(state);
  return validate_typed_value(value, label);
}

function validate_bounded_comparison(comparison, label, state) {
  consume_ast_node(state);
  return validate_comparison(comparison, label, {
    before_typed_value(value, value_label) {
      state.values += 1;
      if (state.values > state.max_values) {
        limit_error("max_predicate_values", state.max_values, state.values);
      }
      consume_ast_node(state);
    },
  });
}

function assert_fields(value, allowed, required, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    request_error(`${label} must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      request_error(`Unknown ${label} field: ${field}`, { field });
    }
  }
  for (const field of required) {
    if (!Object.hasOwn(value, field)) {
      request_error(`${label} requires ${field}`, { field });
    }
  }
}

function nonnegative_integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    request_error(`${label} must be a non-negative integer`);
  }
}

function validate_path_step(step, index) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    request_error(`path.equals[${index}] must be an object`);
  }
  const has_sequence = Object.hasOwn(step, "sequence_index");
  const has_mapping = Object.hasOwn(step, "mapping_pair_index");
  if (has_sequence === has_mapping) {
    request_error(`path.equals[${index}] requires exactly one step form`);
  }
  if (has_sequence) {
    assert_fields(
      step,
      new Set(["sequence_index"]),
      ["sequence_index"],
      `path.equals[${index}]`,
    );
    nonnegative_integer(
      step.sequence_index,
      `path.equals[${index}].sequence_index`,
    );
    return;
  }
  assert_fields(
    step,
    new Set(["mapping_pair_index", "key_raw_digest", "node"]),
    ["mapping_pair_index", "key_raw_digest"],
    `path.equals[${index}]`,
  );
  nonnegative_integer(
    step.mapping_pair_index,
    `path.equals[${index}].mapping_pair_index`,
  );
  if (!SHA256_PATTERN.test(step.key_raw_digest || "")) {
    request_error(
      `path.equals[${index}].key_raw_digest must be a SHA-256 digest`,
    );
  }
  if (step.node !== undefined && step.node !== "key") {
    request_error(`path.equals[${index}].node must be key`);
  }
}

function validate_source_position(position, label) {
  const fields = ["line", "column", "start_byte", "end_byte"];
  assert_fields(position, new Set(fields), [], label);
  if (!fields.some((field) => Object.hasOwn(position, field))) {
    request_error(`${label} requires at least one position`);
  }
  for (const field of fields) {
    if (Object.hasOwn(position, field)) {
      const minimum = field === "line" || field === "column" ? 1 : 0;
      if (!Number.isSafeInteger(position[field]) || position[field] < minimum) {
        request_error(`${label}.${field} is invalid`);
      }
    }
  }
}

function validate_field_locator(field, label = "field locator", state) {
  if (state) consume_ast_node(state);
  assert_fields(
    field,
    new Set(["key", "pair_index", "key_raw_digest"]),
    [],
    label,
  );
  const has_key = Object.hasOwn(field, "key");
  const has_complex =
    Object.hasOwn(field, "pair_index") ||
    Object.hasOwn(field, "key_raw_digest");
  if (has_key === has_complex) {
    request_error(`${label} requires exactly one locator form`);
  }
  if (has_key) {
    if (state) {
      validate_bounded_typed_value(field.key, `${label}.key`, state);
    } else {
      validate_typed_value(field.key, `${label}.key`);
    }
  } else {
    if (
      !Object.hasOwn(field, "pair_index") ||
      !Object.hasOwn(field, "key_raw_digest")
    ) {
      request_error(`${label} complex form requires pair_index and digest`);
    }
    nonnegative_integer(field.pair_index, `${label}.pair_index`);
    if (!SHA256_PATTERN.test(field.key_raw_digest || "")) {
      request_error(`${label}.key_raw_digest must be a SHA-256 digest`);
    }
  }
  return field;
}

function validate_numeric_leaf(predicate, state) {
  assert_fields(
    predicate,
    new Set(["predicate", "comparison"]),
    ["comparison"],
    `${predicate.predicate} predicate`,
  );
  validate_bounded_comparison(
    predicate.comparison,
    `${predicate.predicate}.comparison`,
    state,
  );
  if (
    ["equals", "not_equals", "in"].includes(
      Object.keys(predicate.comparison)[0],
    )
  ) {
    request_error(`${predicate.predicate} requires a numeric comparison`);
  }
}

function validate_leaf(predicate, state, depth) {
  const name = predicate.predicate;
  if (typeof name !== "string")
    request_error("Predicate name must be a string");
  if (["addressable_type", "node_type", "scalar_type"].includes(name)) {
    assert_fields(
      predicate,
      new Set(["predicate", "equals"]),
      ["equals"],
      `${name} predicate`,
    );
    const allowed =
      name === "addressable_type"
        ? ADDRESSABLE_TYPES
        : name === "node_type"
          ? NODE_TYPES
          : SCALAR_TYPES;
    if (!allowed.has(predicate.equals)) {
      request_error(`Unsupported ${name}: ${predicate.equals}`);
    }
    return;
  }
  if (["typed_equals", "typed_not_equals"].includes(name)) {
    assert_fields(
      predicate,
      new Set(["predicate", "value"]),
      ["value"],
      `${name} predicate`,
    );
    validate_bounded_typed_value(predicate.value, `${name}.value`, state);
    return;
  }
  if (name === "typed_in") {
    assert_fields(
      predicate,
      new Set(["predicate", "values"]),
      ["values"],
      "typed_in predicate",
    );
    if (!Array.isArray(predicate.values) || predicate.values.length === 0) {
      request_error("typed_in values must be a non-empty array");
    }
    predicate.values.forEach((value, index) => {
      validate_bounded_typed_value(value, `typed_in.values[${index}]`, state);
    });
    return;
  }
  if (["field_exists", "field_missing"].includes(name)) {
    assert_fields(
      predicate,
      new Set(["predicate", "field"]),
      ["field"],
      `${name} predicate`,
    );
    validate_field_locator(predicate.field, "field locator", state);
    return;
  }
  if (name === "field_value") {
    assert_fields(
      predicate,
      new Set(["predicate", "field", "comparison"]),
      ["field", "comparison"],
      "field_value predicate",
    );
    validate_field_locator(predicate.field, "field locator", state);
    validate_bounded_comparison(
      predicate.comparison,
      "field_value.comparison",
      state,
    );
    return;
  }
  if (name === "field_type") {
    assert_fields(
      predicate,
      new Set(["predicate", "field", "equals"]),
      ["field", "equals"],
      "field_type predicate",
    );
    validate_field_locator(predicate.field, "field locator", state);
    if (
      typeof predicate.equals !== "string" ||
      !new Set([...ADDRESSABLE_TYPES, ...NODE_TYPES, ...SCALAR_TYPES]).has(
        predicate.equals,
      )
    ) {
      request_error("field_type equals is unsupported");
    }
    return;
  }
  if (name === "document") {
    assert_fields(
      predicate,
      new Set(["predicate", "equals"]),
      ["equals"],
      "document predicate",
    );
    nonnegative_integer(predicate.equals, "document.equals");
    return;
  }
  if (name === "path") {
    assert_fields(
      predicate,
      new Set(["predicate", "equals"]),
      ["equals"],
      "path predicate",
    );
    if (!Array.isArray(predicate.equals))
      request_error("path.equals must be an array");
    predicate.equals.forEach((step, index) => {
      state.path_steps += 1;
      if (state.path_steps > state.max_path_steps) {
        limit_error("max_path_steps", state.max_path_steps, state.path_steps);
      }
      consume_ast_node(state);
      validate_path_step(step, index);
    });
    return;
  }
  if (name === "source_path") {
    assert_fields(
      predicate,
      new Set(["predicate", "equals"]),
      ["equals"],
      "source_path predicate",
    );
    if (typeof predicate.equals !== "string") {
      request_error("source_path.equals must be a string");
    }
    return;
  }
  if (name === "source_position") {
    const fields = ["line", "column", "start_byte", "end_byte"];
    assert_fields(
      predicate,
      new Set(["predicate", "equals", ...fields]),
      [],
      "source_position predicate",
    );
    const has_equals = Object.hasOwn(predicate, "equals");
    const has_flat = fields.some((field) => Object.hasOwn(predicate, field));
    if (has_equals === has_flat) {
      request_error("source_position requires exactly one position form");
    }
    if (has_equals) consume_ast_node(state);
    validate_source_position(
      has_equals
        ? predicate.equals
        : Object.fromEntries(
            fields
              .filter((field) => Object.hasOwn(predicate, field))
              .map((field) => [field, predicate[field]]),
          ),
      "source_position",
    );
    return;
  }
  if (name === "relation") {
    assert_fields(
      predicate,
      new Set([
        "predicate",
        "relation",
        "where",
        "min_distance",
        "max_distance",
      ]),
      ["relation", "where"],
      "relation predicate",
    );
    if (
      !["parent", "ancestor", "descendant", "sibling"].includes(
        predicate.relation,
      )
    ) {
      request_error(`Unsupported relation: ${predicate.relation}`);
    }
    for (const field of ["min_distance", "max_distance"]) {
      if (Object.hasOwn(predicate, field))
        nonnegative_integer(predicate[field], field);
    }
    if (
      predicate.min_distance !== undefined &&
      predicate.max_distance !== undefined &&
      predicate.min_distance > predicate.max_distance
    ) {
      request_error("relation min_distance must not exceed max_distance");
    }
    validate_predicate_internal(predicate.where, state, depth + 1);
    return;
  }
  if (["depth", "direct_child_count", "descendant_count"].includes(name)) {
    validate_numeric_leaf(predicate, state);
    return;
  }
  if (["raw_equals", "raw_digest"].includes(name)) {
    assert_fields(
      predicate,
      new Set(["predicate", "equals"]),
      ["equals"],
      `${name} predicate`,
    );
    if (typeof predicate.equals !== "string") {
      request_error(`${name}.equals must be a string`);
    }
    if (name === "raw_digest" && !SHA256_PATTERN.test(predicate.equals)) {
      request_error("raw_digest.equals must be a SHA-256 digest");
    }
    return;
  }
  if (name === "raw_regex") {
    assert_fields(
      predicate,
      new Set(["predicate", "pattern", "flags"]),
      ["pattern", "flags"],
      "raw_regex predicate",
    );
    if (
      typeof predicate.pattern !== "string" ||
      typeof predicate.flags !== "string"
    ) {
      request_error("raw_regex pattern and flags must be strings");
    }
    validate_safe_regex(predicate.pattern, predicate.flags);
    return;
  }
  if (name === "string_equals") {
    assert_fields(
      predicate,
      new Set(["predicate", "value", "case_fold", "normalization"]),
      ["value", "case_fold", "normalization"],
      "string_equals predicate",
    );
    if (typeof predicate.value !== "string")
      request_error("string_equals value must be a string");
    if (!["none", "unicode"].includes(predicate.case_fold))
      request_error("string_equals case_fold is invalid");
    if (
      !["none", "NFC", "NFD", "NFKC", "NFKD"].includes(predicate.normalization)
    ) {
      request_error("string_equals normalization is invalid");
    }
    return;
  }
  if (name === "number_range") {
    assert_fields(
      predicate,
      new Set(["predicate", "min", "max", "include_min", "include_max"]),
      [],
      "number_range predicate",
    );
    const { predicate: _name, ...range } = predicate;
    validate_range(range, "number_range");
    return;
  }
  request_error(`Unsupported predicate: ${name}`);
}

function validate_predicate_internal(predicate, state, depth) {
  consume_ast_node(state);
  if (depth > state.max_depth) {
    limit_error("max_predicate_depth", state.max_depth, depth);
  }
  if (!predicate || typeof predicate !== "object" || Array.isArray(predicate)) {
    request_error("Predicate must be an object");
  }
  const forms = ["all", "any", "not", "predicate"].filter((field) =>
    Object.hasOwn(predicate, field),
  );
  if (forms.length !== 1)
    request_error("Predicate requires exactly one AST form");
  const form = forms[0];
  if (form === "all" || form === "any") {
    assert_fields(predicate, new Set([form]), [form], `${form} predicate`);
    if (!Array.isArray(predicate[form]))
      request_error(`${form} must be an array`);
    predicate[form].forEach((child) =>
      validate_predicate_internal(child, state, depth + 1),
    );
  } else if (form === "not") {
    assert_fields(predicate, new Set(["not"]), ["not"], "not predicate");
    validate_predicate_internal(predicate.not, state, depth + 1);
  } else {
    validate_leaf(predicate, state, depth);
  }
  return predicate;
}

function validate_predicate(predicate, options = {}) {
  return validate_predicate_internal(
    predicate,
    {
      nodes: 0,
      values: 0,
      path_steps: 0,
      max_nodes: bounded_validation_option(
        options,
        "max_predicate_nodes",
        DEFAULT_MAX_PREDICATE_NODES,
      ),
      max_depth: bounded_validation_option(
        options,
        "max_predicate_depth",
        DEFAULT_MAX_PREDICATE_DEPTH,
      ),
      max_values: bounded_validation_option(
        options,
        "max_predicate_values",
        DEFAULT_MAX_PREDICATE_VALUES,
      ),
      max_path_steps: bounded_validation_option(
        options,
        "max_path_steps",
        DEFAULT_MAX_PATH_STEPS,
      ),
    },
    1,
  );
}

function child_entries(entry, addressable_index) {
  return entry.child_ids
    .map((id) => addressable_index.by_id.get(id))
    .filter(Boolean);
}

function contained_node(relationship_entry, addressable_index) {
  if (!relationship_entry) return null;
  return child_entries(relationship_entry, addressable_index)[0] || null;
}

function mapping_pairs(entry, addressable_index) {
  if (!entry || entry.addressable_type !== "mapping") return [];
  return child_entries(entry, addressable_index).filter(
    (child) => child.addressable_type === "mapping_pair",
  );
}

function pair_relationship(pair, type, addressable_index) {
  return child_entries(pair, addressable_index).find(
    (entry) => entry.addressable_type === type,
  );
}

function locate_field_pairs(entry, field, addressable_index) {
  const pairs = mapping_pairs(entry, addressable_index);
  if (Object.hasOwn(field, "key")) {
    return pairs.filter((pair) => {
      const relation = pair_relationship(
        pair,
        "mapping_key",
        addressable_index,
      );
      return typed_entry_equals(
        contained_node(relation, addressable_index),
        field.key,
      );
    });
  }
  return pairs.filter(
    (pair) =>
      pair.mapping_pair_index === field.pair_index &&
      pair.key_raw_digest === field.key_raw_digest,
  );
}

function field_value_entries(entry, field, addressable_index) {
  return locate_field_pairs(entry, field, addressable_index)
    .map((pair) =>
      contained_node(
        pair_relationship(pair, "mapping_value", addressable_index),
        addressable_index,
      ),
    )
    .filter(Boolean);
}

function structural_numeric_entry(value) {
  return { scalar_type: "integer", scalar_value: value };
}

function* related_entries(entry, relation, context) {
  const { addressable_index } = context;
  if (relation === "parent") {
    const parent = addressable_index.by_id.get(entry.parent_id);
    if (parent) yield { entry: parent, distance: 1 };
    return;
  }
  if (relation === "ancestor") {
    let current = entry;
    let distance = 0;
    while (current.parent_id !== null) {
      current = addressable_index.by_id.get(current.parent_id);
      if (!current) break;
      distance += 1;
      yield { entry: current, distance };
    }
    return;
  }
  if (relation === "sibling") {
    const parent = addressable_index.by_id.get(entry.parent_id);
    if (!parent) return;
    for (const candidate of child_entries(parent, addressable_index)) {
      if (candidate.id !== entry.id) yield { entry: candidate, distance: 1 };
    }
    return;
  }
  const pending = child_entries(entry, addressable_index).map((child) => ({
    entry: child,
    distance: 1,
  }));
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    yield current;
    for (const child of child_entries(current.entry, addressable_index)) {
      pending.push({ entry: child, distance: current.distance + 1 });
    }
  }
}

function normalize_string(value, predicate) {
  let result = value;
  if (predicate.normalization !== "none") {
    result = result.normalize(predicate.normalization);
  }
  if (predicate.case_fold === "unicode") {
    result = result.toLocaleUpperCase("und").toLocaleLowerCase("und");
  }
  return result;
}

function evaluate_leaf(entry, predicate, context) {
  const name = predicate.predicate;
  if (["addressable_type", "node_type", "scalar_type"].includes(name)) {
    return entry[name] === predicate.equals;
  }
  if (name === "typed_equals")
    return typed_entry_equals(entry, predicate.value);
  if (name === "typed_not_equals")
    return !typed_entry_equals(entry, predicate.value);
  if (name === "typed_in") {
    return predicate.values.some((value) => typed_entry_equals(entry, value));
  }
  if (
    ["field_exists", "field_missing", "field_value", "field_type"].includes(
      name,
    )
  ) {
    if (entry.addressable_type !== "mapping") return false;
    const values = field_value_entries(
      entry,
      predicate.field,
      context.addressable_index,
    );
    if (name === "field_exists") return values.length > 0;
    if (name === "field_missing") return values.length === 0;
    if (name === "field_value") {
      return values.some((value) =>
        evaluate_comparison(value, predicate.comparison),
      );
    }
    return values.some(
      (value) =>
        value.scalar_type === predicate.equals ||
        value.node_type === predicate.equals ||
        value.addressable_type === predicate.equals,
    );
  }
  if (name === "document") return entry.document === predicate.equals;
  if (name === "path")
    return canonical_json(entry.path) === canonical_json(predicate.equals);
  if (name === "source_path") {
    return context.source_path === node_path.resolve(predicate.equals);
  }
  if (name === "source_position") {
    const position = predicate.equals || predicate;
    return ["line", "column", "start_byte", "end_byte"].every(
      (field) =>
        !Object.hasOwn(position, field) ||
        entry.source[field] === position[field],
    );
  }
  if (name === "relation") {
    const min = predicate.min_distance ?? 1;
    const max = predicate.max_distance ?? Number.MAX_SAFE_INTEGER;
    for (const related of related_entries(entry, predicate.relation, context)) {
      context.state.relation_visits += 1;
      if (context.state.relation_visits > context.limits.max_relation_visits) {
        limit_error(
          "max_relation_visits",
          context.limits.max_relation_visits,
          context.state.relation_visits,
        );
      }
      if (
        related.distance >= min &&
        related.distance <= max &&
        evaluate_predicate(related.entry, predicate.where, context)
      ) {
        return true;
      }
    }
    return false;
  }
  if (["depth", "direct_child_count", "descendant_count"].includes(name)) {
    return evaluate_comparison(
      structural_numeric_entry(entry[name]),
      predicate.comparison,
    );
  }
  if (name === "raw_equals") return entry.raw === predicate.equals;
  if (name === "raw_digest") return entry.raw_digest === predicate.equals;
  if (name === "raw_regex") {
    if (entry.raw.length > context.limits.max_regex_input_length) {
      limit_error(
        "max_regex_input_length",
        context.limits.max_regex_input_length,
        entry.raw.length,
      );
    }
    return new RegExp(predicate.pattern, predicate.flags).test(entry.raw);
  }
  if (name === "string_equals") {
    return (
      entry.scalar_type === "string" &&
      normalize_string(entry.scalar_value, predicate) ===
        normalize_string(predicate.value, predicate)
    );
  }
  if (name === "number_range") {
    const { predicate: _name, ...range } = predicate;
    return number_in_range(numeric_entry_value(entry), range);
  }
  return false;
}

function evaluate_predicate(entry, predicate, context) {
  if (Object.hasOwn(predicate, "all")) {
    return predicate.all.every((child) =>
      evaluate_predicate(entry, child, context),
    );
  }
  if (Object.hasOwn(predicate, "any")) {
    return predicate.any.some((child) =>
      evaluate_predicate(entry, child, context),
    );
  }
  if (Object.hasOwn(predicate, "not")) {
    return !evaluate_predicate(entry, predicate.not, context);
  }
  return evaluate_leaf(entry, predicate, context);
}

module.exports = {
  DEFAULT_MAX_PREDICATE_DEPTH,
  DEFAULT_MAX_PREDICATE_NODES,
  DEFAULT_MAX_PREDICATE_VALUES,
  DEFAULT_MAX_PATH_STEPS,
  contained_node,
  evaluate_predicate,
  field_value_entries,
  locate_field_pairs,
  mapping_pairs,
  pair_relationship,
  validate_field_locator,
  validate_predicate,
};
