"use strict";

const { canonical_json, clone_json_value } = require("./artifact_version");
const { Yaml_patch_error } = require("./error");
const { contained_node, field_value_entries } = require("./query_predicate");

const DEFAULT_GRAPH_LIMITS = Object.freeze({
  max_graph_node: 100_000,
  max_graph_edge: 500_000,
  max_graph_visit: 1_000_000,
  max_graph_time_ms: 5_000,
});
const GRAPH_LIMIT_FIELDS = Object.freeze(Object.keys(DEFAULT_GRAPH_LIMITS));

function limit_error(limit_name, limit, actual) {
  throw new Yaml_patch_error(
    "CHANGE_LIMIT_EXCEEDED",
    `Profile graph exceeds ${limit_name}`,
    { details: { limit_name, limit, actual } },
  );
}

function normalize_graph_limits(limits = {}) {
  const result = { ...DEFAULT_GRAPH_LIMITS };
  for (const field of GRAPH_LIMIT_FIELDS) {
    if (!Object.hasOwn(limits, field)) continue;
    if (!Number.isSafeInteger(limits[field]) || limits[field] < 0) {
      throw new Yaml_patch_error(
        "VALIDATION_FAILED",
        `${field} must be a non-negative integer`,
      );
    }
    result[field] = limits[field];
  }
  return result;
}

function typed_string_field(field_name) {
  return { key: { type: "string", value: field_name } };
}

function normalized_field_path(field) {
  return Array.isArray(field) ? field : [field];
}

function resolve_field(record, field) {
  let current = record.entry;
  for (const segment of normalized_field_path(field)) {
    if (!current || current.addressable_type !== "mapping") {
      return { status: "wrong_shape", value: current };
    }
    const values = field_value_entries(
      current,
      typed_string_field(segment),
      record.input.addressable_index,
    );
    if (values.length === 0) return { status: "missing", values };
    if (values.length !== 1) return { status: "wrong_shape", values };
    current = values[0];
  }
  return { status: "value", value: current };
}

function sequence_items(entry, addressable_index) {
  if (!entry || entry.addressable_type !== "sequence") return null;
  return entry.child_ids
    .map((id) => addressable_index.by_id.get(id))
    .filter((child) => child && child.addressable_type === "sequence_item")
    .map((item) => contained_node(item, addressable_index))
    .filter(Boolean);
}

function typed_component(entry) {
  if (!entry || !entry.scalar_type) return null;
  return { type: entry.scalar_type, value: entry.scalar_value };
}

function decode_reference_value(entry, target_identity, addressable_index) {
  const component_count = target_identity.fields.length;
  if (component_count === 1) {
    const component = typed_component(entry);
    return component
      ? { status: "value", components: [component] }
      : {
          status: "wrong_shape",
        };
  }
  const items = sequence_items(entry, addressable_index);
  if (!items || items.length !== component_count) {
    return { status: "wrong_shape" };
  }
  const components = items.map(typed_component);
  if (components.some((component) => component === null)) {
    return { status: "wrong_shape" };
  }
  return { status: "value", components };
}

function reference_entries(record, rule) {
  const field = resolve_field(record, rule.source_field);
  if (field.status !== "value") return { status: field.status, entries: [] };
  if (rule.cardinality.kind === "scalar") {
    return { status: "value", entries: [field.value], location: field.value };
  }
  const entries = sequence_items(field.value, record.input.addressable_index);
  return entries
    ? { status: "value", entries, location: field.value }
    : { status: "wrong_shape", entries: [], location: field.value };
}

function target_scope_matches(rule, source_record, target_identity) {
  if (rule.resolution_scope === "file") {
    return (
      source_record.input.source_path ===
      target_identity.record.input.source_path
    );
  }
  if (rule.resolution_scope === "document") {
    return (
      source_record.input.source_path ===
        target_identity.record.input.source_path &&
      source_record.entry.document === target_identity.record.entry.document
    );
  }
  return true;
}

function identity_key(rule_id, components) {
  return canonical_json({ rule_id, values: components });
}

function identity_record_key(rule_id, record) {
  return `${rule_id}\0${record.input.source_path}\0${record.entry.id}`;
}

