"use strict";

const path = require("node:path");

const { build_addressable_index } = require("./addressable");
const { validate_addressable_index_binding } = require("./addressable_graph");
const { canonical_json, clone_json_value } = require("./artifact_version");
const { create_diagnostic } = require("./diagnostic");
const { Yaml_patch_error } = require("./error");
const { validate_profile } = require("./profile");
const {
  GRAPH_LIMIT_FIELDS,
  validate_profile_references,
} = require("./profile_reference");
const {
  contained_node,
  evaluate_predicate,
  field_value_entries,
  mapping_pairs,
  pair_relationship,
} = require("./query_predicate");
const { run_query_v2 } = require("./query_v2");
const { assert_known_fields } = require("./schema");
const {
  normalize_validation_scope,
  select_profile_paths,
} = require("./validation_scope");

const DEFAULT_MAX_PROFILE_RESULT = 10_000;
const IDENTITY_LIMIT_FIELDS = Object.freeze([
  "max_added_identity",
  "max_deleted_identity",
  "max_modified_identity",
  "max_affected_identity",
]);
const VALIDATION_REQUEST_FIELDS = Object.freeze([
  "profile",
  "original_inputs",
  "candidate_inputs",
  "operation_provenance",
  "scope",
  "limits",
  "options",
]);
const VALIDATION_OPTION_FIELDS = Object.freeze([
  "max_profile_result",
  "root_path",
  "require_complete",
]);

function profile_error(message, details = {}) {
  throw new Yaml_patch_error("VALIDATION_FAILED", message, {
    details,
    next_action: "provide valid profile validation inputs",
  });
}

function normalize_input(input, position) {
  if (!input || typeof input !== "object" || !input.index) {
    profile_error(`profile validation input ${position} requires index`);
  }
  const addressable_index =
    input.addressable_index || build_addressable_index(input.index);
  validate_addressable_index_binding(input.index, addressable_index);
  const source_path = path.resolve(
    input.index.source.requested_path || input.index.source.file_path || "",
  );
  return { index: input.index, addressable_index, source_path };
}

function normalize_inputs(inputs, label) {
  if (!Array.isArray(inputs)) profile_error(`${label} must be an array`);
  const normalized = inputs.map(normalize_input);
  const seen = new Set();
  for (const input of normalized) {
    if (seen.has(input.source_path)) {
      profile_error(`${label} contains duplicate source path`, {
        source_path: input.source_path,
      });
    }
    seen.add(input.source_path);
  }
  return normalized;
}

function input_map(inputs) {
  return new Map(inputs.map((input) => [input.source_path, input]));
}

function internal_node_set_query(query, max_result) {
  return {
    ...clone_json_value(query, "profile node set query"),
    projection: {
      fields: [
        "source_path",
        "document",
        "locator",
        "path",
        "addressable_type",
        "node_type",
      ],
      missing: "error",
    },
    page: { limit: max_result },
    limits: {
      ...(query.limits || {}),
      max_result,
      max_output_bytes: Math.max(
        query.limits && query.limits.max_output_bytes
          ? query.limits.max_output_bytes
          : 0,
        16 * 1024 * 1024,
      ),
    },
  };
}

function locator_entry_maps(inputs) {
  const maps = new Map();
  for (const input of inputs) {
    maps.set(
      input.source_path,
      new Map(
        input.addressable_index.entries.map((entry) => [entry.locator, entry]),
      ),
    );
  }
  return maps;
}

function resolve_node_set(inputs, query, max_result) {
  if (inputs.length === 0) return [];
  const result = run_query_v2(
    inputs,
    internal_node_set_query(query, max_result),
    { mode: "read" },
  );
  if (result.truncated) {
    throw new Yaml_patch_error(
      "CHANGE_LIMIT_EXCEEDED",
      "Profile node set exceeds max_profile_result",
      {
        details: {
          limit_name: "max_profile_result",
          limit: max_result,
          actual_at_least: result.total_match_count,
        },
      },
    );
  }
  const by_path = input_map(inputs);
  const locators = locator_entry_maps(inputs);
  return result.matches.map((match) => {
    const source_path = path.resolve(match.source_path);
    const input = by_path.get(source_path);
    const entry = locators.get(source_path).get(match.locator);
    if (!input || !entry) {
      profile_error("Profile node set result cannot be rebound", {
        source_path,
        locator: match.locator,
      });
    }
    return { input, entry };
  });
}

