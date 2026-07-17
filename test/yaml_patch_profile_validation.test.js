import { describe, expect, it } from "vitest";

import source_module from "../lib/yaml_patch/source";
import parser_module from "../lib/yaml_patch/parser";
import node_index_module from "../lib/yaml_patch/node_index";
import profile_validate_module from "../lib/yaml_patch/profile_validate";

const { create_source_record } = source_module;
const { parse_yaml_source } = parser_module;
const { build_node_index } = node_index_module;
const { validate_profile_candidates } = profile_validate_module;

function input(text, requested_path) {
  const source = create_source_record(Buffer.from(text), { requested_path });
  return { index: build_node_index(source, parse_yaml_source(source)) };
}

function profile(overrides = {}) {
  return {
    version: 1,
    node_sets: {
      record: {
        query: {
          version: 2,
          where: {
            all: [
              { predicate: "node_type", equals: "mapping" },
              {
                predicate: "relation",
                relation: "parent",
                where: {
                  predicate: "addressable_type",
                  equals: "sequence_item",
                },
              },
            ],
          },
          select: { kind: "self", missing: "error" },
          projection: { fields: ["path"], missing: "error" },
          page: { limit: 1000 },
        },
        fields: {
          allowed: ["tenant", "key", "enabled", "children"],
          required: ["tenant", "key"],
          optional: ["enabled", "children"],
          rules: {
            tenant: {
              types: ["string"],
              cardinality: { min: 1, max: 1 },
            },
            key: {
              types: ["string"],
              cardinality: { min: 1, max: 1 },
              consistent_type: true,
            },
            enabled: { types: ["boolean"] },
            children: { types: ["sequence"], child_node_set: "record" },
          },
        },
        field_order: ["tenant", "key", "enabled", "children"],
        diagnostic_projection: ["tenant", "key"],
      },
    },
    identity: [
      {
        rule_id: "record_identity",
        node_set: "record",
        fields: ["tenant", "key"],
        unique_scope: "input",
        missing_policy: "error",
        null_policy: "error",
        types: ["string"],
        immutable_existing: true,
      },
    ],
    protected: [],
    field_aliases: [
      {
        rule_id: "tenant_alias",
        node_set: "record",
        canonical: "tenant",
        aliases: ["tenant_id"],
        severity: "warning",
      },
    ],
    ...overrides,
  };
}

function validate({
  original,
  candidate = original,
  used_profile = profile(),
  provenance = [],
}) {
  return validate_profile_candidates({
    profile: used_profile,
    original_inputs: original,
    candidate_inputs: candidate,
    operation_provenance: provenance,
    scope: { kind: "all_inputs" },
  });
}

function diagnostic_shape(code, rule_id) {
  return expect.objectContaining({
    code,
    severity: expect.stringMatching(/^(error|warning)$/),
    rule_id,
    file: expect.any(String),
    document: expect.any(Number),
    line: expect.any(Number),
    column: expect.any(Number),
    path: expect.any(Array),
    violation: expect.any(String),
    suggested_action: expect.any(String),
  });
}

