import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import profile_module from "../lib/yaml_patch/profile";
import validation_scope_module from "../lib/yaml_patch/validation_scope";

const { load_profile, validate_profile } = profile_module;
const { select_profile_paths } = validation_scope_module;
const public_api = createRequire(import.meta.url)("../lib/yaml_patch");

const complete_profile = {
  version: 1,
  scope: {
    include: ["config/**/*.yaml", "literal/[special].yaml"],
    ignore: ["config/generated/**"],
  },
  node_sets: {
    record: {
      query: {
        version: 2,
        where: { predicate: "node_type", equals: "mapping" },
        select: { kind: "self", missing: "error" },
        projection: { fields: ["path"], missing: "error" },
      },
      fields: {
        allowed: ["tenant", "key", "enabled", "children"],
        required: ["tenant", "key"],
        optional: ["enabled", "children"],
        rules: {
          tenant: { types: ["string"], cardinality: { min: 1, max: 1 } },
          key: {
            types: ["string", "integer"],
            cardinality: { min: 1, max: 1 },
            consistent_type: true,
          },
          children: { types: ["sequence"], child_node_set: "record" },
        },
      },
      field_order: ["tenant", "key", "enabled", "children"],
      diagnostic_projection: ["tenant", "key"],
    },
  },
  identity: [
    {
      rule_id: "record_key",
      node_set: "record",
      fields: ["tenant", "key"],
      unique_scope: "input",
      missing_policy: "error",
      null_policy: "error",
      types: ["string", "integer"],
      immutable_existing: true,
    },
  ],
  protected: [
    {
      rule_id: "record_guard",
      node_set: "record",
      when: {
        predicate: "field_exists",
        field: { key: { type: "string", value: "key" } },
      },
      actions: ["delete", "copy", "identity_modify"],
    },
  ],
  field_aliases: [
    {
      rule_id: "tenant_alias",
      node_set: "record",
      canonical: "tenant",
      aliases: ["tenant_id"],
      severity: "warning",
    },
  ],
};

