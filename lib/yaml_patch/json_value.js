"use strict";

const { clone_json_value } = require("./artifact_version");
const { throw_request_error } = require("./error");

function clone_json_operation_value(value, label) {
  try {
    return clone_json_value(value, label);
  } catch (error) {
    throw_request_error(`${label} must be JSON-safe data`, {
      cause: error,
      details: error && error.details ? error.details : {},
    });
  }
}

module.exports = {
  clone_json_operation_value,
};
