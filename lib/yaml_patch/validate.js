"use strict";

const YAML = require("yaml");

const { Yaml_patch_error } = require("./error");
const { get_index_entry, get_index_node } = require("./node_index");

function warning_fingerprint(warning) {
  return `${warning.code}\u0000${warning.message}`;
}

function validate_parser_diagnostics(index, options = {}) {
  const result = index.parser_result;
  const result_error_code = options.result_error_code || "VALIDATION_FAILED";
  if (result.errors.length > 0) {
    throw new Yaml_patch_error(
      result_error_code,
      `YAML contains ${result.errors.length} parse error(s)`,
      { details: { errors: result.errors } },
    );
  }

  const unsupported_warnings = result.warnings.filter(
    (warning) => warning.code !== "TAG_RESOLVE_FAILED",
  );
  if (unsupported_warnings.length > 0) {
    throw new Yaml_patch_error(
      "VALIDATION_FAILED",
      `YAML contains ${unsupported_warnings.length} unsupported warning(s)`,
      { details: { warnings: unsupported_warnings } },
    );
  }
}

function validate_warning_baseline(original_index, candidate_index) {
  const original_warnings = original_index.parser_result.warnings
    .map(warning_fingerprint)
    .sort();
  const candidate_warnings = candidate_index.parser_result.warnings
    .map(warning_fingerprint)
    .sort();
  if (
    original_warnings.length !== candidate_warnings.length ||
    original_warnings.some(
      (warning, index) => warning !== candidate_warnings[index],
    )
  ) {
    throw new Yaml_patch_error(
      "VALIDATION_FAILED",
      "Candidate changed the opaque-tag warning baseline",
      {
        details: {
          original_warnings,
          candidate_warnings,
        },
        next_action:
          "preserve existing custom tags and do not add unresolved tags",
      },
    );
  }
}

function resolve_alias_relations(index) {
  const relations = [];
  for (const alias_entry of index.entries.filter(
    (entry) => entry.node_type === "alias",
  )) {
    const alias_node = get_index_node(index, alias_entry);
    const document = index.parser_result.documents[alias_entry.document];
    let anchor_node;
    try {
      anchor_node = alias_node.resolve(document);
    } catch (error) {
      throw new Yaml_patch_error(
        "ANCHOR_CONFLICT",
        `Alias *${alias_entry.alias} could not be resolved`,
        { cause: error, details: { alias: alias_entry.alias } },
      );
    }
    const anchor_entry = anchor_node
      ? get_index_entry(index, anchor_node)
      : null;
    if (!anchor_entry) {
      throw new Yaml_patch_error(
        "ANCHOR_CONFLICT",
        `Alias *${alias_entry.alias} has no preceding anchor`,
        {
          details: {
            alias: alias_entry.alias,
            locator: alias_entry.locator,
          },
        },
      );
    }
    relations.push({ alias_entry, anchor_entry });
  }
  return relations;
}

function range_contains_entry(range, entry) {
  return (
    entry.source.start_byte >= range.start_byte &&
    entry.source.end_byte <= range.end_byte
  );
}

function analyze_anchor_alias_dependencies(index, range) {
  const relations = resolve_alias_relations(index);
  const crossing_relations = [];
  for (const relation of relations) {
    const alias_inside = range_contains_entry(range, relation.alias_entry);
    const anchor_inside = range_contains_entry(range, relation.anchor_entry);
    if (alias_inside !== anchor_inside) {
      crossing_relations.push({
        alias: relation.alias_entry.alias,
        alias_locator: relation.alias_entry.locator,
        anchor_locator: relation.anchor_entry.locator,
        alias_inside,
        anchor_inside,
      });
    }
  }
  return {
    cross_boundary_anchor_alias: crossing_relations.length > 0,
    crossing_relations,
  };
}

function assert_no_cross_boundary_dependencies(index, range) {
  const dependencies = analyze_anchor_alias_dependencies(index, range);
  if (dependencies.cross_boundary_anchor_alias) {
    throw new Yaml_patch_error(
      "CROSS_BOUNDARY_DEPENDENCY",
      "Target has anchor/alias dependencies across its edit boundary",
      {
        details: dependencies,
        next_action: "select an ancestor containing both anchor and aliases",
      },
    );
  }
  return dependencies;
}

function validate_source_index(index) {
  validate_parser_diagnostics(index);
  resolve_alias_relations(index);
}

function validate_candidate_index(original_index, candidate_index) {
  validate_parser_diagnostics(candidate_index, {
    result_error_code: "INVALID_RESULT",
  });
  resolve_alias_relations(candidate_index);
  validate_warning_baseline(original_index, candidate_index);
}

module.exports = {
  analyze_anchor_alias_dependencies,
  assert_no_cross_boundary_dependencies,
  resolve_alias_relations,
  validate_candidate_index,
  validate_parser_diagnostics,
  validate_source_index,
  validate_warning_baseline,
  warning_fingerprint,
};
