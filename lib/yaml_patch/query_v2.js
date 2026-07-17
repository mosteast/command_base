"use strict";

const path = require("node:path");

const {
  build_addressable_index,
  resolve_alias_target,
} = require("./addressable");
const { validate_addressable_index_binding } = require("./addressable_graph");
const { canonical_json, clone_json_value } = require("./artifact_version");
const { Yaml_patch_error } = require("./error");
const {
  contained_node,
  evaluate_predicate,
  field_value_entries,
  pair_relationship,
  validate_field_locator,
  validate_predicate,
} = require("./query_predicate");
const { project_query_results, validate_projection } = require("./projection");
const { create_query_cursor, decode_query_cursor } = require("./query_cursor");
const { sha256_digest } = require("./source");

const QUERY_FIELDS = new Set([
  "version",
  "where",
  "select",
  "projection",
  "resolve_alias",
  "expect_matches",
  "page",
  "limits",
]);
const LIMIT_FIELDS = new Set([
  "max_result",
  "max_output_bytes",
  "max_regex_pattern_length",
  "max_regex_input_length",
  "max_relation_visits",
]);
const DEFAULT_QUERY_LIMITS = Object.freeze({
  max_result: 1000,
  max_output_bytes: 4 * 1024 * 1024,
  max_regex_pattern_length: 4096,
  max_regex_input_length: 1024 * 1024,
  max_relation_visits: 1_000_000,
});
const DEFAULT_QUERY_CLONE_LIMITS = Object.freeze({
  max_nodes: 10_000,
  max_depth: 128,
  max_array_items: 5_000,
});

function request_error(message, details = {}) {
  throw new Yaml_patch_error("REQUEST_ERROR", message, { details });
}

function clone_query(query) {
  try {
    return clone_json_value(query, "query", DEFAULT_QUERY_CLONE_LIMITS);
  } catch (error) {
    if (error && error.code === "VALIDATION_FAILED") {
      request_error("Query must contain only plain JSON data", {
        reason: error.message,
      });
    }
    throw error;
  }
}

function validate_limits(limits = {}) {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    request_error("Query limits must be an object");
  }
  for (const field of Object.keys(limits)) {
    if (!LIMIT_FIELDS.has(field)) {
      request_error(`Unknown query limit: ${field}`, { field });
    }
    const minimum = ["max_result", "max_output_bytes"].includes(field) ? 1 : 0;
    if (!Number.isSafeInteger(limits[field]) || limits[field] < minimum) {
      request_error(`Query limit ${field} must be an integer >= ${minimum}`);
    }
  }
  return { ...DEFAULT_QUERY_LIMITS, ...limits };
}

function validate_select(select) {
  if (!select || typeof select !== "object" || Array.isArray(select)) {
    request_error("Query select must be an object");
  }
  const allowed_by_kind = {
    self: new Set(["kind", "missing"]),
    parent: new Set(["kind", "missing"]),
    ancestor: new Set(["kind", "missing", "levels"]),
    mapping_key: new Set(["kind", "missing"]),
    mapping_value: new Set(["kind", "missing"]),
    field: new Set(["kind", "missing", "field"]),
    children: new Set(["kind", "missing"]),
    siblings: new Set(["kind", "missing", "include_self"]),
  };
  const allowed = allowed_by_kind[select.kind];
  if (!allowed) request_error(`Unsupported select kind: ${select.kind}`);
  for (const field of Object.keys(select)) {
    if (!allowed.has(field))
      request_error(`Unknown select field: ${field}`, { field });
  }
  if (!["omit", "error"].includes(select.missing)) {
    request_error("Select missing must be omit or error");
  }
  if (select.kind === "ancestor") {
    if (!Number.isSafeInteger(select.levels) || select.levels <= 0) {
      request_error("Select ancestor levels must be a positive integer");
    }
  }
  if (select.kind === "field") {
    if (!Object.hasOwn(select, "field"))
      request_error("Select field requires field");
    validate_field_locator(select.field, "select field locator");
  }
  if (
    select.kind === "siblings" &&
    Object.hasOwn(select, "include_self") &&
    typeof select.include_self !== "boolean"
  ) {
    request_error("Select siblings include_self must be boolean");
  }
  return select;
}

