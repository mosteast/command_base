"use strict";

const path = require("node:path");

const {
  canonical_digest,
  clone_json_value,
  validate_artifact_version,
} = require("./artifact_version");
const { Yaml_patch_error } = require("./error");
const { validate_byte_proof } = require("./range_set");
const { assert_known_fields } = require("./schema");

const MANIFEST_FIELD = Object.freeze([
  "format",
  "version",
  "request",
  "result",
  "profile_digest",
  "capability_digest",
  "tool_version",
  "request_digest",
  "result_digest",
  "validation_digest",
  "proof_digest",
  "reproducible_digest",
]);

const RUNTIME_METADATA_FIELD = new Set([
  "temp_path",
  "timestamp",
  "transaction_id",
  "random_id",
]);

function manifest_error(message, details = {}) {
  throw new Yaml_patch_error("VALIDATION_FAILED", message, { details });
}

function replay_conflict(field, expected, actual) {
  throw new Yaml_patch_error(
    "PRECONDITION_FAILED",
    `Manifest replay ${field} changed`,
    {
      details: { scope: "manifest_replay", field, expected, actual },
      next_action: "replan the transaction against the current inputs",
    },
  );
}

function reproducible_value(value) {
  if (Array.isArray(value)) return value.map(reproducible_value);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([field, item]) => [
      field,
      reproducible_value(item),
    ]),
  );
}

function remove_runtime_metadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const field of RUNTIME_METADATA_FIELD) delete value[field];
}

function reproducible_manifest_section(value, section) {
  const reproducible = reproducible_value(value);
  remove_runtime_metadata(reproducible);
  if (Array.isArray(reproducible.files)) {
    for (const file of reproducible.files) {
      remove_runtime_metadata(file);
      if (
        typeof file.path === "string" &&
        (path.isAbsolute(file.path) || path.win32.isAbsolute(file.path))
      ) {
        delete file.path;
      }
    }
  }
  if (
    section === "result" &&
    reproducible.transaction_proof &&
    typeof reproducible.transaction_proof === "object" &&
    !Array.isArray(reproducible.transaction_proof)
  ) {
    remove_runtime_metadata(reproducible.transaction_proof);
    delete reproducible.transaction_proof.transaction_digest;
    if (Array.isArray(reproducible.transaction_proof.files)) {
      for (const file of reproducible.transaction_proof.files) {
        remove_runtime_metadata(file);
        if (file && typeof file === "object" && !Array.isArray(file)) {
          delete file.source_path;
        }
      }
    }
  }
  return reproducible;
}

function sorted_manifest_data(value) {
  const clone = clone_json_value(value, "manifest data");
  if (Array.isArray(clone.files)) {
    clone.files.sort((left, right) => {
      const left_id = left.id || left.file_id || "";
      const right_id = right.id || right.file_id || "";
      return left_id < right_id ? -1 : left_id > right_id ? 1 : 0;
    });
  }
  return clone;
}

function manifest_binding(input, request, result) {
  const validation = result.validation || { diagnostics: [] };
  const file_proofs = (result.files || []).map((file) => ({
    file_id: file.file_id,
    proof: file.proof,
  }));
  return {
    format: "yaml_patch-manifest-binding",
    version: 1,
    request_digest: canonical_digest(
      reproducible_manifest_section(request, "request"),
    ),
    result_digest: canonical_digest(
      reproducible_manifest_section(result, "result"),
    ),
    profile_digest: input.profile_digest || null,
    capability_digest: input.capability_digest || null,
    tool_version: input.tool_version || null,
    validation_digest: canonical_digest(validation),
    proof_digest: canonical_digest(file_proofs),
  };
}

function source_binding_for_participant(request_file, result) {
  const matches = (result.files || []).filter(
    (result_file) => result_file.file_id === request_file.id,
  );
  if (matches.length !== 1) {
    manifest_error("Manifest participant must have exactly one result file", {
      file_id: request_file.id,
      result_file_count: matches.length,
    });
  }
  const result_file = matches[0];
  let proof;
  try {
    proof = validate_byte_proof(result_file.proof);
  } catch (error) {
    manifest_error("Manifest participant has an invalid byte proof", {
      file_id: request_file.id,
      reason: error.message,
    });
  }
  const proven_digest = proof.original_digest;
  for (const [field, expected] of [
    ["original_digest", proof.original_digest],
    ["candidate_digest", proof.candidate_digest],
    ["no_op", proof.no_op],
  ]) {
    if (result_file[field] !== undefined && result_file[field] !== expected) {
      manifest_error(`Manifest result file ${field} conflicts with its proof`, {
        file_id: request_file.id,
        field,
        expected,
        actual: result_file[field],
      });
    }
  }
  if (result_file.diff !== undefined) {
    const diff = result_file.diff;
    if (!diff || typeof diff !== "object" || Array.isArray(diff)) {
      manifest_error("Manifest result file diff must be an object", {
        file_id: request_file.id,
      });
    }
    const expected_byte_counts = {
      deleted: proof.summary.deleted_bytes,
      inserted: proof.summary.inserted_bytes,
      touched: proof.summary.touched_bytes,
    };
    if (
      diff.original_digest !== proof.original_digest ||
      diff.candidate_digest !== proof.candidate_digest ||
      diff.no_op !== proof.no_op ||
      canonical_digest(diff.byte_counts) !==
        canonical_digest(expected_byte_counts)
    ) {
      manifest_error("Manifest result file diff conflicts with its proof", {
        file_id: request_file.id,
      });
    }
  }
  if (
    request_file.digest !== undefined &&
    request_file.digest !== proven_digest
  ) {
    manifest_error("Manifest source digest binding is inconsistent", {
      file_id: request_file.id,
      request_digest: request_file.digest,
      proven_digest,
    });
  }
  return proven_digest;
}

