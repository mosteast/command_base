import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

import diff_module from "../lib/yaml_patch/diff";
import manifest_module from "../lib/yaml_patch/manifest";
import range_set_module from "../lib/yaml_patch/range_set";
import source_module from "../lib/yaml_patch/source";

const { create_file_diff } = diff_module;
const {
  create_transaction_manifest,
  validate_manifest_replay,
  validate_transaction_manifest,
} = manifest_module;
const { apply_range_set } = range_set_module;
const { sha256_digest } = source_module;
const public_api = createRequire(import.meta.url)("../lib/yaml_patch");

function diff_fixture(path = "/workspace/config.yaml") {
  const original_buffer = Buffer.from("value: old\n");
  const start_byte = original_buffer.indexOf("old");
  const applied = apply_range_set(original_buffer, [
    {
      start_byte,
      end_byte: start_byte + 3,
      replacement_buffer: Buffer.from("new"),
      operation_id: "replace",
      operation_order: 0,
    },
  ]);
  return {
    file_id: "config",
    path,
    original_buffer,
    candidate_buffer: applied.candidate_buffer,
    proof: applied.proof,
    operations: [
      {
        id: "replace",
        type: "replace_scalar_raw",
        locator: "original-locator",
        handle: "bound-value",
        original_range: { start_byte, end_byte: start_byte + 3 },
        candidate_range: { start_byte, end_byte: start_byte + 3 },
        before: { raw: "old", typed: { type: "string", value: "old" } },
        after: { raw: "new", typed: { type: "string", value: "new" } },
        no_op: false,
      },
    ],
  };
}