function normalize_expect_matches(value, mode = "read", options = {}) {
  if (!["read", "write_single", "write_batch"].includes(mode)) {
    request_error(`Unsupported expectation mode: ${mode}`);
  }
  if (value === undefined) {
    if (mode === "read") return undefined;
    if (mode === "write_single") return { exact: 1, min: 1, max: 1 };
    request_error("write_batch requires an explicit bounded expectation");
  }
  let normalized;
  if (Number.isSafeInteger(value) && value >= 0) {
    normalized = { exact: value, min: value, max: value };
  } else {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      request_error("expect_matches must be a non-negative integer or object");
    }
    const keys = Object.keys(value);
    const exact_form = keys.length === 1 && keys[0] === "exact";
    const range_form =
      keys.length === 2 && keys.includes("min") && keys.includes("max");
    if (!exact_form && !range_form) {
      request_error("expect_matches must use {exact} or {min,max}");
    }
    for (const field of keys) {
      if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
        request_error(`expect_matches.${field} must be non-negative`);
      }
    }
    if (exact_form) {
      normalized = { exact: value.exact, min: value.exact, max: value.exact };
    } else {
      if (value.min > value.max)
        request_error("expect_matches min must not exceed max");
      normalized = { min: value.min, max: value.max };
    }
  }
  if (mode === "write_batch") {
    if (!Object.hasOwn(options, "max_result")) {
      request_error("write_batch requires an explicit max_result limit");
    }
    if (!Number.isSafeInteger(normalized.max)) {
      request_error("write_batch expectation requires a finite maximum");
    }
  }
  return normalized;
}

function assert_match_expectation(match_count, expectation, diagnostics = {}) {
  if (expectation === undefined) return match_count;
  if (match_count >= expectation.min && match_count <= expectation.max) {
    return match_count;
  }
  const code =
    match_count === 0 && expectation.min > 0
      ? "NO_MATCH"
      : expectation.exact === 1 && match_count > 1
        ? "AMBIGUOUS_MATCH"
        : "EXPECTATION_FAILED";
  const candidates = Array.isArray(diagnostics.candidates)
    ? diagnostics.candidates.slice(0, 10)
    : [];
  throw new Yaml_patch_error(code, `Query matched ${match_count} results`, {
    recoverable: true,
    next_action: "refine the query or update expect_matches",
    details: {
      match_count,
      expectation,
      candidates,
      truncated:
        Boolean(diagnostics.truncated) ||
        (Array.isArray(diagnostics.candidates) &&
          diagnostics.candidates.length > candidates.length),
      cursor: diagnostics.cursor ?? null,
    },
  });
}

function validate_page(page, limits) {
  if (page === undefined) return { limit: limits.max_result };
  if (!page || typeof page !== "object" || Array.isArray(page)) {
    request_error("Query page must be an object");
  }
  for (const field of Object.keys(page)) {
    if (!["limit", "cursor"].includes(field)) {
      request_error(`Unknown query page field: ${field}`, { field });
    }
  }
  if (!Number.isSafeInteger(page.limit) || page.limit <= 0) {
    request_error("Query page limit must be a positive integer");
  }
  if (
    Object.hasOwn(page, "cursor") &&
    (typeof page.cursor !== "string" || page.cursor.length === 0)
  ) {
    request_error("Query page cursor must be a non-empty string");
  }
  return page;
}

function validate_regex_lengths(predicate, max_length) {
  if (Object.hasOwn(predicate, "all")) {
    predicate.all.forEach((child) => validate_regex_lengths(child, max_length));
  } else if (Object.hasOwn(predicate, "any")) {
    predicate.any.forEach((child) => validate_regex_lengths(child, max_length));
  } else if (Object.hasOwn(predicate, "not")) {
    validate_regex_lengths(predicate.not, max_length);
  } else {
    if (
      predicate.predicate === "raw_regex" &&
      predicate.pattern.length > max_length
    ) {
      throw new Yaml_patch_error(
        "CHANGE_LIMIT_EXCEEDED",
        "Regex pattern exceeds max_regex_pattern_length",
        {
          details: {
            limit_name: "max_regex_pattern_length",
            limit: max_length,
            actual: predicate.pattern.length,
          },
        },
      );
    }
    if (predicate.predicate === "relation") {
      validate_regex_lengths(predicate.where, max_length);
    }
  }
}