function apply_profile_path_scope(inputs, profile, options) {
  if (!profile.scope) return inputs;
  const selected_paths = new Set(
    select_profile_paths(
      inputs.map((input) => input.source_path),
      profile.scope,
      { root_path: options.root_path || process.cwd() },
    ),
  );
  return inputs.filter((input) => selected_paths.has(input.source_path));
}

function filter_node_sets(node_sets, scope, allowed_paths) {
  const result = {};
  const locator_set = new Set(scope.node_locators || []);
  for (const [name, records] of Object.entries(node_sets)) {
    result[name] = records.filter((record) => {
      if (!allowed_paths.has(record.input.source_path)) return false;
      if (scope.kind === "changed_nodes") {
        return locator_set.has(record.entry.locator);
      }
      return true;
    });
  }
  return result;
}

function scope_decision(scope, inputs, require_complete) {
  const all_paths = inputs.map((input) => input.source_path);
  const full_required =
    scope.kind === "reference_closure" ||
    scope.kind === "changed_files" ||
    (require_complete && scope.kind !== "all_inputs");
  const requested_paths = new Set(
    (scope.files || []).map((file) => path.resolve(file)),
  );
  let validated_paths;
  if (
    scope.kind === "all_inputs" ||
    scope.kind === "changed_nodes" ||
    full_required
  ) {
    validated_paths = new Set(all_paths);
  } else {
    validated_paths = requested_paths;
  }
  const validated_files = all_paths
    .filter((file) => validated_paths.has(file))
    .sort();
  const unvalidated_files = all_paths
    .filter((file) => !validated_paths.has(file))
    .sort();
  const unvalidated_node_scope =
    scope.kind === "changed_nodes" && !full_required;
  return {
    validated_paths,
    effective_scope: full_required ? { kind: "all_inputs" } : scope,
    scope_report: {
      requested: scope.kind,
      complete: unvalidated_files.length === 0 && !unvalidated_node_scope,
      fallback_to_full: full_required && scope.kind !== "all_inputs",
      validated_files,
      unvalidated_files,
      ...(unvalidated_node_scope ? { unvalidated_node_scope: true } : {}),
    },
  };
}

function build_node_sets(inputs, profile, max_result) {
  const result = {};
  for (const [name, declaration] of Object.entries(profile.node_sets || {})) {
    result[name] = resolve_node_set(inputs, declaration.query, max_result);
  }
  return result;
}

function typed_string_field(field_name) {
  return { key: { type: "string", value: field_name } };
}

function fields_for_mapping(record) {
  const { entry } = record;
  const addressable_index = record.input.addressable_index;
  if (entry.addressable_type !== "mapping") return new Map();
  const result = new Map();
  for (const pair of mapping_pairs(entry, addressable_index)) {
    const key_relation = pair_relationship(
      pair,
      "mapping_key",
      addressable_index,
    );
    const key_node = contained_node(key_relation, addressable_index);
    const value_relation = pair_relationship(
      pair,
      "mapping_value",
      addressable_index,
    );
    const value_node = contained_node(value_relation, addressable_index);
    const field_name =
      key_node && key_node.scalar_type === "string"
        ? key_node.scalar_value
        : null;
    const key =
      field_name === null ? `<complex:${pair.key_raw_digest}>` : field_name;
    const occurrences = result.get(key) || [];
    occurrences.push({ pair, key_node, value_node });
    result.set(key, occurrences);
  }
  return result;
}

function entry_value_type(entry) {
  if (!entry) return "missing";
  if (entry.scalar_type) return entry.scalar_type;
  if (entry.node_type) return entry.node_type;
  return entry.addressable_type;
}

function public_value(entry) {
  if (!entry) return null;
  if (entry.scalar_type)
    return clone_json_value(entry.scalar_value, "profile value");
  return { type: entry_value_type(entry), raw_digest: entry.raw_digest };
}

function projection_for(record, node_set) {
  const projection = {};
  for (const field of node_set.diagnostic_projection || []) {
    const values = field_value_entries(
      record.entry,
      typed_string_field(field),
      record.input.addressable_index,
    );
    projection[field] =
      values.length === 0
        ? null
        : values.length === 1
          ? public_value(values[0])
          : values.map(public_value);
  }
  return projection;
}

