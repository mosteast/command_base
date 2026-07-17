"use strict";

const { is_yaml_patch_error, Yaml_patch_error } = require("./error");

const PROTOCOL_VERSION = 1;

function success_response(result) {
  return {
    ok: true,
    protocol_version: PROTOCOL_VERSION,
    result,
  };
}

function normalize_error(error) {
  if (is_yaml_patch_error(error)) return error;
  return new Yaml_patch_error(
    "INTERNAL_ERROR",
    error && error.message ? error.message : String(error),
    {
      cause: error,
      recoverable: false,
      next_action: "run again with --debug and report the failure",
    },
  );
}

function error_response(error) {
  const normalized_error = normalize_error(error);
  return {
    ok: false,
    protocol_version: PROTOCOL_VERSION,
    code: normalized_error.code,
    message: normalized_error.message,
    recoverable: normalized_error.recoverable,
    next_action: normalized_error.next_action,
    details: normalized_error.details,
  };
}

function serialize_response(response) {
  return `${JSON.stringify(response)}\n`;
}

module.exports = {
  PROTOCOL_VERSION,
  error_response,
  normalize_error,
  serialize_response,
  success_response,
};