describe("YAML transaction diffs and manifests", () => {
  it("publishes the Task 8 library APIs", () => {
    for (const name of [
      "compile_subtree_operation",
      "create_file_diff",
      "create_transaction_manifest",
      "participant_digest_for",
      "plan_transaction",
      "validate_manifest_replay",
      "validate_transaction_manifest",
    ]) {
      expect(public_api[name], name).toBeTypeOf("function");
    }
  });

  it("produces text, structured, and semantic previews with exact operation evidence", () => {
    const preview = create_file_diff(diff_fixture());

    expect(preview.text).toContain("--- config");
    expect(preview.text).toContain("-value: old");
    expect(preview.text).toContain("+value: new");
    expect(preview.structured).toMatchObject({
      format: "yaml_patch-structured-diff",
      version: 1,
      file_id: "config",
      no_op: false,
      byte_counts: {
        deleted: 3,
        inserted: 3,
        touched: 6,
      },
      operations: [
        {
          id: "replace",
          type: "replace_scalar_raw",
          locator: "original-locator",
          handle: "bound-value",
          original_range: { start_byte: 7, end_byte: 10 },
          candidate_range: { start_byte: 7, end_byte: 10 },
          before: { raw: "old", typed: { type: "string", value: "old" } },
          after: { raw: "new", typed: { type: "string", value: "new" } },
          no_op: false,
        },
      ],
    });
    expect(preview.semantic).toEqual(
      expect.objectContaining({
        no_op: false,
        operation_count: 1,
        operations: [
          expect.objectContaining({ id: "replace", handle: "bound-value" }),
        ],
      }),
    );
  });

  it("represents a byte-identical preview as an explicit no-op", () => {
    const fixture = diff_fixture();
    const no_op = apply_range_set(fixture.original_buffer, []);
    const preview = create_file_diff({
      ...fixture,
      candidate_buffer: fixture.original_buffer,
      proof: no_op.proof,
      operations: [],
    });

    expect(preview.text).toBe("");
    expect(preview.structured).toMatchObject({ no_op: true, operations: [] });
    expect(preview.semantic).toMatchObject({ no_op: true, operation_count: 0 });
  });

  it("separates canonical request/result data and excludes paths and runtime fields from its digest", () => {
    const fixture = diff_fixture();
    const preview = create_file_diff(fixture);
    const request = {
      version: 1,
      files: [
        {
          id: fixture.file_id,
          path: fixture.path,
          digest: sha256_digest(fixture.original_buffer),
        },
      ],
      operations: [{ id: "replace", type: "replace_scalar_raw" }],
    };
    const manifest_input = {
      request,
      result: {
        no_op: false,
        files: [
          {
            file_id: fixture.file_id,
            path: fixture.path,
            original_digest: fixture.proof.original_digest,
            candidate_digest: fixture.proof.candidate_digest,
            proof: fixture.proof,
            diff: preview.structured,
          },
        ],
        validation: { diagnostics: [], identity_changes: null },
      },
      profile_digest: "a".repeat(64),
      capability_digest: "b".repeat(64),
      tool_version: "1.0.1",
    };
    const first = create_transaction_manifest(manifest_input);
    const second = create_transaction_manifest({
      ...manifest_input,
      request: {
        ...request,
        files: [{ ...request.files[0], path: "/different/root/config.yaml" }],
      },
      result: {
        ...manifest_input.result,
        files: [
          {
            ...manifest_input.result.files[0],
            path: "/runtime/temp/random.yaml",
          },
        ],
      },
    });

    expect(first).toMatchObject({
      format: "yaml_patch-manifest",
      version: 2,
      request: expect.objectContaining({ operations: expect.any(Array) }),
      result: expect.objectContaining({ files: expect.any(Array) }),
      profile_digest: "a".repeat(64),
      capability_digest: "b".repeat(64),
      validation_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      proof_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      reproducible_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(first.reproducible_digest).toBe(second.reproducible_digest);
    expect(JSON.stringify(first)).not.toMatch(
      /timestamp|random|transaction_id|temp_path/,
    );
    expect(validate_transaction_manifest(first)).toEqual(first);
  });

  it("keeps semantic relative paths in the reproducible request binding", () => {
    const fixture = diff_fixture();
    const result = {
      no_op: true,
      files: [],
      validation: { diagnostics: [] },
    };
    const request_with_path = (mapping_key) => ({
      version: 1,
      files: [
        {
          id: fixture.file_id,
          path: fixture.path,
          digest: fixture.proof.original_digest,
        },
      ],
      operations: [
        {
          id: "replace",
          type: "replace_scalar_raw",
          target: { handle: "root", path: [{ mapping_key }] },
          raw: "new",
        },
      ],
    });
    const first = create_transaction_manifest({
      request: request_with_path("first"),
      result,
    });
    const second = create_transaction_manifest({
      request: request_with_path("second"),
      result,
    });

    expect(first.request_digest).not.toBe(second.request_digest);
    expect(first.reproducible_digest).not.toBe(second.reproducible_digest);
  });

  it("excludes environment-bound transaction proof paths from reproducibility", () => {
    const request = { version: 1, files: [], operations: [] };
    const result_with_proof = (source_path, transaction_digest) => ({
      no_op: true,
      files: [],
      validation: { diagnostics: [] },
      transaction_proof: {
        format: "yaml_patch-transaction-proof",
        version: 1,
        verified: true,
        operation_order: [],
        files: [
          {
            source_path,
            original_digest: "a".repeat(64),
            candidate_digest: "a".repeat(64),
            no_op: true,
            proof_digest: "b".repeat(64),
          },
        ],
        transaction_digest,
      },
    });
    const first = create_transaction_manifest({
      request,
      result: result_with_proof("/workspace-a/config.yaml", "c".repeat(64)),
    });
    const second = create_transaction_manifest({
      request,
      result: result_with_proof("/workspace-b/config.yaml", "d".repeat(64)),
    });

    expect(first.reproducible_digest).toBe(second.reproducible_digest);
  });

  it("detects replay conflicts in source, profile, capability, and request bindings", () => {
    const fixture = diff_fixture("config.yaml");
    const preview = create_file_diff(fixture);
    const request = {
      version: 1,
      files: [
        {
          id: "config",
          path: "config.yaml",
          digest: fixture.proof.original_digest,
        },
      ],
      operations: [{ id: "replace", type: "replace_scalar_raw" }],
    };
    const manifest = create_transaction_manifest({
      request,
      result: {
        no_op: false,
        files: [
          {
            file_id: "config",
            path: "config.yaml",
            original_digest: fixture.proof.original_digest,
            candidate_digest: fixture.proof.candidate_digest,
            proof: fixture.proof,
            diff: preview.structured,
          },
        ],
        validation: { diagnostics: [] },
      },
      profile_digest: "a".repeat(64),
      capability_digest: "b".repeat(64),
      tool_version: "1.0.1",
    });
    const valid = {
      request,
      source_digests: { config: fixture.proof.original_digest },
      profile_digest: "a".repeat(64),
      capability_digest: "b".repeat(64),
      tool_version: "1.0.1",
    };

    expect(validate_manifest_replay(manifest, valid)).toMatchObject({
      ok: true,
    });
    for (const conflict of [
      { ...valid, source_digests: { config: "f".repeat(64) } },
      { ...valid, profile_digest: "f".repeat(64) },
      { ...valid, capability_digest: "f".repeat(64) },
      { ...valid, tool_version: "2.0.0" },
      { ...valid, request: { ...request, operations: [] } },
    ]) {
      expect(() => validate_manifest_replay(manifest, conflict)).toThrowError(
        expect.objectContaining({ code: "PRECONDITION_FAILED" }),
      );
    }
  });

  it("replay binds the actual source digest when the request omitted it", () => {
    const fixture = diff_fixture("config.yaml");
    const request = {
      version: 1,
      files: [{ id: "config", path: "config.yaml" }],
      operations: [],
    };
    const manifest = create_transaction_manifest({
      request,
      result: {
        no_op: true,
        files: [
          {
            file_id: "config",
            path: "config.yaml",
            original_digest: fixture.proof.original_digest,
            candidate_digest: fixture.proof.original_digest,
            no_op: true,
            proof: fixture.proof,
          },
        ],
        validation: { diagnostics: [] },
      },
    });
    const current = {
      request,
      source_digests: { config: fixture.proof.original_digest },
      profile_digest: null,
      capability_digest: null,
      tool_version: null,
    };

    expect(validate_manifest_replay(manifest, current)).toMatchObject({
      ok: true,
    });
    expect(() =>
      validate_manifest_replay(manifest, {
        ...current,
        source_digests: { config: "f".repeat(64) },
      }),
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  });
});