function diagnostic(record, input) {
  const entry = input.location_entry || record.entry;
  const node_set = input.node_set;
  const declared_projection =
    node_set && (node_set.diagnostic_projection || []).length > 0
      ? projection_for(record, node_set)
      : {};
  const projection = {
    ...declared_projection,
    ...(input.projection || {}),
  };
  return create_diagnostic({
    code: input.code,
    severity: input.severity || "error",
    rule_id: input.rule_id,
    file: record.input.source_path,
    document: entry.document,
    line: entry.source.line,
    column: entry.source.column,
    path: entry.path,
    violation: input.violation,
    suggested_action: input.suggested_action,
    ...(Object.keys(projection).length > 0 ? { projection } : {}),
  });
}

function validate_field_rules(node_sets, profile, diagnostics) {
  for (const [node_set_name, records] of Object.entries(node_sets)) {
    const declaration = profile.node_sets[node_set_name];
    if (!declaration.fields) continue;
    const allowed = new Set(declaration.fields.allowed || []);
    const required = new Set(declaration.fields.required || []);
    const rules = declaration.fields.rules || {};
    const consistent_types = new Map();
    for (const record of records) {
      const mapping_fields = fields_for_mapping(record);
      for (const [field, occurrences] of mapping_fields) {
        if (!allowed.has(field)) {
          diagnostics.push(
            diagnostic(record, {
              code: "PROFILE_VIOLATION",
              rule_id: `${node_set_name}.fields.allowed`,
              node_set: declaration,
              location_entry: occurrences[0].key_node || occurrences[0].pair,
              violation: `field ${field} is not allowed`,
              suggested_action:
                "remove the field or declare it in fields.allowed",
            }),
          );
        }
      }
      for (const field of required) {
        if (!mapping_fields.has(field)) {
          diagnostics.push(
            diagnostic(record, {
              code: "PROFILE_VIOLATION",
              rule_id: `${node_set_name}.fields.${field}.required`,
              node_set: declaration,
              violation: `required field ${field} is missing`,
              suggested_action: "provide the required field explicitly",
            }),
          );
        }
      }
      for (const [field, rule] of Object.entries(rules)) {
        const values = field_value_entries(
          record.entry,
          typed_string_field(field),
          record.input.addressable_index,
        );
        const cardinality = rule.cardinality;
        if (
          cardinality &&
          (values.length < cardinality.min || values.length > cardinality.max)
        ) {
          diagnostics.push(
            diagnostic(record, {
              code: "PROFILE_VIOLATION",
              rule_id: `${node_set_name}.fields.${field}.cardinality`,
              node_set: declaration,
              violation: `field ${field} has cardinality ${values.length}`,
              suggested_action: `provide between ${cardinality.min} and ${cardinality.max} values`,
            }),
          );
        }
        for (const value of values) {
          const value_type = entry_value_type(value);
          if (rule.types && !rule.types.includes(value_type)) {
            diagnostics.push(
              diagnostic(record, {
                code: "PROFILE_VIOLATION",
                rule_id: `${node_set_name}.fields.${field}.type`,
                node_set: declaration,
                location_entry: value,
                violation: `field ${field} has disallowed type ${value_type}`,
                suggested_action: `use one of: ${rule.types.join(", ")}`,
              }),
            );
          }
          if (rule.consistent_type) {
            const type_records = consistent_types.get(field) || [];
            type_records.push({ record, value, value_type });
            consistent_types.set(field, type_records);
          }
        }
      }
    }
    for (const [field, type_records] of consistent_types) {
      const types = new Set(type_records.map((record) => record.value_type));
      if (types.size <= 1) continue;
      for (const type_record of type_records) {
        diagnostics.push(
          diagnostic(type_record.record, {
            code: "PROFILE_VIOLATION",
            rule_id: `${node_set_name}.fields.${field}.consistent_type`,
            node_set: declaration,
            location_entry: type_record.value,
            violation: `field ${field} is not type-consistent in the node set`,
            suggested_action: "use one declared type consistently",
          }),
        );
      }
    }
  }
}

function node_membership_key(record) {
  return `${record.input.source_path}\0${record.entry.id}`;
}

function direct_child_nodes(entry, addressable_index) {
  if (entry.addressable_type !== "sequence") return [entry];
  return entry.child_ids
    .map((id) => addressable_index.by_id.get(id))
    .filter((child) => child && child.addressable_type === "sequence_item")
    .map((item) => contained_node(item, addressable_index))
    .filter(Boolean);
}

