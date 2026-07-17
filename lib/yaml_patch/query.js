"use strict";

const YAML = require("yaml");

const { Yaml_patch_error } = require("./error");
const { get_index_entry, key_metadata } = require("./node_index");

const QUERY_FIELDS = new Set([
  "version",
  "document",
  "path",
  "node_type",
  "raw_equals",
  "source",
]);
const NODE_TYPES = new Set(["mapping", "sequence", "scalar", "alias"]);

function invalid_query(message, details = {}) {
  throw new Yaml_patch_error("REQUEST_ERROR", message, { details });
}

function validate_path_step(step, step_index) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    invalid_query(`Query path step ${step_index} must be an object`);
  }
  const has_sequence_index = Object.hasOwn(step, "sequence_index");
  const has_mapping_key = Object.hasOwn(step, "mapping_key");
  const has_mapping_pair_index = Object.hasOwn(step, "mapping_pair_index");
  if (
    [has_sequence_index, has_mapping_key, has_mapping_pair_index].filter(
      Boolean,
    ).length !== 1
  ) {
    invalid_query(
      `Query path step ${step_index} must use exactly one locator type`,
    );
  }

  let allowed_fields;
  if (has_sequence_index) {
    allowed_fields = new Set(["sequence_index"]);
    if (!Number.isInteger(step.sequence_index) || step.sequence_index < 0) {
      invalid_query(
        `sequence_index at step ${step_index} must be non-negative`,
      );
    }
  } else if (has_mapping_key) {
    allowed_fields = new Set(["mapping_key"]);
    if (typeof step.mapping_key !== "string") {
      invalid_query(`mapping_key at step ${step_index} must be a string`);
    }
  } else {
    allowed_fields = new Set(["mapping_pair_index", "key_raw_digest", "node"]);
    if (
      !Number.isInteger(step.mapping_pair_index) ||
      step.mapping_pair_index < 0
    ) {
      invalid_query(
        `mapping_pair_index at step ${step_index} must be non-negative`,
      );
    }
    if (!/^[a-f0-9]{64}$/.test(step.key_raw_digest || "")) {
      invalid_query(`key_raw_digest at step ${step_index} is invalid`);
    }
    if (step.node !== undefined && step.node !== "key") {
      invalid_query(`node at step ${step_index} must be key when provided`);
    }
  }
  for (const field of Object.keys(step)) {
    if (!allowed_fields.has(field)) {
      invalid_query(`Unknown query path step field: ${field}`, {
        step_index,
        field,
      });
    }
  }
}

function validate_query(query) {
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    throw new Yaml_patch_error("REQUEST_ERROR", "Query must be an object");
  }
  if (query.version !== undefined && query.version !== 1) {
    throw new Yaml_patch_error(
      "PROTOCOL_VERSION_UNSUPPORTED",
      `Unsupported query version: ${query.version}`,
      { details: { kind: "query", version: query.version } },
    );
  }
  for (const field of Object.keys(query)) {
    if (!QUERY_FIELDS.has(field)) {
      throw new Yaml_patch_error(
        "REQUEST_ERROR",
        `Unknown query field: ${field}`,
        { details: { field } },
      );
    }
  }
  if (
    query.document !== undefined &&
    (!Number.isInteger(query.document) || query.document < 0)
  ) {
    invalid_query("Query document must be a non-negative integer");
  }
  if (query.node_type !== undefined && !NODE_TYPES.has(query.node_type)) {
    invalid_query(`Unsupported query node_type: ${query.node_type}`);
  }
  if (query.raw_equals !== undefined && typeof query.raw_equals !== "string") {
    invalid_query("Query raw_equals must be a string");
  }
  if (query.path !== undefined) {
    if (!Array.isArray(query.path))
      invalid_query("Query path must be an array");
    query.path.forEach(validate_path_step);
  }
  if (query.source !== undefined) {
    if (
      !query.source ||
      typeof query.source !== "object" ||
      Array.isArray(query.source)
    ) {
      invalid_query("Query source must be an object");
    }
    const allowed_source_fields = new Set([
      "line",
      "column",
      "start_byte",
      "end_byte",
    ]);
    for (const [field, value] of Object.entries(query.source)) {
      if (!allowed_source_fields.has(field)) {
        invalid_query(`Unknown query source field: ${field}`, { field });
      }
      const minimum = field === "line" || field === "column" ? 1 : 0;
      if (!Number.isInteger(value) || value < minimum) {
        invalid_query(`Query source ${field} must be an integer >= ${minimum}`);
      }
    }
  }
}