function validate_manifest_participant_bindings(request, result) {
  if (!Array.isArray(request.files) || !Array.isArray(result.files)) {
    manifest_error("Manifest request and result require file arrays");
  }
  const request_ids = new Set();
  for (const request_file of request.files) {
    if (
      !request_file ||
      typeof request_file !== "object" ||
      Array.isArray(request_file) ||
      typeof request_file.id !== "string" ||
      request_file.id.length === 0 ||
      request_ids.has(request_file.id)
    ) {
      manifest_error("Manifest request participant IDs must be unique", {
        file_id: request_file && request_file.id,
      });
    }
    request_ids.add(request_file.id);
  }
  for (const result_file of result.files) {
    if (
      !result_file ||
      typeof result_file !== "object" ||
      Array.isArray(result_file) ||
      typeof result_file.file_id !== "string" ||
      !request_ids.has(result_file.file_id)
    ) {
      manifest_error("Manifest result contains an undeclared participant", {
        file_id: result_file && result_file.file_id,
      });
    }
  }
  if (result.files.length !== request.files.length) {
    manifest_error("Manifest participant sets must match exactly", {
      request_file_count: request.files.length,
      result_file_count: result.files.length,
    });
  }
  const bindings = new Map(
    request.files.map((request_file) => [
      request_file.id,
      source_binding_for_participant(request_file, result),
    ]),
  );
  if (
    typeof result.no_op !== "boolean" ||
    result.no_op !== result.files.every((file) => file.proof.no_op)
  ) {
    manifest_error("Manifest result no_op is inconsistent with file proofs");
  }
  return bindings;
}

function create_transaction_manifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    manifest_error("Manifest input must be an object");
  }
  const request = sorted_manifest_data(input.request);
  const result = sorted_manifest_data(input.result);
  const binding = manifest_binding(input, request, result);
  return {
    format: "yaml_patch-manifest",
    version: 2,
    request,
    result,
    profile_digest: binding.profile_digest,
    capability_digest: binding.capability_digest,
    tool_version: binding.tool_version,
    request_digest: binding.request_digest,
    result_digest: binding.result_digest,
    validation_digest: binding.validation_digest,
    proof_digest: binding.proof_digest,
    reproducible_digest: canonical_digest(binding),
  };
}

function validate_transaction_manifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    manifest_error("Manifest must be an object");
  }
  assert_known_fields(manifest, MANIFEST_FIELD, "manifest");
  if (manifest.format !== "yaml_patch-manifest")
    manifest_error("Invalid manifest format");
  validate_artifact_version("manifest", manifest.version);
  const expected = create_transaction_manifest({
    request: manifest.request,
    result: manifest.result,
    profile_digest: manifest.profile_digest,
    capability_digest: manifest.capability_digest,
    tool_version: manifest.tool_version,
  });
  validate_manifest_participant_bindings(manifest.request, manifest.result);
  for (const field of [
    "request_digest",
    "result_digest",
    "validation_digest",
    "proof_digest",
    "reproducible_digest",
  ]) {
    if (manifest[field] !== expected[field]) {
      manifest_error(`Manifest ${field} is inconsistent`, {
        expected: expected[field],
        actual: manifest[field],
      });
    }
  }
  return manifest;
}

function validate_manifest_replay(manifest, current) {
  validate_transaction_manifest(manifest);
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    manifest_error("Manifest replay input must be an object");
  }
  const current_request_digest = canonical_digest(
    reproducible_manifest_section(
      sorted_manifest_data(current.request),
      "request",
    ),
  );
  if (current_request_digest !== manifest.request_digest) {
    replay_conflict(
      "request_digest",
      manifest.request_digest,
      current_request_digest,
    );
  }
  const source_bindings = validate_manifest_participant_bindings(
    manifest.request,
    manifest.result,
  );
  for (const file of manifest.request.files || []) {
    const expected = source_bindings.get(file.id);
    const actual = current.source_digests && current.source_digests[file.id];
    if (actual !== expected)
      replay_conflict(`source_digest:${file.id}`, expected, actual);
  }
  for (const field of ["profile_digest", "capability_digest", "tool_version"]) {
    if (current[field] !== manifest[field]) {
      replay_conflict(field, manifest[field], current[field]);
    }
  }
  return { ok: true, reproducible_digest: manifest.reproducible_digest };
}

module.exports = {
  create_transaction_manifest,
  validate_manifest_replay,
  validate_transaction_manifest,
};
