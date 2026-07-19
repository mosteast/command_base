"use strict";

const path = require("node:path");
const { TextDecoder } = require("node:util");

const { request_error } = require("./error");
const { read_bounded_file } = require("./source");

const DEFAULT_JSON_INPUT_BYTES = 1024 * 1024;

async function read_bounded_stdin(stdin, max_bytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > max_bytes) {
      throw request_error("Stdin JSON exceeds the configured byte limit", {
        details: { max_bytes, actual_bytes: total },
      });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

async function read_request_input(source, options = {}) {
  const max_bytes = options.max_bytes || DEFAULT_JSON_INPUT_BYTES;
  const label = options.label || "request";
  if (source === "-" || source === "stdin") {
    if (options.stdin_consumed) {
      throw request_error("Only one JSON input may read from stdin");
    }
    if (typeof options.mark_stdin_consumed === "function") {
      options.mark_stdin_consumed();
    }
    const buffer = await read_bounded_stdin(
      options.stdin || process.stdin,
      max_bytes,
    );
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(buffer),
      );
    } catch (error) {
      throw request_error(`Cannot read ${label} JSON from stdin`, {
        cause: error,
        details: { source: "stdin" },
      });
    }
  }
  if (typeof source !== "string" || source.length === 0) {
    throw request_error(`${label} path is required`);
  }
  const resolved_path = path.resolve(source);
  try {
    const file = await read_bounded_file(resolved_path, {
      max_file_bytes: max_bytes,
      allow_symbolic_link: false,
      file_type_error_code: "REQUEST_ERROR",
      limit_error_code: "REQUEST_ERROR",
      changed_error_code: "REQUEST_ERROR",
    });
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(file.buffer),
    );
  } catch (error) {
    if (error && error.code === "REQUEST_ERROR") throw error;
    throw request_error(`Cannot read ${label} JSON: ${resolved_path}`, {
      cause: error,
      details: { path: resolved_path },
    });
  }
}

module.exports = {
  DEFAULT_JSON_INPUT_BYTES,
  read_bounded_stdin,
  read_request_input,
};