function validate_reference_rule(context, rule, summary, edges) {
  const target_identity_rule = context.identity_by_id.get(rule.target_identity);
  const target_candidates =
    context.target_identity_index.get(rule.target_identity) || new Map();
  for (const record of context.source_node_sets[rule.source_node_set] || []) {
    const extracted = reference_entries(record, rule);
    if (extracted.status === "wrong_shape") {
      summary.invalid_type += 1;
      context.diagnostics.push(
        context.diagnostic(record, {
          code: "REFERENCE_VIOLATION",
          rule_id: rule.rule_id,
          node_set: context.profile.node_sets[rule.source_node_set],
          location_entry: extracted.location,
          violation: "reference field has the wrong structural shape",
          suggested_action: `use a ${rule.cardinality.kind} reference field`,
        }),
      );
      continue;
    }
    const actual_count = extracted.entries.length;
    if (
      actual_count < rule.cardinality.min ||
      actual_count > rule.cardinality.max
    ) {
      context.diagnostics.push(
        context.diagnostic(record, {
          code: "REFERENCE_VIOLATION",
          rule_id: rule.rule_id,
          node_set: context.profile.node_sets[rule.source_node_set],
          location_entry: extracted.location,
          violation: `reference cardinality is ${actual_count}`,
          suggested_action: `provide between ${rule.cardinality.min} and ${rule.cardinality.max} references`,
        }),
      );
    }
    const source_identity = context.source_identity_index.get(
      identity_record_key(rule.source_identity, record),
    );
    const seen_values = new Set();
    for (const entry of extracted.entries) {
      if (entry.scalar_type === "null") {
        if (rule.null_policy === "error") {
          context.diagnostics.push(
            context.diagnostic(record, {
              code: "REFERENCE_VIOLATION",
              rule_id: rule.rule_id,
              node_set: context.profile.node_sets[rule.source_node_set],
              location_entry: entry,
              violation: "null reference is not allowed",
              suggested_action:
                "provide a non-null reference or change null_policy",
            }),
          );
        }
        continue;
      }
      const decoded = decode_reference_value(
        entry,
        target_identity_rule,
        record.input.addressable_index,
      );
      if (
        decoded.status === "value" &&
        decoded.components.some((component) => component.type === "null")
      ) {
        if (rule.null_policy === "error") {
          context.diagnostics.push(
            context.diagnostic(record, {
              code: "REFERENCE_VIOLATION",
              rule_id: rule.rule_id,
              node_set: context.profile.node_sets[rule.source_node_set],
              location_entry: entry,
              violation: "null reference component is not allowed",
              suggested_action:
                "provide non-null identity components or change null_policy",
            }),
          );
        }
        continue;
      }
      if (
        decoded.status !== "value" ||
        decoded.components.some(
          (component) =>
            target_identity_rule.types &&
            !target_identity_rule.types.includes(component.type),
        )
      ) {
        summary.invalid_type += 1;
        context.diagnostics.push(
          context.diagnostic(record, {
            code: "REFERENCE_VIOLATION",
            rule_id: rule.rule_id,
            node_set: context.profile.node_sets[rule.source_node_set],
            location_entry: entry,
            violation: "reference type does not match target identity",
            suggested_action:
              "use the target identity component types and shape",
          }),
        );
        continue;
      }
      const desired_key = identity_key(
        rule.target_identity,
        decoded.components,
      );
      if (rule.unique_values && seen_values.has(desired_key)) {
        summary.duplicate += 1;
        context.diagnostics.push(
          context.diagnostic(record, {
            code: "REFERENCE_VIOLATION",
            rule_id: rule.rule_id,
            node_set: context.profile.node_sets[rule.source_node_set],
            location_entry: entry,
            violation: "reference field contains a duplicate value",
            suggested_action: "remove duplicate reference values",
          }),
        );
      }
      seen_values.add(desired_key);
      const targets = (target_candidates.get(desired_key) || []).filter(
        (identity) =>
          identity.identity_key === desired_key &&
          target_scope_matches(rule, record, identity),
      );
      if (targets.length === 0) {
        summary.missing += 1;
        context.diagnostics.push(
          context.diagnostic(record, {
            code: "REFERENCE_VIOLATION",
            rule_id: rule.rule_id,
            node_set: context.profile.node_sets[rule.source_node_set],
            location_entry: entry,
            violation: "reference target does not exist",
            suggested_action: "create the target or update the reference",
          }),
        );
        continue;
      }
      if (targets.length > 1) {
        summary.non_unique += 1;
        context.diagnostics.push(
          context.diagnostic(record, {
            code: "REFERENCE_VIOLATION",
            rule_id: rule.rule_id,
            node_set: context.profile.node_sets[rule.source_node_set],
            location_entry: entry,
            violation: "reference target is not unique",
            suggested_action: "make the target identity unique",
          }),
        );
        continue;
      }
      summary.resolved += 1;
      if (source_identity) {
        edges.push({
          from: source_identity.identity_key,
          to: targets[0].identity_key,
          source_identity,
          target_identity: targets[0],
          record,
          entry,
          rule_id: rule.rule_id,
        });
        if (edges.length > context.graph_limits.max_graph_edge) {
          limit_error(
            "max_graph_edge",
            context.graph_limits.max_graph_edge,
            edges.length,
          );
        }
      }
    }
  }
}

function compare_edges(left, right) {
  for (const field of ["from", "to", "rule_id"]) {
    if (left[field] === right[field]) continue;
    return left[field] < right[field] ? -1 : 1;
  }
  return left.entry.source.start_byte - right.entry.source.start_byte;
}

