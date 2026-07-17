"use strict";

const {
  canonical_json,
  validate_artifact_version,
} = require("./artifact_version");
const { Yaml_patch_error } = require("./error");

function encode_locator_v2(entry, source_digest) {
  validate_artifact_version("locator", 2);
  if (!entry || entry.source_digest !== source_digest) {
    throw new Yaml_patch_error(
      "SOURCE_CHANGED",
      "Locator source digest does not match its addressable entry",
      {
        details: {
          entry_source_digest: entry && entry.source_digest,
          source_digest,
        },
        next_action: "rebuild the addressable index from the current source",
      },
    );
  }
  const locator_data = {
    version: 2,
    source_digest,
    document: entry.document,
    path: entry.path,
    addressable_type: entry.addressable_type,
    start_byte: entry.source.start_byte,
    end_byte: entry.source.end_byte,
    target_digest: entry.raw_digest,
  };
  return Buffer.from(canonical_json(locator_data), "utf8").toString(
    "base64url",
  );
}

module.exports = { encode_locator_v2 };