function validate_child_node_sets(node_sets, profile, diagnostics) {
  const membership = new Map(
    Object.entries(node_sets).map(([name, records]) => [
      name,
      new Set(records.map(node_membership_key)),
    ]),
  );
  for (const [node_set_name, records] of Object.entries(node_sets)) {
    const declaration = profile.node_sets[node_set_name];
    for (const [field, rule] of Object.entries(
      (declaration.fields && declaration.fields.rules) || {},
    )) {
      if (!rule.child_node_set) continue;
      const target_membership = membership.get(rule.child_node_set);
      for (const record of records) {
        const values = field_value_entries(
          record.entry,
          typed_string_field(field),
          record.input.addressable_index,
        );
        for (const value of values) {
          const children = direct_child_nodes(
            value,
            record.input.addressable_index,
          );
          for (const child of children) {
            const child_record = { input: record.input, entry: child };
            if (target_membership.has(node_membership_key(child_record)))
              continue;
            diagnostics.push(
              diagnostic(record, {
                code: "PROFILE_VIOLATION",
                rule_id: `${node_set_name}.fields.${field}.child_node_set`,
                node_set: declaration,
                location_entry: child,
                violation: `field ${field} contains a node outside ${rule.child_node_set}`,
                suggested_action:
                  "make the child satisfy the declared node set query",
              }),
            );
          }
        }
      }
    }
  }
}

function validate_field_aliases(node_sets, profile, diagnostics) {
  for (const rule of profile.field_aliases || []) {
    const declaration = profile.node_sets[rule.node_set];
    for (const record of node_sets[rule.node_set]) {
      for (const alias of rule.aliases) {
        const occurrences = fields_for_mapping(record).get(alias) || [];
        for (const occurrence of occurrences) {
          diagnostics.push(
            diagnostic(record, {
              code: "PROFILE_VIOLATION",
              severity: rule.severity,
              rule_id: rule.rule_id,
              node_set: declaration,
              location_entry: occurrence.key_node || occurrence.pair,
              violation: `field alias ${alias} is present instead of ${rule.canonical}`,
              suggested_action: `rename ${alias} to ${rule.canonical}`,
            }),
          );
        }
      }
    }
  }
}

function normalized_identity_field_path(field) {
  return Array.isArray(field) ? field : [field];
}

function identity_field_label(field) {
  return canonical_json(normalized_identity_field_path(field));
}

function identity_component(record, field) {
  const field_path = normalized_identity_field_path(field);
  let current = record.entry;
  let values = [];
  for (let index = 0; index < field_path.length; index += 1) {
    if (!current || current.addressable_type !== "mapping") {
      return { status: "non_scalar", value: current };
    }
    values = field_value_entries(
      current,
      typed_string_field(field_path[index]),
      record.input.addressable_index,
    );
    if (values.length !== 1) return { status: "missing", values };
    current = values[0];
  }
  const value = current;
  if (!value.scalar_type) return { status: "non_scalar", value };
  if (value.scalar_type === "null") return { status: "null", value };
  return {
    status: "value",
    value,
    typed: { type: value.scalar_type, value: value.scalar_value },
  };
}

function identity_scope_key(rule, record) {
  if (rule.unique_scope === "file") return record.input.source_path;
  if (rule.unique_scope === "document") {
    return `${record.input.source_path}\0${record.entry.document}`;
  }
  return "<input>";
}

function identity_location(record) {
  return canonical_json({
    file: record.input.source_path,
    document: record.entry.document,
    path: record.entry.path,
  });
}