function find_cycle(edges, limits) {
  if (limits.max_graph_time_ms === 0 && edges.length > 0) {
    limit_error("max_graph_time_ms", 0, 1);
  }
  const deadline = Date.now() + limits.max_graph_time_ms;
  const adjacency = new Map();
  const nodes = new Set();
  for (const edge of edges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
    const group = adjacency.get(edge.from) || [];
    group.push(edge);
    adjacency.set(edge.from, group);
  }
  if (nodes.size > limits.max_graph_node) {
    limit_error("max_graph_node", limits.max_graph_node, nodes.size);
  }
  if (edges.length > limits.max_graph_edge) {
    limit_error("max_graph_edge", limits.max_graph_edge, edges.length);
  }
  for (const group of adjacency.values()) group.sort(compare_edges);
  const color = new Map();
  let visits = 0;
  for (const start of [...nodes].sort()) {
    if (color.get(start)) continue;
    const stack = [{ node: start, edge_index: 0, incoming: null }];
    const path_index = new Map();
    color.set(start, "gray");
    path_index.set(start, 0);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const outgoing = adjacency.get(frame.node) || [];
      if (frame.edge_index >= outgoing.length) {
        color.set(frame.node, "black");
        path_index.delete(frame.node);
        stack.pop();
        continue;
      }
      const edge = outgoing[frame.edge_index];
      frame.edge_index += 1;
      visits += 1;
      if (visits > limits.max_graph_visit) {
        limit_error("max_graph_visit", limits.max_graph_visit, visits);
      }
      if (Date.now() > deadline) {
        limit_error(
          "max_graph_time_ms",
          limits.max_graph_time_ms,
          Date.now() - (deadline - limits.max_graph_time_ms),
        );
      }
      const target_color = color.get(edge.to);
      if (target_color === "gray") {
        const start_index = path_index.get(edge.to);
        const cycle_frames = stack.slice(start_index);
        const cycle_edges = cycle_frames
          .slice(1)
          .map((cycle_frame) => cycle_frame.incoming)
          .concat(edge);
        return {
          nodes: cycle_frames
            .map((cycle_frame) => cycle_frame.node)
            .concat(edge.to),
          edges: cycle_edges,
        };
      }
      if (target_color) continue;
      color.set(edge.to, "gray");
      path_index.set(edge.to, stack.length);
      stack.push({ node: edge.to, edge_index: 0, incoming: edge });
    }
  }
  return null;
}

function cycle_projection(cycle) {
  return {
    cycle_path: cycle.edges
      .map((edge) =>
        clone_json_value(edge.source_identity.raw_values, "cycle identity"),
      )
      .concat([
        clone_json_value(
          cycle.edges[0].source_identity.raw_values,
          "cycle identity",
        ),
      ]),
    edges: cycle.edges.map((edge) => ({
      rule_id: edge.rule_id,
      file: edge.record.input.source_path,
      document: edge.entry.document,
      line: edge.entry.source.line,
      column: edge.entry.source.column,
      path: clone_json_value(edge.entry.path, "cycle edge path"),
    })),
  };
}

function validate_graph_rules(context, edges) {
  const limits = normalize_graph_limits(context.limits);
  for (const graph of context.profile.graphs || []) {
    if (!graph.acyclic) continue;
    const selected_rules = new Set(graph.reference_rules);
    const selected_edges = edges.filter((edge) =>
      selected_rules.has(edge.rule_id),
    );
    const cycle = find_cycle(selected_edges, limits);
    if (!cycle) continue;
    const first = cycle.edges[0];
    context.diagnostics.push(
      context.diagnostic(first.record, {
        code: "CYCLE_DETECTED",
        rule_id: graph.rule_id,
        node_set:
          context.profile.node_sets[
            context.reference_by_id.get(first.rule_id).source_node_set
          ],
        location_entry: first.entry,
        projection: cycle_projection(cycle),
        violation: "directed reference graph contains a cycle",
        suggested_action: "remove or redirect one edge in the reported cycle",
      }),
    );
  }
}

function validate_profile_references(context) {
  const summary = {
    resolved: 0,
    missing: 0,
    non_unique: 0,
    duplicate: 0,
    invalid_type: 0,
  };
  const edges = [];
  const identity_by_id = new Map(
    (context.profile.identity || []).map((rule) => [rule.rule_id, rule]),
  );
  const reference_by_id = new Map(
    (context.profile.references || []).map((rule) => [rule.rule_id, rule]),
  );
  const target_identity_index = new Map();
  const source_identity_index = new Map();
  for (const identity of context.identities) {
    let by_key = target_identity_index.get(identity.rule.rule_id);
    if (!by_key) {
      by_key = new Map();
      target_identity_index.set(identity.rule.rule_id, by_key);
    }
    const group = by_key.get(identity.identity_key) || [];
    group.push(identity);
    by_key.set(identity.identity_key, group);
    source_identity_index.set(
      identity_record_key(identity.rule.rule_id, identity.record),
      identity,
    );
  }
  const full_context = {
    ...context,
    identity_by_id,
    reference_by_id,
    target_identity_index,
    source_identity_index,
    graph_limits: normalize_graph_limits(context.limits),
  };
  for (const rule of context.profile.references || []) {
    validate_reference_rule(full_context, rule, summary, edges);
  }
  validate_graph_rules(full_context, edges);
  return { reference_summary: summary, reference_edges: edges };
}

module.exports = {
  DEFAULT_GRAPH_LIMITS,
  GRAPH_LIMIT_FIELDS,
  validate_profile_references,
};
