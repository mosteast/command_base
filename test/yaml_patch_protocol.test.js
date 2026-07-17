import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ARTIFACT_VERSION,
  ERROR_CODE_CATEGORY,
  Yaml_patch_error,
  assert_known_fields,
  assert_object,
  canonical_digest,
  canonical_json,
  create_diagnostic,
  error_response,
  exit_code_for_error,
  success_response,
  validate_artifact_version,
} from "../lib/yaml_patch";

describe("yaml_patch artifact versions", () => {
  it("publishes independent immutable version ranges", () => {
    expect(ARTIFACT_VERSION).toEqual({
      envelope: [1, 2],
      query: [1, 2],
      operation: [1, 2],
      transaction: [1],
      profile: [1],
      manifest: [1, 2],
      proof: [1, 2],
      structured_diff: [1],
      cursor: [1],
      locator: [1, 2],
      journal: [1],
      migration: [1],
    });
    expect(Object.isFrozen(ARTIFACT_VERSION)).toBe(true);
    expect(
      Object.values(ARTIFACT_VERSION).every((versions) =>
        Object.isFrozen(versions),
      ),
    ).toBe(true);
  });

  it("strictly accepts only registered artifact kind and integer versions", () => {
    for (const [kind, versions] of Object.entries(ARTIFACT_VERSION)) {
      for (const version of versions) {
        expect(validate_artifact_version(kind, version)).toBe(version);
      }
    }

    for (const [kind, version] of [
      ["query", 99],
      ["unknown", 1],
      ["query", "1"],
      ["query", 1.5],
      ["query", undefined],
      ["query", Object.create(null)],
    ]) {
      expect(() => validate_artifact_version(kind, version)).toThrowError(
        expect.objectContaining({
          name: "Yaml_patch_error",
          code: "PROTOCOL_VERSION_UNSUPPORTED",
        }),
      );
    }
  });
});

describe("yaml_patch canonical JSON", () => {
  it("recursively sorts object keys while preserving array order", () => {
    const left = {
      z: [{ y: 2, x: 1 }, "second"],
      a: { d: 4, c: 3 },
    };
    const right = {
      a: { c: 3, d: 4 },
      z: [{ x: 1, y: 2 }, "second"],
    };

    expect(canonical_json(left)).toBe(
      '{"a":{"c":3,"d":4},"z":[{"x":1,"y":2},"second"]}',
    );
    expect(canonical_json(left)).toBe(canonical_json(right));
    expect(canonical_digest(left)).toBe(canonical_digest(right));
    expect(canonical_digest(left)).toBe(
      crypto
        .createHash("sha256")
        .update(Buffer.from(canonical_json(left), "utf8"))
        .digest("hex"),
    );
    expect(canonical_json([2, 1])).not.toBe(canonical_json([1, 2]));
  });

  it.each([
    ["non-finite number", { value: Number.POSITIVE_INFINITY }],
    ["NaN", { value: Number.NaN }],
    ["undefined", { value: undefined }],
    ["function", { value: () => true }],
    ["bigint", { value: 1n }],
    ["symbol", { value: Symbol("value") }],
  ])("rejects %s with a stable yaml_patch error", (_label, value) => {
    expect(() => canonical_json(value)).toThrowError(
      expect.objectContaining({
        name: "Yaml_patch_error",
        code: "VALIDATION_FAILED",
      }),
    );
  });

  it("rejects cyclic and non-JSON object graphs", () => {
    const cyclic = {};
    cyclic.self = cyclic;

    for (const value of [cyclic, { value: new Date(0) }]) {
      expect(() => canonical_json(value)).toThrowError(
        expect.objectContaining({
          name: "Yaml_patch_error",
          code: "VALIDATION_FAILED",
        }),
      );
    }
  });

  it("rejects sparse arrays instead of silently changing their length", () => {
    const sparse = new Array(1);

    expect(() => canonical_json(sparse)).toThrowError(
      expect.objectContaining({
        name: "Yaml_patch_error",
        code: "VALIDATION_FAILED",
      }),
    );
  });

  it("rejects enumerable accessors that can make digests drift", () => {
    let nonce = 0;
    const value = {
      get nonce() {
        nonce += 1;
        return nonce;
      },
    };

    expect(() => canonical_json(value)).toThrowError(
      expect.objectContaining({
        name: "Yaml_patch_error",
        code: "VALIDATION_FAILED",
      }),
    );
  });

  it("rejects every non-JSON own property without invoking getters", () => {
    let getter_call_count = 0;
    const hidden_data = {};
    Object.defineProperty(hidden_data, "hidden", {
      value: true,
      enumerable: false,
    });
    const hidden_accessor = {};
    Object.defineProperty(hidden_accessor, "hidden", {
      enumerable: false,
      get() {
        getter_call_count += 1;
        return true;
      },
    });
    const symbol_data = { value: true };
    symbol_data[Symbol("hidden")] = true;
    const array_extra_string = ["value"];
    array_extra_string.extra = true;
    const array_extra_symbol = ["value"];
    array_extra_symbol[Symbol("extra")] = true;
    const array_extra_accessor = ["value"];
    Object.defineProperty(array_extra_accessor, "extra", {
      enumerable: false,
      get() {
        getter_call_count += 1;
        return true;
      },
    });

    for (const value of [
      hidden_data,
      hidden_accessor,
      symbol_data,
      array_extra_string,
      array_extra_symbol,
      array_extra_accessor,
    ]) {
      expect(() => canonical_json(value)).toThrowError(
        expect.objectContaining({
          name: "Yaml_patch_error",
          code: "VALIDATION_FAILED",
        }),
      );
    }
    expect(getter_call_count).toBe(0);
  });
});

