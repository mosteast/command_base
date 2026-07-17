"use strict";

class Yaml_patch_error extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "Yaml_patch_error";
    this.code = code;
    this.recoverable = Boolean(options.recoverable);
    this.next_action = options.next_action || "review the error details";
    this.details = options.details || {};
  }
}

function is_yaml_patch_error(error) {
  return error instanceof Yaml_patch_error;
}

module.exports = {
  Yaml_patch_error,
  is_yaml_patch_error,
};