describe("YAML profile schema", () => {
  it("publishes named profile and validation APIs through the library facade", () => {
    for (const name of [
      "load_profile",
      "validate_profile",
      "select_profile_paths",
      "normalize_validation_scope",
      "validate_profile_candidates",
    ]) {
      expect(public_api[name], name).toBeTypeOf("function");
    }
  });

  it("loads equivalent strict YAML and JSON profile artifacts", () => {
    const yaml_profile = load_profile(
      Buffer.from(`
version: 1
node_sets:
  record:
    query:
      version: 2
      where: { predicate: node_type, equals: mapping }
      select: { kind: self, missing: error }
      projection: { fields: [path], missing: error }
identity:
  - rule_id: record_key
    node_set: record
    fields: [tenant, key]
    unique_scope: input
    missing_policy: error
    null_policy: error
    immutable_existing: true
`),
    );
    const json_profile = load_profile(
      Buffer.from(
        JSON.stringify({
          version: 1,
          node_sets: complete_profile.node_sets,
          identity: complete_profile.identity,
        }),
      ),
    );

    expect(yaml_profile.version).toBe(1);
    expect(yaml_profile.node_sets.record.query.version).toBe(2);
    expect(validate_profile(yaml_profile)).toMatchObject({
      diagnostics: [],
      profile_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(validate_profile(json_profile).profile_digest).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("rejects unsupported versions, multiple documents, parse errors, and unknown fields", () => {
    for (const invalid of [
      { ...complete_profile, version: 99 },
      { ...complete_profile, surprise: true },
      {
        ...complete_profile,
        node_sets: {
          record: { ...complete_profile.node_sets.record, surprise: true },
        },
      },
      {
        ...complete_profile,
        identity: [{ ...complete_profile.identity[0], surprise: true }],
      },
    ]) {
      expect(() => validate_profile(invalid)).toThrowError(
        expect.objectContaining({
          code: expect.stringMatching(
            /^(PROTOCOL_VERSION_UNSUPPORTED|VALIDATION_FAILED)$/,
          ),
        }),
      );
    }

    expect(() => load_profile(Buffer.from("version: [\n"))).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
    expect(() =>
      load_profile(Buffer.from("version: 1\n---\nversion: 1\n")),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("rejects executable values, accessors, aliases, and oversized profile input", () => {
    const accessor = { version: 1, node_sets: {} };
    Object.defineProperty(accessor, "identity", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    });
    expect(() => validate_profile(accessor)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
    expect(() =>
      load_profile(
        Buffer.from("version: 1\nnode_sets: &sets {}\nidentity: *sets\n"),
      ),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() =>
      load_profile(Buffer.alloc(1025, 0x20), { max_bytes: 1024 }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
  });

  it("validates query-backed node sets and every profile rule reference", () => {
    expect(validate_profile(complete_profile).diagnostics).toEqual([]);

    const invalid_cases = [
      {
        ...complete_profile,
        node_sets: {
          record: {
            ...complete_profile.node_sets.record,
            query: { ...complete_profile.node_sets.record.query, version: 1 },
          },
        },
      },
      {
        ...complete_profile,
        identity: [{ ...complete_profile.identity[0], node_set: "missing" }],
      },
      {
        ...complete_profile,
        identity: [
          {
            ...complete_profile.identity[0],
            fields: ["tenant", "undeclared"],
          },
        ],
      },
      {
        ...complete_profile,
        identity: [{ ...complete_profile.identity[0], types: ["mapping"] }],
      },
      {
        ...complete_profile,
        node_sets: {
          record: {
            ...complete_profile.node_sets.record,
            fields: {
              ...complete_profile.node_sets.record.fields,
              rules: {
                ...complete_profile.node_sets.record.fields.rules,
                children: { types: ["sequence"], child_node_set: "missing" },
              },
            },
          },
        },
      },
      {
        ...complete_profile,
        protected: [{ ...complete_profile.protected[0], actions: ["execute"] }],
      },
      {
        ...complete_profile,
        node_sets: {
          record: {
            ...complete_profile.node_sets.record,
            query: {
              ...complete_profile.node_sets.record.query,
              expect_matches: { exact: 1 },
            },
          },
        },
      },
      {
        ...complete_profile,
        field_aliases: [
          { ...complete_profile.field_aliases[0], canonical: "undeclared" },
        ],
      },
    ];
    for (const invalid of invalid_cases) {
      expect(() => validate_profile(invalid)).toThrowError(
        expect.objectContaining({
          code: expect.stringMatching(
            /^(VALIDATION_FAILED|PROTOCOL_VERSION_UNSUPPORTED)$/,
          ),
        }),
      );
    }
  });

  it("validates selected per-operation diagnostic rule ids", () => {
    expect(
      validate_profile({
        ...complete_profile,
        per_operation_rule: ["record_key", "record.fields.tenant.required"],
      }).diagnostics,
    ).toEqual([]);
    expect(
      validate_profile(complete_profile).profile.per_operation_rule || [],
    ).toEqual([]);

    for (const per_operation_rule of [
      [true],
      ["record_key", "record_key"],
      ["unknown_rule"],
    ]) {
      expect(() =>
        validate_profile({ ...complete_profile, per_operation_rule }),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }
  });

  it("requires coherent field declarations, ordering, and diagnostic projection", () => {
    const invalid_fields = [
      {
        allowed: ["tenant"],
        required: ["missing"],
        optional: [],
        rules: {},
      },
      {
        allowed: ["tenant"],
        required: ["tenant"],
        optional: ["tenant"],
        rules: {},
      },
      {
        allowed: ["tenant"],
        required: [],
        optional: [],
        rules: { missing: { types: ["string"] } },
      },
    ];
    for (const fields of invalid_fields) {
      expect(() =>
        validate_profile({
          version: 1,
          node_sets: {
            record: {
              ...complete_profile.node_sets.record,
              fields,
            },
          },
        }),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }

    for (const field of ["missing", "tenant", "tenant"]) {
      const field_order = field === "missing" ? ["missing"] : ["tenant", field];
      expect(() =>
        validate_profile({
          version: 1,
          node_sets: {
            record: {
              ...complete_profile.node_sets.record,
              field_order,
            },
          },
        }),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }
  });

  it("accepts simple/composite identities and rejects ambiguous policies", () => {
    expect(
      validate_profile({
        version: 1,
        node_sets: complete_profile.node_sets,
        identity: [
          {
            ...complete_profile.identity[0],
            rule_id: "record_key_simple",
            fields: ["key"],
          },
          complete_profile.identity[0],
        ],
      }).diagnostics,
    ).toEqual([]);

    const nested_node_sets = structuredClone(complete_profile.node_sets);
    nested_node_sets.record.fields.allowed.push("metadata");
    nested_node_sets.record.fields.optional.push("metadata");
    nested_node_sets.record.fields.rules.metadata = { types: ["mapping"] };
    expect(
      validate_profile({
        version: 1,
        node_sets: nested_node_sets,
        identity: [
          {
            ...complete_profile.identity[0],
            fields: [["metadata", "tenant"], "key"],
          },
        ],
      }).diagnostics,
    ).toEqual([]);

    for (const identity of [
      { ...complete_profile.identity[0], fields: [] },
      { ...complete_profile.identity[0], fields: ["tenant", "tenant"] },
      {
        ...complete_profile.identity[0],
        fields: [
          ["metadata", "tenant"],
          ["metadata", "tenant"],
        ],
      },
      { ...complete_profile.identity[0], unique_scope: "global_magic" },
      { ...complete_profile.identity[0], missing_policy: "guess" },
      { ...complete_profile.identity[0], null_policy: "guess" },
      { ...complete_profile.identity[0], immutable_existing: "yes" },
    ]) {
      expect(() =>
        validate_profile({
          version: 1,
          node_sets: complete_profile.node_sets,
          identity: [identity],
        }),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }
  });

  it("matches profile scope deterministically while treating existing special paths literally", () => {
    const paths = [
      "/repo/config/a.yaml",
      "/repo/config/generated/a.yaml",
      "/repo/literal/[special].yaml",
      "/repo/literal/s.yaml",
      "/repo/other.yaml",
    ];
    expect(
      select_profile_paths(paths, complete_profile.scope, {
        root_path: "/repo",
      }),
    ).toEqual(["/repo/config/a.yaml", "/repo/literal/[special].yaml"]);
    expect(
      select_profile_paths(
        paths,
        {
          include: ["literal/[special].yaml"],
          ignore: [],
        },
        { root_path: "/repo" },
      ),
    ).toEqual(["/repo/literal/[special].yaml"]);
  });
});