function build_identity_instances(node_sets, profile, diagnostics, phase) {
  const instances = [];
  for (const rule of profile.identity || []) {
    const declaration = profile.node_sets[rule.node_set];
    for (const record of node_sets[rule.node_set]) {
      const components = rule.fields.map((field) =>
        identity_component(record, field),
      );
      let valid = true;
      components.forEach((component, index) => {
        const field = identity_field_label(rule.fields[index]);
        if (component.status === "missing") {
          valid = false;
          if (rule.missing_policy !== "allow" && phase === "candidate") {
            diagnostics.push(
              diagnostic(record, {
                code: "IDENTITY_VIOLATION",
                rule_id: rule.rule_id,
                node_set: declaration,
                violation: `identity field ${field} is missing`,
                suggested_action: "provide the identity value explicitly",
              }),
            );
          }
          return;
        }
        if (component.status === "null") {
          valid = false;
          if (rule.null_policy !== "allow" && phase === "candidate") {
            diagnostics.push(
              diagnostic(record, {
                code: "IDENTITY_VIOLATION",
                rule_id: rule.rule_id,
                node_set: declaration,
                location_entry: component.value,
                violation: `identity field ${field} is null`,
                suggested_action: "provide a non-null identity explicitly",
              }),
            );
          }
          return;
        }
        if (component.status === "non_scalar") {
          valid = false;
          if (phase === "candidate") {
            diagnostics.push(
              diagnostic(record, {
                code: "IDENTITY_VIOLATION",
                rule_id: rule.rule_id,
                node_set: declaration,
                location_entry: component.value,
                violation: `identity field ${field} is not scalar`,
                suggested_action: "use a scalar identity value",
              }),
            );
          }
          return;
        }
        if (rule.types && !rule.types.includes(component.typed.type)) {
          valid = false;
          if (phase === "candidate") {
            diagnostics.push(
              diagnostic(record, {
                code: "IDENTITY_VIOLATION",
                rule_id: rule.rule_id,
                node_set: declaration,
                location_entry: component.value,
                violation: `identity field ${field} has disallowed type ${component.typed.type}`,
                suggested_action: `use one of: ${rule.types.join(", ")}`,
              }),
            );
          }
        }
      });
      if (!valid) continue;
      const typed_values = components.map((component) => component.typed);
      instances.push({
        rule,
        record,
        typed_values,
        raw_values: typed_values.map((component) => component.value),
        identity_key: canonical_json({
          rule_id: rule.rule_id,
          values: typed_values,
        }),
        scope_key: identity_scope_key(rule, record),
        location_key: identity_location(record),
      });
    }
  }
  return instances;
}

function validate_identity_uniqueness(instances, profile, diagnostics) {
  const groups = new Map();
  for (const instance of instances) {
    const group_key = `${instance.scope_key}\0${instance.identity_key}`;
    const group = groups.get(group_key) || [];
    group.push(instance);
    groups.set(group_key, group);
  }
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    for (const instance of group) {
      diagnostics.push(
        diagnostic(instance.record, {
          code: "IDENTITY_VIOLATION",
          rule_id: instance.rule.rule_id,
          node_set: profile.node_sets[instance.rule.node_set],
          violation: "identity is not unique in its declared scope",
          suggested_action: "provide a unique explicit identity",
        }),
      );
    }
  }
}

function multimap(items, key_function) {
  const result = new Map();
  for (const item of items) {
    const key = key_function(item);
    const group = result.get(key) || [];
    group.push(item);
    result.set(key, group);
  }
  return result;
}

function compare_identity_instances(original, candidate, profile, diagnostics) {
  const changes = { added: 0, deleted: 0, modified: 0, affected: 0 };
  const original_by_location = multimap(
    original,
    (instance) => `${instance.rule.rule_id}\0${instance.location_key}`,
  );
  const candidate_by_location = multimap(
    candidate,
    (instance) => `${instance.rule.rule_id}\0${instance.location_key}`,
  );
  const consumed_original = new Set();
  const consumed_candidate = new Set();
  for (const [location_key, original_group] of original_by_location) {
    const candidate_group = candidate_by_location.get(location_key);
    if (original_group.length !== 1 || candidate_group?.length !== 1) continue;
    const before = original_group[0];
    const after = candidate_group[0];
    if (before.identity_key === after.identity_key) continue;
    consumed_original.add(before);
    consumed_candidate.add(after);
    changes.modified += 1;
    changes.affected += 1;
    if (before.rule.immutable_existing === true) {
      diagnostics.push(
        diagnostic(after.record, {
          code: "IDENTITY_VIOLATION",
          rule_id: before.rule.rule_id,
          node_set: profile.node_sets[before.rule.node_set],
          violation: "an existing non-null identity was modified",
          suggested_action: "preserve the existing identity value",
        }),
      );
    }
  }

  const remaining_original = original.filter(
    (instance) => !consumed_original.has(instance),
  );
  const remaining_candidate = candidate.filter(
    (instance) => !consumed_candidate.has(instance),
  );
  const before_by_key = multimap(
    remaining_original,
    (item) => item.identity_key,
  );
  const after_by_key = multimap(
    remaining_candidate,
    (item) => item.identity_key,
  );
  const all_keys = new Set([...before_by_key.keys(), ...after_by_key.keys()]);
  for (const key of all_keys) {
    const before = before_by_key.get(key) || [];
    const after = after_by_key.get(key) || [];
    const preserved = Math.min(before.length, after.length);
    const added = Math.max(0, after.length - before.length);
    const deleted = Math.max(0, before.length - after.length);
    changes.added += added;
    changes.deleted += deleted;
    if (added > 0 || deleted > 0) changes.affected += added + deleted;
    for (let index = 0; index < preserved; index += 1) {
      if (before[index].location_key !== after[index].location_key) {
        changes.affected += 1;
      }
    }
    for (const instance of before.slice(preserved)) {
      if (instance.rule.immutable_existing !== true) continue;
      diagnostics.push(
        diagnostic(instance.record, {
          code: "IDENTITY_VIOLATION",
          rule_id: instance.rule.rule_id,
          node_set: profile.node_sets[instance.rule.node_set],
          violation: "an existing non-null identity was deleted or omitted",
          suggested_action: "preserve the existing identity or prove a move",
        }),
      );
    }
  }
  return changes;
}