function validate_query_v2(query, options = {}) {
  const cloned = clone_query(query);
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
    request_error("Query must be an object");
  }
  if (cloned.version !== 2) {
    throw new Yaml_patch_error(
      "PROTOCOL_VERSION_UNSUPPORTED",
      `Unsupported query version: ${cloned.version}`,
      { details: { kind: "query", version: cloned.version } },
    );
  }
  for (const field of Object.keys(cloned)) {
    if (!QUERY_FIELDS.has(field)) {
      request_error(`Unknown query field: ${field}`, { field });
    }
  }
  if (!cloned.projection) request_error("Query projection is required");
  validate_projection(cloned.projection);
  const limits = validate_limits(cloned.limits);
  const where = cloned.where === undefined ? { all: [] } : cloned.where;
  validate_predicate(where);
  validate_regex_lengths(where, limits.max_regex_pattern_length);
  const select_input = cloned.select === undefined ? {} : cloned.select;
  if (
    !select_input ||
    typeof select_input !== "object" ||
    Array.isArray(select_input)
  ) {
    request_error("Query select must be an object");
  }
  const select = {
    kind: "self",
    missing: "error",
    ...select_input,
  };
  validate_select(select);
  const resolve_alias =
    cloned.resolve_alias === undefined ? "preserve" : cloned.resolve_alias;
  if (!["preserve", "target"].includes(resolve_alias)) {
    request_error("Query resolve_alias must be preserve or target");
  }
  const mode = options.mode === undefined ? "read" : options.mode;
  const explicit_limits = cloned.limits === undefined ? {} : cloned.limits;
  const expect_matches = normalize_expect_matches(
    cloned.expect_matches,
    mode,
    explicit_limits,
  );
  const page = validate_page(cloned.page, limits);
  return {
    ...cloned,
    where,
    select,
    resolve_alias,
    limits,
    ...(expect_matches === undefined ? {} : { expect_matches }),
    page,
  };
}

function record_for(entry, source_record) {
  return {
    entry,
    index: source_record.index,
    addressable_index: source_record.addressable_index,
    source_path: source_record.source_path,
    source_digest: source_record.index.source.digest,
  };
}

function mapping_pair_for_entry(entry, addressable_index) {
  if (entry.addressable_type === "mapping_pair") return entry;
  const parent = addressable_index.by_id.get(entry.parent_id);
  if (!parent) return null;
  if (parent.addressable_type === "mapping_pair") return parent;
  if (["mapping_key", "mapping_value"].includes(parent.addressable_type)) {
    return addressable_index.by_id.get(parent.parent_id) || null;
  }
  if (["mapping_key", "mapping_value"].includes(entry.addressable_type)) {
    return parent.addressable_type === "mapping_pair" ? parent : null;
  }
  return null;
}

function selected_mapping_node(record, relationship_type) {
  const pair = mapping_pair_for_entry(record.entry, record.addressable_index);
  if (!pair) return [];
  const relationship = pair_relationship(
    pair,
    relationship_type,
    record.addressable_index,
  );
  const node = contained_node(relationship, record.addressable_index);
  return node ? [record_for(node, record)] : [];
}

function select_one(record, select) {
  const { entry, addressable_index } = record;
  if (select.kind === "self") return [record];
  if (select.kind === "parent") {
    const parent = addressable_index.by_id.get(entry.parent_id);
    return parent ? [record_for(parent, record)] : [];
  }
  if (select.kind === "ancestor") {
    let ancestor = entry;
    for (let level = 0; level < select.levels; level += 1) {
      ancestor = addressable_index.by_id.get(ancestor.parent_id);
      if (!ancestor) return [];
    }
    return [record_for(ancestor, record)];
  }
  if (select.kind === "mapping_key") {
    return selected_mapping_node(record, "mapping_key");
  }
  if (select.kind === "mapping_value") {
    return selected_mapping_node(record, "mapping_value");
  }
  if (select.kind === "field") {
    return field_value_entries(entry, select.field, addressable_index).map(
      (value) => record_for(value, record),
    );
  }
  if (select.kind === "children") {
    return entry.child_ids
      .map((id) => addressable_index.by_id.get(id))
      .filter(Boolean)
      .map((child) => record_for(child, record));
  }
  const sibling_entry = entry;
  const parent = addressable_index.by_id.get(entry.parent_id);
  if (!parent) return [];
  return parent.child_ids
    .map((id) => addressable_index.by_id.get(id))
    .filter(
      (candidate) =>
        candidate &&
        (select.include_self === true || candidate.id !== sibling_entry.id),
    )
    .map((candidate) => record_for(candidate, record));
}

function compare_records(left, right) {
  if (left.source_path !== right.source_path) {
    return left.source_path < right.source_path ? -1 : 1;
  }
  if (left.source_digest !== right.source_digest) {
    return left.source_digest < right.source_digest ? -1 : 1;
  }
  return (
    (left.entry.document ?? -1) - (right.entry.document ?? -1) ||
    left.entry.source.start_byte - right.entry.source.start_byte ||
    left.entry.ordinal - right.entry.ordinal ||
    left.entry.id - right.entry.id
  );
}

