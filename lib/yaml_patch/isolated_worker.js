"use strict";

const { parentPort, workerData } = require("node:worker_threads");

const { build_edit_package } = require("./fragment");
const { build_node_index, get_node_type } = require("./node_index");
const { parse_yaml_source } = require("./parser");
const { compile_fragment_patch, prepare_operation_patch } = require("./patch");
const { find_nodes, select_unique_node } = require("./query");
const { read_source_file } = require("./source");
const { validate_source_index } = require("./validate");

const DEFAULT_FIND_RESULT_LIMIT = 1000;
const DEFAULT_FIND_OUTPUT_BYTES = 4 * 1024 * 1024;

async function load_index(payload) {
  const source = await read_source_file(payload.file_path, {
    max_file_bytes: payload.max_file_bytes,
  });
  const parser_result = parse_yaml_source(source);
  return build_node_index(source, parser_result, payload.index_options);
}

async function inspect_action(payload) {
  const index = await load_index(payload);
  return {
    path: index.source.requested_path || index.source.file_path,
    digest: index.source.digest,
    size_bytes: index.source.size_bytes,
    encoding: index.source.encoding,
    bom: index.source.bom,
    line_break_mode: index.source.line_break_mode,
    parser_version: index.parser_result.parser_version,
    document_count: index.parser_result.documents.length,
    documents: index.parser_result.documents.map(
      (document, document_index) => ({
        document: document_index,
        node_type: document.contents
          ? get_node_type(document.contents)
          : "empty",
      }),
    ),
    node_count: index.entries.length,
    error_count: index.parser_result.errors.length,
    warning_count: index.parser_result.warnings.length,
    errors: index.parser_result.errors,
    warnings: index.parser_result.warnings,
  };
}

function public_entry(entry, source_path) {
  return {
    source_path,
    locator: entry.locator,
    document: entry.document,
    path: entry.path,
    node_type: entry.node_type,
    source: {
      line: entry.source.line,
      column: entry.source.column,
      start_byte: entry.source.start_byte,
      end_byte: entry.source.end_byte,
    },
    raw_digest: entry.raw_digest,
    size_bytes: entry.size_bytes,
    size_characters: entry.size_characters,
    tag: entry.tag,
    anchor: entry.anchor,
    alias: entry.alias,
  };
}

async function find_action(payload) {
  const index = await load_index(payload);
  const source_path = index.source.requested_path || index.source.file_path;
  const result_offset =
    payload.result_offset === undefined ? 0 : Number(payload.result_offset);
  const result_limit =
    payload.result_limit === undefined
      ? DEFAULT_FIND_RESULT_LIMIT
      : Number(payload.result_limit);
  const max_output_bytes =
    payload.max_output_bytes === undefined
      ? DEFAULT_FIND_OUTPUT_BYTES
      : Number(payload.max_output_bytes);
  if (!Number.isInteger(result_offset) || result_offset < 0) {
    throw new TypeError("Find result offset must be a non-negative integer");
  }
  if (!Number.isInteger(result_limit) || result_limit < 0) {
    throw new TypeError("Find result limit must be a non-negative integer");
  }
  if (!Number.isInteger(max_output_bytes) || max_output_bytes <= 0) {
    throw new TypeError("Find output byte limit must be a positive integer");
  }

  const all_matches = find_nodes(index, payload.query);
  const page_end = Math.min(all_matches.length, result_offset + result_limit);
  const result = {
    total_match_count: all_matches.length,
    returned_match_count: Math.max(0, page_end - result_offset),
    offset: result_offset,
    next_offset: page_end < all_matches.length ? page_end : null,
    matches: all_matches
      .slice(result_offset, page_end)
      .map((entry) => public_entry(entry, source_path)),
  };
  const output_bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (output_bytes > max_output_bytes) {
    const error = new Error(
      `Find result requires ${output_bytes} bytes, exceeding ${max_output_bytes}`,
    );
    error.code = "CHANGE_LIMIT_EXCEEDED";
    error.details = { output_bytes, max_output_bytes, result_limit };
    throw error;
  }
  return result;
}

async function extract_action(payload) {
  const index = await load_index(payload);
  const entry = select_unique_node(index, payload.query);
  return build_edit_package(index, entry, payload.extract_options);
}

async function validate_action(payload) {
  const index = await load_index(payload);
  validate_source_index(index);
  return {
    path: index.source.requested_path || index.source.file_path,
    digest: index.source.digest,
    document_count: index.parser_result.documents.length,
    node_count: index.entries.length,
    warning_count: index.parser_result.warnings.length,
    valid: true,
  };
}

async function prepare_operation_action(payload) {
  const index = await load_index(payload);
  return prepare_operation_patch(index, payload.patch_document);
}

function public_patch_result(patch_result) {
  const { candidate_index, ...public_result } = patch_result;
  return public_result;
}

async function compile_edit_package_action(payload) {
  const index = await load_index(payload);
  const patch_result = compile_fragment_patch(
    index,
    payload.manifest,
    Buffer.from(payload.fragment_buffer),
  );
  return {
    source: {
      file_path: index.source.file_path,
      requested_path: index.source.requested_path,
      digest: index.source.digest,
      size_bytes: index.source.size_bytes,
      file_type: index.source.file_type,
      mode: index.source.mode,
      uid: index.source.uid,
      gid: index.source.gid,
      hard_link_count: index.source.hard_link_count,
      device: index.source.device,
      inode: index.source.inode,
    },
    patch_result: public_patch_result(patch_result),
  };
}

async function dispatch_action(action, payload) {
  if (action === "inspect") return inspect_action(payload);
  if (action === "find") return find_action(payload);
  if (action === "extract") return extract_action(payload);
  if (action === "validate") return validate_action(payload);
  if (action === "prepare_operation") return prepare_operation_action(payload);
  if (action === "compile_edit_package") {
    return compile_edit_package_action(payload);
  }
  throw new Error(`Unknown isolated YAML action: ${action}`);
}

function serialize_error(error) {
  return {
    code: error.code || "VALIDATION_FAILED",
    message: error.message || String(error),
    recoverable: Boolean(error.recoverable),
    next_action: error.next_action,
    details: error.details || {},
  };
}

dispatch_action(workerData.action, workerData.payload).then(
  (result) => parentPort.postMessage({ ok: true, result }),
  (error) =>
    parentPort.postMessage({ ok: false, error: serialize_error(error) }),
);

module.exports = {
  DEFAULT_FIND_OUTPUT_BYTES,
  DEFAULT_FIND_RESULT_LIMIT,
  dispatch_action,
  compile_edit_package_action,
  extract_action,
  find_action,
  inspect_action,
  load_index,
  serialize_error,
  validate_action,
};