describe("yaml_patch shared schema validation", () => {
  it("accepts plain objects and rejects arrays and null", () => {
    const value = { version: 1 };
    expect(assert_object(value, "request")).toBe(value);
    expect(() => assert_object([], "request")).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
    expect(() => assert_object(null, "request")).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("rejects every unknown schema field", () => {
    const value = { version: 1, unexpected: true };
    expect(() =>
      assert_known_fields(value, ["version"], "request"),
    ).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        details: { label: "request", field: "unexpected" },
      }),
    );
  });

  it("rejects hidden, symbol, and accessor fields without invoking getters", () => {
    let getter_call_count = 0;
    const hidden_unknown = { version: 1 };
    Object.defineProperty(hidden_unknown, "unexpected", {
      value: true,
      enumerable: false,
    });
    const symbol_field = { version: 1 };
    symbol_field[Symbol("unexpected")] = true;
    const known_accessor = { version: 1 };
    Object.defineProperty(known_accessor, "known", {
      enumerable: true,
      get() {
        getter_call_count += 1;
        return true;
      },
    });
    const hidden_accessor = { version: 1 };
    Object.defineProperty(hidden_accessor, "unexpected", {
      enumerable: false,
      get() {
        getter_call_count += 1;
        return true;
      },
    });

    for (const value of [
      hidden_unknown,
      symbol_field,
      known_accessor,
      hidden_accessor,
    ]) {
      expect(() =>
        assert_known_fields(value, ["version", "known"], "request"),
      ).toThrowError(
        expect.objectContaining({
          name: "Yaml_patch_error",
          code: "VALIDATION_FAILED",
        }),
      );
    }
    expect(getter_call_count).toBe(0);
  });
});

describe("yaml_patch diagnostics", () => {
  it("creates a complete stable diagnostic without dropping core location", () => {
    const input = {
      code: "PROFILE_VIOLATION",
      severity: "error",
      rule_id: "required-field",
      file: "config/app.yaml",
      document: 0,
      line: 4,
      column: 7,
      path: [{ mapping_key: "service" }],
      violation: "required field is missing",
      suggested_action: "add the required mapping field",
      projection: { name: "api" },
    };

    expect(create_diagnostic(input)).toEqual(input);
  });

  it("rejects incomplete diagnostics and unknown fields", () => {
    expect(() => create_diagnostic({ code: "PROFILE_VIOLATION" })).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
    expect(() =>
      create_diagnostic({
        code: "PROFILE_VIOLATION",
        severity: "error",
        rule_id: "rule",
        file: "config.yaml",
        document: 0,
        line: 1,
        column: 1,
        path: [],
        violation: "invalid",
        suggested_action: "fix it",
        unexpected: true,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        details: { label: "diagnostic", field: "unexpected" },
      }),
    );
  });
});