function select_query_results(results, select) {
  const selected = [];
  for (const record of results) {
    const targets = select_one(record, select);
    if (targets.length === 0 && select.missing === "error") {
      throw new Yaml_patch_error(
        "NO_MATCH",
        `Select ${select.kind} has no target`,
        {
          recoverable: true,
          details: { select, locator: record.entry.locator },
        },
      );
    }
    for (const target of targets) {
      if (record.alias_resolution)
        target.alias_resolution = record.alias_resolution;
      selected.push(target);
    }
  }
  const deduplicated = new Map();
  for (const record of selected) {
    const alias_id = record.alias_resolution
      ? record.alias_resolution.alias_entry.id
      : "preserve";
    const key = `${record.source_path}\0${record.source_digest}\0${record.entry.id}\0${alias_id}`;
    if (!deduplicated.has(key)) deduplicated.set(key, record);
  }
  return [...deduplicated.values()].sort(compare_records);
}

function normalize_input_set(input_set) {
  if (!Array.isArray(input_set) || input_set.length === 0) {
    request_error("Query input set must be a non-empty array");
  }
  return input_set.map((input, input_position) => {
    if (!input || typeof input !== "object" || !input.index) {
      request_error(`Query input ${input_position} requires index`);
    }
    const addressable_index =
      input.addressable_index || build_addressable_index(input.index);
    validate_addressable_index_binding(input.index, addressable_index);
    const requested_path =
      input.index.source.requested_path || input.index.source.file_path || "";
    return {
      index: input.index,
      addressable_index,
      source_path: path.resolve(requested_path),
    };
  });
}

function digest_input_set(inputs) {
  const binding_by_identity = new Map();
  for (const input of inputs) {
    const binding = {
      source_path: input.source_path,
      digest: input.index.source.digest,
    };
    binding_by_identity.set(canonical_json(binding), binding);
  }
  const binding = [...binding_by_identity.values()].sort((left, right) => {
    if (left.source_path !== right.source_path) {
      return left.source_path < right.source_path ? -1 : 1;
    }
    return left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0;
  });
  return sha256_digest(Buffer.from(canonical_json(binding), "utf8"));
}

function digest_query(query, purpose = "page") {
  const semantic_query = {
    version: 2,
    where: query.where,
    select: query.select,
    projection: query.projection,
    resolve_alias: query.resolve_alias,
    ...(purpose === "page"
      ? { expect_matches: query.expect_matches ?? null }
      : {}),
    limits: query.limits,
    page: { limit: query.page.limit },
  };
  return sha256_digest(Buffer.from(canonical_json(semantic_query), "utf8"));
}

function resolve_record_alias(record, query) {
  if (
    query.resolve_alias !== "target" ||
    record.entry.addressable_type !== "alias"
  ) {
    return record;
  }
  const resolution = resolve_alias_target(record.index, record.entry, {
    addressable_index: record.addressable_index,
  });
  return {
    ...record_for(resolution.target_entry, record),
    alias_resolution: resolution,
  };
}

function candidate_diagnostic(record, projection) {
  const entry = record.entry;
  const ancestor_paths = [];
  let ancestor = record.addressable_index.by_id.get(entry.parent_id);
  while (ancestor) {
    ancestor_paths.push(clone_json_value(ancestor.path, "ancestor path"));
    ancestor = record.addressable_index.by_id.get(ancestor.parent_id);
  }
  return {
    source_path: record.source_path,
    document: entry.document,
    line: entry.source.line,
    column: entry.source.column,
    path: clone_json_value(entry.path, "candidate path"),
    ancestor_paths,
    projection,
  };
}

function expectation_diagnostics(selected, query) {
  const candidates = [];
  let diagnostic_bytes = 0;
  const max_diagnostic_bytes = Math.min(
    query.limits.max_output_bytes,
    64 * 1024,
  );
  for (const record of selected.slice(0, 10)) {
    const projection = project_query_results([record], query.projection)[0];
    const candidate = candidate_diagnostic(record, projection);
    const next_bytes =
      diagnostic_bytes + Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (next_bytes > max_diagnostic_bytes) break;
    candidates.push(candidate);
    diagnostic_bytes = next_bytes;
  }
  return {
    candidates,
    truncated: candidates.length < selected.length,
  };
}

function output_limit_error(limit, actual) {
  throw new Yaml_patch_error(
    "CHANGE_LIMIT_EXCEEDED",
    "Query output exceeds max_output_bytes",
    {
      details: {
        limit_name: "max_output_bytes",
        limit,
        actual,
      },
    },
  );
}

