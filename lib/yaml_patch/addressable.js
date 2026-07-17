"use strict";

const {
  DEFAULT_MAX_ALIAS_HOP,
  DEFAULT_MAX_ALIAS_RESOLUTION_COUNT,
  DEFAULT_MAX_ALIAS_VISIT,
  annotate_alias_targets,
  resolve_alias_target,
} = require("./alias_resolution");
const {
  DEFAULT_MAX_ADDRESSABLE_COUNT,
  DEFAULT_MAX_LOCATOR_BYTES,
  DEFAULT_MAX_TOTAL_PATH_STEPS,
  build_addressable_graph,
} = require("./addressable_graph");
const { encode_locator_v2 } = require("./locator_v2");
const { typed_scalar_metadata } = require("./scalar_metadata");

function build_addressable_index(index, options = {}) {
  const addressable_index = build_addressable_graph(index, options);
  return options.resolve_alias_target === true
    ? annotate_alias_targets(index, addressable_index, options)
    : addressable_index;
}

module.exports = {
  DEFAULT_MAX_ADDRESSABLE_COUNT,
  DEFAULT_MAX_ALIAS_HOP,
  DEFAULT_MAX_ALIAS_RESOLUTION_COUNT,
  DEFAULT_MAX_ALIAS_VISIT,
  DEFAULT_MAX_LOCATOR_BYTES,
  DEFAULT_MAX_TOTAL_PATH_STEPS,
  build_addressable_index,
  encode_locator_v2,
  resolve_alias_target,
  typed_scalar_metadata,
};
