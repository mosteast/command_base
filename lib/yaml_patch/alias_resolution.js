"use strict";

const { Yaml_patch_error } = require("./error");
const {
  build_addressable_graph,
  validate_addressable_entry_binding,
  validate_addressable_index_binding,
} = require("./addressable_graph");

const DEFAULT_MAX_ALIAS_HOP = 64;
const DEFAULT_MAX_ALIAS_VISIT = 256;
const DEFAULT_MAX_ALIAS_RESOLUTION_COUNT = 100_000;
const alias_table_cache = new WeakMap();

function validation_error(message, details = {}) {
  return new Yaml_patch_error("VALIDATION_FAILED", message, { details });
}

function bounded_alias_option(options, name, default_value) {
  const value = options[name] === undefined ? default_value : options[name];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw validation_error(`${name} must be a non-negative safe integer`, {
      [name]: value,
    });
  }
  return value;
}

function alias_limit_error(name, limit, actual, alias) {
  return new Yaml_patch_error(
    "CHANGE_LIMIT_EXCEEDED",
    "Alias target resolution exceeds its configured limits",
    { details: { limit_name: name, limit, actual, alias } },
  );
}

function build_alias_target_table(index, addressable_index) {
  const cached = alias_table_cache.get(addressable_index);
  if (cached && cached.index === index) return cached;
  const anchors_by_document = index.parser_result.documents.map(
    () => new Map(),
  );
  const target_by_alias_node_id = new Map();
  let alias_count = 0;
  for (const entry of index.entries) {
    const node = index._internal.node_by_id.get(entry.id);
    const anchors = anchors_by_document[entry.document];
    if (node && typeof node.anchor === "string" && node.anchor.length > 0) {
      anchors.set(node.anchor, entry);
    }
    if (entry.node_type === "alias") {
      alias_count += 1;
      target_by_alias_node_id.set(entry.id, anchors.get(entry.alias) || null);
    }
  }
  const table = { index, alias_count, target_by_alias_node_id };
  alias_table_cache.set(addressable_index, table);
  return table;
}

function assert_alias_budgets(table, alias_entry, options) {
  const max_alias_hop = bounded_alias_option(
    options,
    "max_alias_hop",
    DEFAULT_MAX_ALIAS_HOP,
  );
  const max_alias_visit = bounded_alias_option(
    options,
    "max_alias_visit",
    DEFAULT_MAX_ALIAS_VISIT,
  );
  const max_alias_resolution_count = bounded_alias_option(
    options,
    "max_alias_resolution_count",
    DEFAULT_MAX_ALIAS_RESOLUTION_COUNT,
  );
  if (max_alias_hop < 1) {
    throw alias_limit_error(
      "max_alias_hop",
      max_alias_hop,
      1,
      alias_entry.alias,
    );
  }
  if (max_alias_visit < 1) {
    throw alias_limit_error(
      "max_alias_visit",
      max_alias_visit,
      1,
      alias_entry.alias,
    );
  }
  if (table.alias_count > max_alias_resolution_count) {
    throw alias_limit_error(
      "max_alias_resolution_count",
      max_alias_resolution_count,
      table.alias_count,
      alias_entry.alias,
    );
  }
}

function alias_location(entry) {
  return {
    locator: entry.locator,
    document: entry.document,
    path: entry.path,
    source: entry.source,
  };
}

function resolution_from_table(addressable_index, table, alias_entry, options) {
  assert_alias_budgets(table, alias_entry, options);
  const target_v1_entry = table.target_by_alias_node_id.get(
    alias_entry.node_id,
  );
  const target_entry = target_v1_entry
    ? addressable_index.node_entry_by_id.get(target_v1_entry.id)
    : null;
  if (!target_entry) {
    throw validation_error(
      `Alias *${alias_entry.alias} has no preceding anchor`,
      {
        alias: alias_entry.alias,
        alias_locator: alias_entry.locator,
      },
    );
  }
  return {
    alias_entry,
    target_entry,
    alias_location: alias_location(alias_entry),
    target_location: alias_location(target_entry),
    hop_count: 1,
  };
}

function resolve_alias_target(index, alias_entry, options = {}) {
  const addressable_index =
    options.addressable_index || build_addressable_graph(index, options);
  const resolved_alias_entry =
    typeof alias_entry === "number"
      ? addressable_index.by_id.get(alias_entry)
      : alias_entry;
  validate_addressable_entry_binding(
    index,
    addressable_index,
    resolved_alias_entry,
  );
  if (
    resolved_alias_entry.addressable_type !== "alias" ||
    !Number.isInteger(resolved_alias_entry.node_id)
  ) {
    throw validation_error("Alias resolution requires an addressable alias", {
      addressable_id: resolved_alias_entry.id,
    });
  }
  const table = build_alias_target_table(index, addressable_index);
  return resolution_from_table(
    addressable_index,
    table,
    resolved_alias_entry,
    options,
  );
}

function annotate_alias_targets(index, addressable_index, options = {}) {
  validate_addressable_index_binding(index, addressable_index);
  const table = build_alias_target_table(index, addressable_index);
  const alias_entries = addressable_index.entries.filter(
    (entry) => entry.addressable_type === "alias",
  );
  for (const alias_entry of alias_entries) {
    const resolution = resolution_from_table(
      addressable_index,
      table,
      alias_entry,
      options,
    );
    alias_entry.alias_target = {
      target_id: resolution.target_entry.id,
      hop_count: resolution.hop_count,
      alias_location: resolution.alias_location,
      target_location: resolution.target_location,
    };
  }
  return addressable_index;
}

module.exports = {
  DEFAULT_MAX_ALIAS_HOP,
  DEFAULT_MAX_ALIAS_RESOLUTION_COUNT,
  DEFAULT_MAX_ALIAS_VISIT,
  annotate_alias_targets,
  resolve_alias_target,
};
