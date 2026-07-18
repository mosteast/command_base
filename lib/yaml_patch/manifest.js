"use strict";

const path = require("node:path");

const {
  canonical_digest,
  clone_json_value,
  validate_artifact_version,
} = require("./artifact_version");
const { Yaml_patch_error } = require("./error");

const NON_REPRODUCIBLE_FIELD = new Set([
  "source_path",
  "temp_path",
  "timestamp",
  "transaction_id",
  "transaction_digest",
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
    Object.entries(value)
      .filter(([field]) => !NON_REPRODUCIBLE_FIELD.has(field))
      .map(([field, item]) => [field, reproducible_value(item)]),
  );
}

function reproducible_manifest_section(value) {
  const reproducible = reproducible_value(value);
  if (Array.isArray(reproducible.files)) {
    for (const file of reproducible.files) {
      if (
        typeof file.path === "string" &&
        (path.isAbsolute(file.path) || path.win32.isAbsolute(file.path))
      ) {
        delete file.path;
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
    request_digest: canonical_digest(reproducible_manifest_section(request)),
    result_digest: canonical_digest(reproducible_manifest_section(result)),
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
  const proven_digest =
    result_file.original_digest ||
    (result_file.proof && result_file.proof.original_digest);
  if (
    typeof proven_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(proven_digest)
  ) {
    manifest_error("Manifest participant has no proven source digest", {
      file_id: request_file.id,
    });
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
  return new Map(
    request.files.map((request_file) => [
      request_file.id,
      source_binding_for_participant(request_file, result),
    ]),
  );
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
    reproducible_manifest_section(sorted_manifest_data(current.request)),
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
