"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { list_capabilities } = require("./capability");
const { request_error } = require("./error");
const { validate_manifest_replay } = require("./manifest");
const { build_node_index } = require("./node_index");
const { parse_yaml_source } = require("./parser");
const { load_profile } = require("./profile");
const { error_response, success_response } = require("./protocol");
const { run_query_v2 } = require("./query_v2");
const {
  inspect_transaction_status,
  recover_transaction,
} = require("./recovery");
const { read_request_input } = require("./request_input");
const { assert_object } = require("./schema");
const {
  create_source_record,
  read_bounded_file,
  sha256_digest,
} = require("./source");
const { plan_transaction } = require("./transaction");
const { write_transaction } = require("./transaction_writer");

async function load_source_buffers(files, options = {}) {
  const sources = { ...(options.sources || {}) };
  for (const file of files || []) {
    if (sources[file.id]) continue;
    const resolved = path.resolve(file.path);
    const loaded = await read_bounded_file(resolved, {
      max_file_bytes: options.max_file_bytes,
      allow_symbolic_link: false,
    });
    sources[file.id] = loaded.buffer;
  }
  return sources;
}

function build_query_input(file, buffer) {
  const source = create_source_record(buffer, {
    file_path: path.resolve(file.path),
    requested_path: file.path,
  });
  const parsed = parse_yaml_source(source);
  const index = build_node_index(source, parsed);
  return { index };
}

async function execute_query_request(request, options = {}) {
  const sources = await load_source_buffers(request.files, options);
  const input_set = (request.files || []).map((file) =>
    build_query_input(file, sources[file.id]),
  );
  const query =
    request.query && typeof request.query === "object"
      ? request.query
      : Object.fromEntries(
          Object.entries({
            version: request.version,
            where: request.where,
            select: request.select,
            projection: request.projection,
            resolve_alias: request.resolve_alias,
            expect_matches: request.expect_matches,
            page: request.page,
            limits: request.limits,
          }).filter(([, value]) => value !== undefined),
        );
  const result = run_query_v2(input_set, query, options);
  return success_response({
    kind: "query",
    ...result,
  });
}

async function execute_transaction_request(request, options = {}) {
  const {
    kind: _kind,
    command: _command,
    type: _type,
    profile: request_profile,
    ...transaction_request
  } = request;
  const sources = await load_source_buffers(transaction_request.files, options);
  const runtime = {
    ...options,
    sources,
    capability_digest:
      options.capability_digest ||
      sha256_digest(Buffer.from(JSON.stringify(list_capabilities(options)))),
    tool_version: options.tool_version,
  };
  if (options.profile || request_profile) {
    runtime.profile =
      options.profile ||
      load_profile(request_profile, { base_path: options.base_path });
  }
  const result = options.write
    ? await write_transaction(transaction_request, runtime)
    : await plan_transaction(transaction_request, runtime);
  const public_result = {
    kind: "transaction",
    ...result,
    candidates: Object.fromEntries(
      Object.entries(result.candidates || {}).map(([file_id, candidate]) => {
        const digest =
          candidate.digest ||
          (Buffer.isBuffer(candidate.buffer)
            ? sha256_digest(candidate.buffer)
            : null);
        const { buffer: _buffer, ...public_candidate } = candidate;
        return [file_id, { ...public_candidate, digest }];
      }),
    ),
  };
  return success_response(public_result);
}

async function execute_status_request(request) {
  const status = await inspect_transaction_status(request.journal_path);
  return success_response({ kind: "status", ...status });
}

async function execute_recover_request(request, options = {}) {
  const result = await recover_transaction(request.journal_path, {
    direction: request.direction || options.direction,
  });
  return success_response({ kind: "recover", ...result });
}

async function execute_replay_request(request, options = {}) {
  assert_object(request.manifest, "manifest");
  const sources = await load_source_buffers(
    request.manifest.request.files,
    options,
  );
  const current = await plan_transaction(request.manifest.request, {
    ...options,
    sources,
    capability_digest: options.capability_digest,
    tool_version: options.tool_version,
  });
  validate_manifest_replay(request.manifest, {
    request: request.manifest.request,
    result: current.manifest.result,
    profile_digest: current.manifest.profile_digest,
    capability_digest: current.manifest.capability_digest,
    tool_version: current.manifest.tool_version,
  });
  return success_response({
    kind: "replay",
    matched: true,
    manifest: current.manifest,
  });
}

async function execute_capabilities_request(request, options = {}) {
  return success_response({
    kind: "capabilities",
    ...list_capabilities(options),
  });
}

async function write_artifact_exclusive(file_path, payload, options = {}) {
  const resolved = path.resolve(file_path);
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  if (options.refresh) {
    try {
      const existing = JSON.parse(await fs.readFile(resolved, "utf8"));
      if (
        existing.format &&
        payload.format &&
        existing.format !== payload.format
      ) {
        throw request_error("Refresh requires the same artifact kind", {
          details: {
            path: resolved,
            expected_format: payload.format,
            actual_format: existing.format,
          },
        });
      }
      if (
        existing.version !== undefined &&
        payload.version !== undefined &&
        existing.version !== payload.version
      ) {
        throw request_error("Refresh requires the same artifact version", {
          details: {
            path: resolved,
            expected_version: payload.version,
            actual_version: existing.version,
          },
        });
      }
    } catch (error) {
      if (error && error.code === "ENOENT") {
        // create below
      } else if (error && error.name === "Yaml_patch_error") {
        throw error;
      } else if (error && error.code !== "ENOENT") {
        throw error;
      }
    }
    await fs.writeFile(resolved, body);
    return resolved;
  }
  const handle = await fs.open(resolved, "wx");
  try {
    await handle.writeFile(body);
  } finally {
    await handle.close();
  }
  return resolved;
}

async function execute_request(request, options = {}) {
  try {
    assert_object(request, "request");
    const kind = request.kind || request.command || request.type;
    if (kind === "capabilities") {
      return execute_capabilities_request(request, options);
    }
    if (kind === "query" || request.query) {
      return execute_query_request(request, options);
    }
    if (kind === "status") {
      return execute_status_request(request, options);
    }
    if (kind === "recover") {
      return execute_recover_request(request, options);
    }
    if (kind === "replay") {
      return execute_replay_request(request, options);
    }
    if (
      kind === "transaction" ||
      Array.isArray(request.operations) ||
      request.version === 1
    ) {
      return execute_transaction_request(request, options);
    }
    throw request_error(`Unsupported request kind: ${kind || "<none>"}`);
  } catch (error) {
    return error_response(error);
  }
}

module.exports = {
  execute_request,
  execute_query_request,
  execute_transaction_request,
  read_request_input,
  write_artifact_exclusive,
};
