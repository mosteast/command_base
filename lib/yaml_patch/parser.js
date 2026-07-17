"use strict";

const YAML = require("yaml");
const yaml_package = require("yaml/package.json");

const { Yaml_patch_error } = require("./error");
const { utf16_offset_to_byte } = require("./source");

const SUPPORTED_YAML_VERSION = "2.8.0";

function get_yaml_parser_version() {
  const installed_version = yaml_package.version;
  if (installed_version !== SUPPORTED_YAML_VERSION) {
    throw new Yaml_patch_error(
      "VALIDATION_FAILED",
      `Unsupported yaml parser version ${installed_version}; expected ${SUPPORTED_YAML_VERSION}`,
      {
        details: {
          installed_version,
          supported_version: SUPPORTED_YAML_VERSION,
        },
        next_action: `install yaml@${SUPPORTED_YAML_VERSION}`,
      },
    );
  }
  return installed_version;
}

function normalize_diagnostic(diagnostic, kind, document, source) {
  const positions = Array.isArray(diagnostic.pos) ? diagnostic.pos : [];
  const start_character = Number.isInteger(positions[0]) ? positions[0] : 0;
  const end_character = Number.isInteger(positions[1])
    ? positions[1]
    : start_character;
  const safe_start_character = Math.min(start_character, source.text.length);
  const safe_end_character = Math.min(end_character, source.text.length);

  return {
    kind,
    code: diagnostic.code || "YAML_DIAGNOSTIC",
    message: String(diagnostic.message || diagnostic),
    document,
    start_character,
    end_character,
    start_byte: utf16_offset_to_byte(source, safe_start_character),
    end_byte: utf16_offset_to_byte(source, safe_end_character),
  };
}

function parse_yaml_source(source) {
  get_yaml_parser_version();
  const line_counter = new YAML.LineCounter();
  let documents;
  try {
    documents = YAML.parseAllDocuments(source.text, {
      keepSourceTokens: true,
      lineCounter: line_counter,
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
  } catch (error) {
    throw new Yaml_patch_error(
      "VALIDATION_FAILED",
      "The YAML parser failed before returning diagnostics",
      { cause: error },
    );
  }

  const errors = [];
  const warnings = [];
  documents.forEach((document, document_index) => {
    for (const error of document.errors || []) {
      errors.push(normalize_diagnostic(error, "error", document_index, source));
    }
    for (const warning of document.warnings || []) {
      warnings.push(
        normalize_diagnostic(warning, "warning", document_index, source),
      );
    }
  });

  return {
    documents,
    line_counter,
    errors,
    warnings,
    parser_version: SUPPORTED_YAML_VERSION,
  };
}

module.exports = {
  SUPPORTED_YAML_VERSION,
  get_yaml_parser_version,
  normalize_diagnostic,
  parse_yaml_source,
};