function build_page(selected, offset, query, cursor_binding) {
  if (offset > selected.length) {
    request_error("Query cursor offset is beyond the result set", {
      offset,
      total_match_count: selected.length,
    });
  }
  const capacity = Math.min(query.page.limit, query.limits.max_result);
  const projected = [];
  let projected_bytes = 0;
  const target_count = Math.min(capacity, selected.length - offset);
  for (let index = 0; index < target_count; index += 1) {
    const projection = project_query_results(
      [selected[offset + index]],
      query.projection,
    )[0];
    const projection_bytes = Buffer.byteLength(
      JSON.stringify(projection),
      "utf8",
    );
    if (projected_bytes + projection_bytes > query.limits.max_output_bytes) {
      if (projected.length === 0) {
        output_limit_error(
          query.limits.max_output_bytes,
          projected_bytes + projection_bytes,
        );
      }
      break;
    }
    projected.push(projection);
    projected_bytes += projection_bytes;
  }
  let count = projected.length;
  while (count >= 0) {
    const next_offset = offset + count;
    const has_more = next_offset < selected.length;
    const next_cursor = has_more
      ? create_query_cursor({ ...cursor_binding, offset: next_offset })
      : null;
    const result = {
      match_count: count,
      total_match_count: selected.length,
      truncated: has_more,
      next_cursor,
      matches: projected.slice(0, count),
    };
    const output_bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (output_bytes <= query.limits.max_output_bytes) return result;
    if (count === 0 || (count === 1 && selected.length > offset)) {
      output_limit_error(query.limits.max_output_bytes, output_bytes);
    }
    count -= 1;
  }
  output_limit_error(query.limits.max_output_bytes, 0);
}

function run_query_v2(input_set, query, options = {}) {
  const validated_query = validate_query_v2(query, options);
  const inputs = normalize_input_set(input_set);
  const input_digest = digest_input_set(inputs);
  const page_query_digest = digest_query(validated_query, "page");
  const candidate_query_digest = digest_query(validated_query, "candidate");
  let cursor_purpose = "page";
  let cursor_query_digest = page_query_digest;
  let offset = 0;
  if (validated_query.page.cursor) {
    const cursor = decode_query_cursor(validated_query.page.cursor);
    const query_mode = options.mode === undefined ? "read" : options.mode;
    if (cursor.purpose === "candidate" && query_mode !== "read") {
      request_error("Candidate cursors are read-only diagnostics", {
        purpose: cursor.purpose,
        mode: query_mode,
      });
    }
    if (cursor.input_digest !== input_digest) {
      throw new Yaml_patch_error(
        "SOURCE_CHANGED",
        "Query cursor input set no longer matches the source snapshot",
        { details: { expected: cursor.input_digest, actual: input_digest } },
      );
    }
    cursor_purpose = cursor.purpose;
    cursor_query_digest =
      cursor_purpose === "candidate"
        ? candidate_query_digest
        : page_query_digest;
    if (cursor.query_digest !== cursor_query_digest) {
      throw new Yaml_patch_error(
        "PRECONDITION_FAILED",
        "Query cursor no longer matches the semantic query",
        {
          details: {
            expected: cursor.query_digest,
            actual: cursor_query_digest,
          },
        },
      );
    }
    offset = cursor.offset;
  }
  const state = { relation_visits: 0 };
  const matches = [];
  for (const input of inputs) {
    const context = {
      ...input,
      limits: validated_query.limits,
      state,
    };
    for (const entry of input.addressable_index.entries) {
      if (evaluate_predicate(entry, validated_query.where, context)) {
        matches.push(
          resolve_record_alias(record_for(entry, input), validated_query),
        );
      }
    }
  }
  matches.sort(compare_records);
  const selected = select_query_results(matches, validated_query.select);
  const diagnostics =
    validated_query.expect_matches === undefined
      ? { candidates: [], truncated: false }
      : expectation_diagnostics(selected, validated_query);
  if (cursor_purpose !== "candidate") {
    const expectation_cursor = diagnostics.truncated
      ? create_query_cursor({
          purpose: "candidate",
          input_digest,
          query_digest: candidate_query_digest,
          offset: diagnostics.candidates.length,
        })
      : null;
    assert_match_expectation(selected.length, validated_query.expect_matches, {
      ...diagnostics,
      cursor: expectation_cursor,
    });
  }
  return build_page(selected, offset, validated_query, {
    purpose: cursor_purpose,
    input_digest,
    query_digest: cursor_query_digest,
  });
}

module.exports = {
  assert_match_expectation,
  create_query_cursor,
  decode_query_cursor,
  evaluate_predicate,
  normalize_expect_matches,
  project_query_results,
  run_query_v2,
  select_query_results,
  validate_query_v2,
};