describe("yaml_patch error registry and exit codes", () => {
  const required_category_by_code = {
    NO_MATCH: "query_conflict",
    AMBIGUOUS_MATCH: "query_conflict",
    EXPECTATION_FAILED: "query_conflict",
    SOURCE_CHANGED: "query_conflict",
    TARGET_CHANGED: "query_conflict",
    PRECONDITION_FAILED: "query_conflict",
    VALIDATION_FAILED: "validation",
    PROFILE_VIOLATION: "validation",
    IDENTITY_VIOLATION: "validation",
    REFERENCE_VIOLATION: "validation",
    CYCLE_DETECTED: "validation",
    UNSUPPORTED_EDIT_SHAPE: "limit_structure_capability",
    CROSS_BOUNDARY_DEPENDENCY: "limit_structure_capability",
    CHANGE_LIMIT_EXCEEDED: "limit_structure_capability",
    UNSAFE_CONCURRENCY: "concurrency",
    ATOMIC_WRITE_UNAVAILABLE: "write_proof_recovery",
    BYTE_GUARANTEE_FAILED: "write_proof_recovery",
    RECOVERY_REQUIRED: "write_proof_recovery",
    PROTOCOL_VERSION_UNSUPPORTED: "request_protocol",
    INTERNAL_ERROR: "internal",
  };

  it("registers every required P-013 error code in a stable category", () => {
    expect(ERROR_CODE_CATEGORY).toMatchObject(required_category_by_code);
    for (const [code, category] of Object.entries(required_category_by_code)) {
      expect(new Yaml_patch_error(code, "failure").category).toBe(category);
    }
  });

  it("keeps existing v1 error codes in stable categories", () => {
    expect(ERROR_CODE_CATEGORY).toMatchObject({
      ANCHOR_CONFLICT: "validation",
      INVALID_FRAGMENT: "request_protocol",
      INVALID_RESULT: "validation",
      OUTPUT_EXISTS: "request_protocol",
      UNSUPPORTED_EDIT_UNIT: "limit_structure_capability",
      UNSUPPORTED_ENCODING: "limit_structure_capability",
      UNSUPPORTED_FILE_TYPE: "limit_structure_capability",
      YAML_DIAGNOSTIC: "validation",
    });
  });

  it("maps success, no-op, categories, and unknown errors to fixed exits", () => {
    expect(exit_code_for_error()).toBe(0);
    expect(exit_code_for_error({ no_op: true })).toBe(0);
    expect(exit_code_for_error({ ok: true, no_op: true })).toBe(0);
    expect(
      exit_code_for_error(
        new Yaml_patch_error("PROTOCOL_VERSION_UNSUPPORTED", "failure"),
      ),
    ).toBe(2);
    expect(
      exit_code_for_error(new Yaml_patch_error("SOURCE_CHANGED", "failure")),
    ).toBe(3);
    expect(
      exit_code_for_error(new Yaml_patch_error("PROFILE_VIOLATION", "failure")),
    ).toBe(4);
    expect(
      exit_code_for_error(
        new Yaml_patch_error("UNSAFE_CONCURRENCY", "failure"),
      ),
    ).toBe(5);
    expect(
      exit_code_for_error(
        new Yaml_patch_error("CHANGE_LIMIT_EXCEEDED", "failure"),
      ),
    ).toBe(6);
    expect(
      exit_code_for_error(
        new Yaml_patch_error("BYTE_GUARANTEE_FAILED", "failure"),
      ),
    ).toBe(7);
    expect(exit_code_for_error(new Error("failure"))).toBe(70);
    expect(
      exit_code_for_error(new Yaml_patch_error("UNKNOWN_CODE", "failure")),
    ).toBe(70);
    expect(
      new Yaml_patch_error("toString", "inherited registry key").category,
    ).toBe("internal");
    expect(
      exit_code_for_error(
        new Yaml_patch_error("toString", "inherited registry key"),
      ),
    ).toBe(70);
  });
});

describe("yaml_patch response envelopes", () => {
  it("keeps default v1 envelopes readable and supports explicit v2", () => {
    expect(success_response({ changed: false })).toEqual({
      ok: true,
      protocol_version: 1,
      result: { changed: false },
    });
    expect(
      error_response(new Yaml_patch_error("NO_MATCH", "not found")),
    ).toEqual({
      ok: false,
      protocol_version: 1,
      code: "NO_MATCH",
      message: "not found",
      recoverable: false,
      next_action: "review the error details",
      details: {},
    });
    expect(success_response({ changed: true }, 2)).toEqual({
      ok: true,
      protocol_version: 2,
      result: { changed: true },
    });
    expect(
      error_response(new Yaml_patch_error("NO_MATCH", "not found"), 2),
    ).toMatchObject({ ok: false, protocol_version: 2, code: "NO_MATCH" });
    expect(() => success_response({}, 3)).toThrowError(
      expect.objectContaining({ code: "PROTOCOL_VERSION_UNSUPPORTED" }),
    );
  });
});