function mapping_pair_for_step(index, mapping_node, step) {
  if (!YAML.isMap(mapping_node)) return null;
  if (Object.hasOwn(step, "mapping_key")) {
    const matches = [];
    mapping_node.items.forEach((pair, pair_index) => {
      const metadata = key_metadata(index.source, pair, pair_index);
      if (
        metadata.shortcut_eligible &&
        metadata.string_value === step.mapping_key
      ) {
        matches.push(pair);
      }
    });
    return matches.length === 1 ? matches[0] : null;
  }
  if (Number.isInteger(step.mapping_pair_index)) {
    const pair = mapping_node.items[step.mapping_pair_index];
    if (!pair) return null;
    if (step.key_raw_digest) {
      const metadata = key_metadata(
        index.source,
        pair,
        step.mapping_pair_index,
      );
      if (metadata.raw_digest !== step.key_raw_digest) return null;
    }
    return pair;
  }
  return null;
}

function resolve_query_path(index, document_index, path_steps) {
  const document = index.parser_result.documents[document_index];
  if (!document || !document.contents) return null;
  let node = document.contents;

  for (const step of path_steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) return null;
    if (Number.isInteger(step.sequence_index)) {
      if (!YAML.isSeq(node)) return null;
      node = node.items[step.sequence_index];
    } else {
      const pair = mapping_pair_for_step(index, node, step);
      if (!pair) return null;
      node = step.node === "key" ? pair.key : pair.value;
    }
    if (!node) return null;
  }
  return get_index_entry(index, node);
}

function entry_matches(entry, query) {
  if (query.document !== undefined && entry.document !== query.document) {
    return false;
  }
  if (query.node_type && entry.node_type !== query.node_type) return false;
  if (query.raw_equals !== undefined && entry.raw !== query.raw_equals) {
    return false;
  }
  if (query.source) {
    for (const field of ["line", "column", "start_byte", "end_byte"]) {
      if (
        query.source[field] !== undefined &&
        entry.source[field] !== query.source[field]
      ) {
        return false;
      }
    }
  }
  return true;
}

function find_nodes(index, query = {}) {
  validate_query(query);
  let candidates;
  if (Array.isArray(query.path)) {
    const document_indexes =
      query.document === undefined
        ? index.parser_result.documents.map((_, index_value) => index_value)
        : [query.document];
    candidates = document_indexes
      .map((document_index) =>
        resolve_query_path(index, document_index, query.path),
      )
      .filter(Boolean);
  } else {
    candidates = index.entries;
  }

  return candidates
    .filter((entry) => entry_matches(entry, query))
    .slice()
    .sort(
      (left, right) =>
        left.document - right.document ||
        left.source.start_character - right.source.start_character ||
        left.ordinal - right.ordinal,
    );
}

function select_unique_node(index, query) {
  const matches = find_nodes(index, query);
  if (matches.length === 0) {
    throw new Yaml_patch_error("NO_MATCH", "Query matched no YAML nodes", {
      recoverable: true,
      next_action: "inspect the source and use an exact query",
      details: { query },
    });
  }
  if (matches.length !== 1) {
    throw new Yaml_patch_error(
      "AMBIGUOUS_MATCH",
      `Query matched ${matches.length} YAML nodes`,
      {
        recoverable: true,
        next_action: "add a document, path, type, raw, or source constraint",
        details: {
          query,
          match_count: matches.length,
          locators: matches.map((entry) => entry.locator),
        },
      },
    );
  }
  return matches[0];
}

module.exports = {
  find_nodes,
  resolve_query_path,
  select_unique_node,
  validate_query,
  ...require("./query_v2"),
};