function normalize_provenance_identity(identity) {
  if (!Array.isArray(identity)) return null;
  return canonical_json(identity);
}

function provenance_source_record(source, records) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return null;
  }
  const has_locator =
    typeof source.locator === "string" && source.locator.length > 0;
  const has_path = Array.isArray(source.path);
  if (!has_locator && !has_path) return null;
  const requested_file =
    typeof source.file === "string" && source.file.length > 0
      ? path.resolve(source.file)
      : null;
  const requested_path = has_path ? canonical_json(source.path) : null;
  return (
    records.find((record) => {
      if (requested_file && record.input.source_path !== requested_file) {
        return false;
      }
      if (
        Object.hasOwn(source, "document") &&
        record.entry.document !== source.document
      ) {
        return false;
      }
      if (has_locator && record.entry.locator !== source.locator) return false;
      if (
        requested_path &&
        canonical_json(record.entry.path) !== requested_path
      ) {
        return false;
      }
      return true;
    }) || null
  );
}

function validate_protected_rules(
  original_node_sets,
  original_identities,
  candidate_identities,
  profile,
  provenance,
  diagnostics,
) {
  const candidate_keys = new Set(
    candidate_identities.map((identity) => identity.identity_key),
  );
  const original_identity_counts = new Map();
  const candidate_identity_counts = new Map();
  for (const identity of original_identities) {
    original_identity_counts.set(
      identity.identity_key,
      (original_identity_counts.get(identity.identity_key) || 0) + 1,
    );
  }
  for (const identity of candidate_identities) {
    candidate_identity_counts.set(
      identity.identity_key,
      (candidate_identity_counts.get(identity.identity_key) || 0) + 1,
    );
  }
  const identity_by_node_set = new Map();
  for (const identity of original_identities) {
    const group = identity_by_node_set.get(identity.rule.node_set) || [];
    group.push(identity);
    identity_by_node_set.set(identity.rule.node_set, group);
  }
  const candidate_by_location = new Map(
    candidate_identities.map((identity) => [
      `${identity.rule.rule_id}\0${identity.location_key}`,
      identity,
    ]),
  );
  for (const rule of profile.protected || []) {
    const declaration = profile.node_sets[rule.node_set];
    const original_records = original_node_sets[rule.node_set];
    const identities = identity_by_node_set.get(rule.node_set) || [];
    const identity_by_raw = new Map(
      identities.map((identity) => [
        canonical_json(identity.raw_values),
        identity,
      ]),
    );
    const protected_records = new Set();
    for (const record of original_records) {
      if (rule.when) {
        const matches = evaluate_predicate(record.entry, rule.when, {
          addressable_index: record.input.addressable_index,
          source_path: record.input.source_path,
          limits: {
            max_relation_visits: 1_000_000,
            max_regex_input_length: 1024 * 1024,
          },
          state: { relation_visits: 0 },
        });
        if (!matches) continue;
      }
      protected_records.add(node_membership_key(record));
    }
    for (const operation of provenance) {
      const action =
        operation.type === "delete"
          ? "delete"
          : operation.type === "copy"
            ? "copy"
            : operation.type === "identity_modify"
              ? "identity_modify"
              : null;
      if (!action || !rule.actions.includes(action)) continue;
      const raw_key = normalize_provenance_identity(
        operation.source && operation.source.identity,
      );
      const identity = raw_key ? identity_by_raw.get(raw_key) : null;
      const source_record =
        (identity && identity.record) ||
        provenance_source_record(operation.source, original_records);
      if (
        !source_record ||
        !protected_records.has(node_membership_key(source_record))
      ) {
        continue;
      }
      diagnostics.push(
        diagnostic(source_record, {
          code: "PROFILE_VIOLATION",
          rule_id: rule.rule_id,
          node_set: declaration,
          violation: `protected node forbids ${action}`,
          suggested_action: "remove the operation or change the profile rule",
        }),
      );
    }
    if (rule.actions.includes("identity_modify")) {
      for (const identity of identities) {
        if (!protected_records.has(node_membership_key(identity.record))) {
          continue;
        }
        const candidate = candidate_by_location.get(
          `${identity.rule.rule_id}\0${identity.location_key}`,
        );
        if (!candidate || candidate.identity_key === identity.identity_key) {
          continue;
        }
        diagnostics.push(
          diagnostic(candidate.record, {
            code: "PROFILE_VIOLATION",
            rule_id: rule.rule_id,
            node_set: declaration,
            violation: "protected node identity was modified",
            suggested_action: "preserve the protected identity",
          }),
        );
      }
    }
    if (rule.actions.includes("copy")) {
      const reported_identity = new Set();
      for (const identity of identities) {
        if (
          reported_identity.has(identity.identity_key) ||
          !protected_records.has(node_membership_key(identity.record))
        ) {
          continue;
        }
        reported_identity.add(identity.identity_key);
        const original_count =
          original_identity_counts.get(identity.identity_key) || 0;
        const candidate_count =
          candidate_identity_counts.get(identity.identity_key) || 0;
        if (candidate_count <= original_count) continue;
        diagnostics.push(
          diagnostic(identity.record, {
            code: "PROFILE_VIOLATION",
            rule_id: rule.rule_id,
            node_set: declaration,
            violation: "protected node was copied",
            suggested_action: "remove the copy of the protected node",
          }),
        );
      }
    }
    if (!rule.actions.includes("delete")) continue;
    for (const identity of identities) {
      if (
        protected_records.has(node_membership_key(identity.record)) &&
        !candidate_keys.has(identity.identity_key)
      ) {
        diagnostics.push(
          diagnostic(identity.record, {
            code: "PROFILE_VIOLATION",
            rule_id: rule.rule_id,
            node_set: declaration,
            violation: "protected node was deleted",
            suggested_action: "preserve the protected node",
          }),
        );
      }
    }
  }
}