describe("YAML profile validation", () => {
  it("accepts generic valid mappings without generating business values", () => {
    const valid = [
      input("- tenant: alpha\n  key: one\n  enabled: true\n", "/repo/a.yaml"),
      input("- tenant: beta\n  key: two\n", "/repo/b.yaml"),
    ];
    const result = validate({ original: valid });
    expect(result.diagnostics).toEqual([]);
    expect(result.identity_changes).toEqual({
      added: 0,
      deleted: 0,
      modified: 0,
      affected: 0,
    });
  });

  it("reports allowed, required, type, cardinality, and consistent-type violations", () => {
    const candidate = [
      input(
        `- tenant: alpha
  key: one
  enabled: yes
  unexpected: value
- tenant: beta
  key: 2
`,
        "/repo/candidate.yaml",
      ),
    ];
    const result = validate({
      original: [input("[]\n", "/repo/candidate.yaml")],
      candidate,
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        diagnostic_shape("PROFILE_VIOLATION", "record.fields.allowed"),
        diagnostic_shape("PROFILE_VIOLATION", "record.fields.enabled.type"),
        diagnostic_shape("PROFILE_VIOLATION", "record.fields.key.type"),
        diagnostic_shape(
          "PROFILE_VIOLATION",
          "record.fields.key.consistent_type",
        ),
      ]),
    );
    expect(result.diagnostics[0].projection).toEqual(
      expect.objectContaining({
        tenant: expect.anything(),
        key: expect.anything(),
      }),
    );
  });

  it("detects missing/null identity components and duplicate composite identities", () => {
    const candidate = [
      input(
        `- tenant: alpha
  key: one
- tenant: alpha
  key: one
- tenant: null
  key: three
`,
        "/repo/duplicate.yaml",
      ),
    ];
    const result = validate({
      original: [input("[]\n", "/repo/duplicate.yaml")],
      candidate,
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        diagnostic_shape("IDENTITY_VIOLATION", "record_identity"),
      ]),
    );
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === "IDENTITY_VIOLATION",
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("resolves nested identity field paths without guessing dotted-key syntax", () => {
    const base_profile = profile();
    const nested_record = structuredClone(base_profile.node_sets.record);
    nested_record.fields.allowed.push("metadata");
    nested_record.fields.optional.push("metadata");
    nested_record.fields.rules.metadata = { types: ["mapping"] };
    const nested_profile = profile({
      node_sets: { record: nested_record },
      identity: [
        {
          ...base_profile.identity[0],
          fields: [["metadata", "tenant"], "key"],
        },
      ],
    });
    const candidate = [
      input(
        `- metadata: { tenant: alpha }
  key: one
- metadata: { tenant: alpha }
  key: one
`,
        "/repo/nested.yaml",
      ),
    ];
    expect(
      validate({
        original: [input("[]\n", "/repo/nested.yaml")],
        candidate,
        used_profile: nested_profile,
      }).diagnostics,
    ).toEqual(
      expect.arrayContaining([
        diagnostic_shape("IDENTITY_VIOLATION", "record_identity"),
      ]),
    );
  });

  it("applies identity uniqueness scopes independently", () => {
    const original = [
      input("- tenant: alpha\n  key: one\n", "/repo/a.yaml"),
      input("- tenant: alpha\n  key: one\n", "/repo/b.yaml"),
    ];
    expect(validate({ original }).diagnostics).toEqual(
      expect.arrayContaining([
        diagnostic_shape("IDENTITY_VIOLATION", "record_identity"),
      ]),
    );
    const file_scope = profile({
      identity: [{ ...profile().identity[0], unique_scope: "file" }],
    });
    expect(
      validate({ original, used_profile: file_scope }).diagnostics,
    ).toEqual([]);
  });

  it("rejects existing identity modification/deletion/copy but treats proven moves as preservation", () => {
    const original = [
      input("- tenant: alpha\n  key: one\n", "/repo/a.yaml"),
      input("[]\n", "/repo/b.yaml"),
    ];
    const modified = [
      input("- tenant: alpha\n  key: changed\n", "/repo/a.yaml"),
      input("[]\n", "/repo/b.yaml"),
    ];
    expect(validate({ original, candidate: modified }).diagnostics).toEqual(
      expect.arrayContaining([
        diagnostic_shape("IDENTITY_VIOLATION", "record_identity"),
      ]),
    );

    const moved = [
      input("[]\n", "/repo/a.yaml"),
      input("- tenant: alpha\n  key: one\n", "/repo/b.yaml"),
    ];
    const move_result = validate({
      original,
      candidate: moved,
      provenance: [
        {
          operation_id: "move-1",
          type: "move",
          source: { file: "/repo/a.yaml", identity: ["alpha", "one"] },
          target: { file: "/repo/b.yaml", identity: ["alpha", "one"] },
        },
      ],
    });
    expect(move_result.diagnostics).toEqual([]);
    expect(move_result.identity_changes).toEqual({
      added: 0,
      deleted: 0,
      modified: 0,
      affected: 1,
    });

    const copied = [
      original[0],
      input("- tenant: alpha\n  key: one\n", "/repo/b.yaml"),
    ];
    expect(validate({ original, candidate: copied }).diagnostics).toEqual(
      expect.arrayContaining([
        diagnostic_shape("IDENTITY_VIOLATION", "record_identity"),
      ]),
    );
  });

  it("does not invent a missing identity for a newly created node", () => {
    const original = [input("[]\n", "/repo/a.yaml")];
    const candidate = [
      input("- tenant: alpha\n  enabled: true\n", "/repo/a.yaml"),
    ];
    const result = validate({ original, candidate });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        diagnostic_shape("IDENTITY_VIOLATION", "record_identity"),
      ]),
    );
    expect(candidate[0].index.source.text).not.toContain("key:");
  });

  it("enforces protected actions and identity-change limits from provenance", () => {
    const guarded = profile({
      protected: [
        {
          rule_id: "record_guard",
          node_set: "record",
          actions: ["delete", "copy", "identity_modify"],
        },
      ],
    });
    const original = [input("- tenant: alpha\n  key: one\n", "/repo/a.yaml")];
    const candidate = [input("[]\n", "/repo/a.yaml")];
    const result = validate({
      original,
      candidate,
      used_profile: guarded,
      provenance: [
        {
          operation_id: "delete-1",
          type: "delete",
          source: { file: "/repo/a.yaml", identity: ["alpha", "one"] },
        },
      ],
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        diagnostic_shape("PROFILE_VIOLATION", "record_guard"),
      ]),
    );
    expect(() =>
      validate_profile_candidates({
        profile: guarded,
        original_inputs: original,
        candidate_inputs: candidate,
        operation_provenance: [],
        scope: { kind: "all_inputs" },
        limits: { max_deleted_identity: 0 },
      }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
  });

  it("protects selected nodes without requiring an identity rule", () => {
    const guarded = profile({
      identity: [],
      protected: [
        {
          rule_id: "anonymous_guard",
          node_set: "record",
          actions: ["delete"],
        },
      ],
    });
    const result = validate({
      original: [
        input("- tenant: alpha\n  key: one\n", "/repo/anonymous.yaml"),
      ],
      candidate: [input("[]\n", "/repo/anonymous.yaml")],
      used_profile: guarded,
      provenance: [
        {
          operation_id: "delete-anonymous",
          type: "delete",
          source: {
            file: "/repo/anonymous.yaml",
            document: 0,
            path: [{ sequence_index: 0 }],
          },
        },
      ],
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        diagnostic_shape("PROFILE_VIOLATION", "anonymous_guard"),
      ]),
    );
  });

  it("emits profile-controlled alias severity with core locations", () => {
    const candidate = [
      input("- tenant_id: alpha\n  key: one\n", "/repo/alias.yaml"),
    ];
    const result = validate({
      original: [input("[]\n", "/repo/alias.yaml")],
      candidate,
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PROFILE_VIOLATION",
          severity: "warning",
          rule_id: "tenant_alias",
          file: "/repo/alias.yaml",
          line: expect.any(Number),
          column: expect.any(Number),
          path: expect.any(Array),
        }),
      ]),
    );
  });

  it("applies shared field definitions only to explicitly selected node sets", () => {
    const candidate = [
      input(
        `metadata:
  arbitrary: 1
records:
  - tenant: alpha
    key: one
`,
        "/repo/scoped.yaml",
      ),
    ];
    expect(validate({ original: candidate }).diagnostics).toEqual([]);
  });

  it("validates declared child node-set membership without applying it globally", () => {
    const base_profile = profile();
    const child_profile = profile({
      node_sets: {
        container: {
          ...base_profile.node_sets.record,
          fields: {
            ...base_profile.node_sets.record.fields,
            rules: {
              ...base_profile.node_sets.record.fields.rules,
              children: {
                types: ["sequence"],
                child_node_set: "eligible_child",
              },
            },
          },
        },
        eligible_child: {
          query: {
            version: 2,
            where: {
              all: [
                { predicate: "node_type", equals: "mapping" },
                {
                  predicate: "field_exists",
                  field: { key: { type: "string", value: "key" } },
                },
              ],
            },
            select: { kind: "self", missing: "error" },
            projection: { fields: ["path"], missing: "error" },
          },
        },
      },
      identity: [],
      field_aliases: [],
    });
    const candidate = [
      input(
        `- tenant: alpha
  key: root
  children:
    - tenant: alpha
      key: child
    - arbitrary: value
`,
        "/repo/child.yaml",
      ),
    ];
    expect(
      validate({ original: candidate, used_profile: child_profile })
        .diagnostics,
    ).toEqual(
      expect.arrayContaining([
        diagnostic_shape(
          "PROFILE_VIOLATION",
          "container.fields.children.child_node_set",
        ),
      ]),
    );
  });

  it("applies protected predicates only to the explicitly matched nodes", () => {
    const guarded = profile({
      protected: [
        {
          rule_id: "enabled_guard",
          node_set: "record",
          when: {
            predicate: "field_value",
            field: { key: { type: "string", value: "enabled" } },
            comparison: {
              equals: { type: "boolean", value: true },
            },
          },
          actions: ["delete"],
        },
      ],
    });
    const original = [
      input(
        `- tenant: alpha
  key: one
  enabled: true
- tenant: beta
  key: two
  enabled: false
`,
        "/repo/guard.yaml",
      ),
    ];
    const result = validate({
      original,
      candidate: [input("[]\n", "/repo/guard.yaml")],
      used_profile: guarded,
      provenance: [
        {
          operation_id: "delete-alpha",
          type: "delete",
          source: { file: "/repo/guard.yaml", identity: ["alpha", "one"] },
        },
        {
          operation_id: "delete-beta",
          type: "delete",
          source: { file: "/repo/guard.yaml", identity: ["beta", "two"] },
        },
      ],
    });
    const protection = result.diagnostics.filter(
      (item) => item.rule_id === "enabled_guard",
    );
    expect(protection.length).toBeGreaterThan(0);
    expect(protection.every((item) => item.projection.tenant === "alpha")).toBe(
      true,
    );
  });

  it("independently blocks protected identity modification when identity immutability is disabled", () => {
    const base_profile = profile();
    const guarded = profile({
      identity: [{ ...base_profile.identity[0], immutable_existing: false }],
      protected: [
        {
          rule_id: "identity_guard",
          node_set: "record",
          actions: ["identity_modify"],
        },
      ],
    });
    const result = validate({
      original: [input("- tenant: alpha\n  key: one\n", "/repo/identity.yaml")],
      candidate: [
        input("- tenant: alpha\n  key: changed\n", "/repo/identity.yaml"),
      ],
      used_profile: guarded,
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        diagnostic_shape("PROFILE_VIOLATION", "identity_guard"),
      ]),
    );
  });

  it("independently blocks copying a protected node from final identity counts", () => {
    const base_profile = profile();
    const guarded = profile({
      identity: [{ ...base_profile.identity[0], immutable_existing: false }],
      protected: [
        {
          rule_id: "copy_guard",
          node_set: "record",
          actions: ["copy"],
        },
      ],
    });
    const result = validate({
      original: [
        input("- tenant: alpha\n  key: one\n", "/repo/a.yaml"),
        input("[]\n", "/repo/b.yaml"),
      ],
      candidate: [
        input("- tenant: alpha\n  key: one\n", "/repo/a.yaml"),
        input("- tenant: alpha\n  key: one\n", "/repo/b.yaml"),
      ],
      used_profile: guarded,
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        diagnostic_shape("PROFILE_VIOLATION", "copy_guard"),
      ]),
    );
  });

  it("rejects unknown validation request fields and unsafe direct profile regex execution", () => {
    const original = [input("- tenant: alpha\n  key: one\n", "/repo/a.yaml")];
    expect(() =>
      validate_profile_candidates({
        profile: profile(),
        original_inputs: original,
        candidate_inputs: original,
        operation_provenance: [],
        scope: { kind: "all_inputs" },
        unknown: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));

    const regex_profile = profile({
      protected: [
        {
          rule_id: "regex_guard",
          node_set: "record",
          when: { predicate: "raw_regex", pattern: ".*", flags: "u" },
          actions: ["delete"],
        },
      ],
    });
    expect(() =>
      validate({ original, used_profile: regex_profile }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
  });
});