function predicate_uses_raw_regex(predicate) {
  const pending = [predicate];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (current.predicate === "raw_regex") return true;
    if (Array.isArray(current.all)) pending.push(...current.all);
    if (Array.isArray(current.any)) pending.push(...current.any);
    if (current.not) pending.push(current.not);
    if (current.predicate === "relation" && current.where) {
      pending.push(current.where);
    }
  }
  return false;
}

function reject_unbounded_profile_regex(profile) {
  for (const rule of profile.protected || []) {
    if (rule.when && predicate_uses_raw_regex(rule.when)) {
      throw new Yaml_patch_error(
        "CHANGE_LIMIT_EXCEEDED",
        "profile raw_regex execution requires an isolated worker",
        {
          details: {
            limit_name: "profile_raw_regex_execution",
            rule_id: rule.rule_id,
            required_execution: "isolated_worker",
          },
        },
      );
    }
  }
}

function validate_identity_limits(changes, limits = {}) {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    profile_error("profile validation limits must be an object");
  }
  for (const field of Object.keys(limits)) {
    if (
      !IDENTITY_LIMIT_FIELDS.includes(field) &&
      !GRAPH_LIMIT_FIELDS.includes(field)
    ) {
      profile_error(`Unknown profile validation limit: ${field}`);
    }
    if (GRAPH_LIMIT_FIELDS.includes(field)) continue;
    if (!Number.isSafeInteger(limits[field]) || limits[field] < 0) {
      profile_error(`${field} must be a non-negative integer`);
    }
    const change_name = field.slice("max_".length, -"_identity".length);
    if (changes[change_name] > limits[field]) {
      throw new Yaml_patch_error(
        "CHANGE_LIMIT_EXCEEDED",
        `Identity change count exceeds ${field}`,
        {
          details: {
            limit_name: field,
            limit: limits[field],
            actual: changes[change_name],
          },
        },
      );
    }
  }
}

function sort_diagnostics(diagnostics) {
  return diagnostics.sort((left, right) => {
    for (const field of [
      "file",
      "document",
      "line",
      "column",
      "rule_id",
      "code",
    ]) {
      if (left[field] === right[field]) continue;
      return left[field] < right[field] ? -1 : 1;
    }
    const left_path = canonical_json(left.path);
    const right_path = canonical_json(right.path);
    return left_path === right_path ? 0 : left_path < right_path ? -1 : 1;
  });
}

function validate_profile_candidates(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    profile_error("profile validation request must be an object");
  }
  assert_known_fields(
    input,
    VALIDATION_REQUEST_FIELDS,
    "profile validation request",
    "VALIDATION_FAILED",
  );
  const profile_result = validate_profile(input.profile);
  const profile = profile_result.profile;
  reject_unbounded_profile_regex(profile);
  const normalized_scope = normalize_validation_scope(
    input.scope || { kind: "all_inputs" },
  );
  const options = input.options || {};
  assert_known_fields(
    options,
    VALIDATION_OPTION_FIELDS,
    "profile validation options",
    "VALIDATION_FAILED",
  );
  if (
    Object.hasOwn(options, "require_complete") &&
    typeof options.require_complete !== "boolean"
  ) {
    profile_error("require_complete must be boolean");
  }
  if (
    Object.hasOwn(options, "root_path") &&
    (typeof options.root_path !== "string" || options.root_path.length === 0)
  ) {
    profile_error("root_path must be a non-empty string");
  }
  const max_result =
    options.max_profile_result === undefined
      ? DEFAULT_MAX_PROFILE_RESULT
      : options.max_profile_result;
  if (!Number.isSafeInteger(max_result) || max_result < 1) {
    profile_error("max_profile_result must be a positive integer");
  }
  const original_all = normalize_inputs(
    input.original_inputs || [],
    "original_inputs",
  );
  const candidate_all = normalize_inputs(
    input.candidate_inputs || [],
    "candidate_inputs",
  );
  const original_inputs = apply_profile_path_scope(
    original_all,
    profile,
    options,
  );
  const candidate_inputs = apply_profile_path_scope(
    candidate_all,
    profile,
    options,
  );
  const original_node_sets_full = build_node_sets(
    original_inputs,
    profile,
    max_result,
  );
  const candidate_node_sets_full = build_node_sets(
    candidate_inputs,
    profile,
    max_result,
  );
  const decision = scope_decision(
    normalized_scope,
    candidate_inputs,
    options.require_complete === true,
  );
  const original_node_sets = filter_node_sets(
    original_node_sets_full,
    decision.effective_scope,
    decision.validated_paths,
  );
  const candidate_node_sets = filter_node_sets(
    candidate_node_sets_full,
    decision.effective_scope,
    decision.validated_paths,
  );
  const diagnostics = [];
  validate_field_rules(candidate_node_sets, profile, diagnostics);
  validate_child_node_sets(candidate_node_sets, profile, diagnostics);
  validate_field_aliases(candidate_node_sets, profile, diagnostics);
  const original_identities = build_identity_instances(
    original_node_sets,
    profile,
    diagnostics,
    "original",
  );
  const candidate_identities = build_identity_instances(
    candidate_node_sets,
    profile,
    diagnostics,
    "candidate",
  );
  const all_candidate_identities = build_identity_instances(
    candidate_node_sets_full,
    profile,
    [],
    "original",
  );
  validate_identity_uniqueness(candidate_identities, profile, diagnostics);
  const identity_changes = compare_identity_instances(
    original_identities,
    candidate_identities,
    profile,
    diagnostics,
  );
  const provenance = clone_json_value(
    input.operation_provenance || [],
    "operation provenance",
  );
  if (!Array.isArray(provenance)) {
    profile_error("operation_provenance must be an array");
  }
  validate_protected_rules(
    original_node_sets,
    original_identities,
    candidate_identities,
    profile,
    provenance,
    diagnostics,
  );
  const reference_result = validate_profile_references({
    profile,
    source_node_sets: candidate_node_sets,
    all_node_sets: candidate_node_sets_full,
    identities: all_candidate_identities,
    diagnostic,
    diagnostics,
    limits: input.limits || {},
  });
  validate_identity_limits(identity_changes, input.limits || {});
  return {
    profile_digest: profile_result.profile_digest,
    scope: normalized_scope,
    scope_report: decision.scope_report,
    diagnostics: sort_diagnostics(diagnostics),
    identity_changes,
    reference_summary: reference_result.reference_summary,
  };
}

module.exports = {
  DEFAULT_MAX_PROFILE_RESULT,
  IDENTITY_LIMIT_FIELDS,
  validate_profile_candidates,
};
