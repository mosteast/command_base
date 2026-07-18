import { describe, expect, it } from "vitest";

import source_module from "../lib/yaml_patch/source";
import parser_module from "../lib/yaml_patch/parser";
import node_index_module from "../lib/yaml_patch/node_index";
import addressable_module from "../lib/yaml_patch/addressable";
import profile_module from "../lib/yaml_patch/profile";
import profile_validate_module from "../lib/yaml_patch/profile_validate";

const { create_source_record } = source_module;
const { parse_yaml_source } = parser_module;
const { build_node_index } = node_index_module;
const { build_addressable_index } = addressable_module;
const { validate_profile } = profile_module;
const { validate_profile_candidates } = profile_validate_module;

function input(text, requested_path) {
  const source = create_source_record(Buffer.from(text), { requested_path });
  return { index: build_node_index(source, parse_yaml_source(source)) };
}

function reference_profile(overrides = {}) {
  return {
    version: 1,
    node_sets: {
      node: {
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
        },
        fields: {
          allowed: ["code", "next", "links", "metadata"],
          required: ["code"],
          optional: ["next", "links", "metadata"],
          rules: {
            code: { types: ["string"] },
            next: { types: ["string", "null"] },
            links: { types: ["sequence"] },
            metadata: { types: ["mapping"] },
          },
        },
        diagnostic_projection: ["code"],
      },
    },
    identity: [
      {
        rule_id: "node_identity",
        node_set: "node",
        fields: ["code"],
        unique_scope: "input",
        missing_policy: "error",
        null_policy: "error",
        types: ["string"],
        immutable_existing: true,
      },
    ],
    references: [
      {
        rule_id: "next_reference",
        source_node_set: "node",
        source_identity: "node_identity",
        source_field: "next",
        cardinality: { kind: "scalar", min: 0, max: 1 },
        target_node_set: "node",
        target_identity: "node_identity",
        null_policy: "allow",
        resolution_scope: "input",
        unique_values: true,
      },
      {
        rule_id: "links_reference",
        source_node_set: "node",
        source_identity: "node_identity",
        source_field: "links",
        cardinality: { kind: "sequence", min: 0, max: 20 },
        target_node_set: "node",
        target_identity: "node_identity",
        null_policy: "error",
        resolution_scope: "input",
        unique_values: true,
      },
    ],
    graphs: [
      {
        rule_id: "next_graph",
        reference_rules: ["next_reference"],
        acyclic: true,
      },
    ],
    ...overrides,
  };
}

function validate({
  original,
  candidate = original,
  profile = reference_profile(),
  scope = { kind: "all_inputs" },
  limits = {},
  options = {},
}) {
  return validate_profile_candidates({
    profile,
    original_inputs: original,
    candidate_inputs: candidate,
    operation_provenance: [],
    scope,
    limits,
    options,
  });
}

function diagnostic(code, rule_id) {
  return expect.objectContaining({
    code,
    severity: "error",
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

describe("YAML profile references and graph validation", () => {
  it("strictly validates reference and graph declarations", () => {
    expect(validate_profile(reference_profile()).diagnostics).toEqual([]);

    const invalid_references = [
      {
        ...reference_profile().references[0],
        source_node_set: "missing",
      },
      {
        ...reference_profile().references[0],
        target_identity: "missing",
      },
      {
        ...reference_profile().references[0],
        source_identity: "missing",
      },
      {
        ...reference_profile().references[0],
        cardinality: { kind: "many", min: 0, max: 1 },
      },
      {
        ...reference_profile().references[0],
        resolution_scope: "guess",
      },
      { ...reference_profile().references[0], unknown: true },
    ];
    for (const reference of invalid_references) {
      expect(() =>
        validate_profile({
          ...reference_profile(),
          references: [reference],
          graphs: [],
        }),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }

    for (const graph of [
      {
        rule_id: "bad_graph",
        reference_rules: ["missing"],
        acyclic: true,
      },
      {
        rule_id: "bad_graph",
        reference_rules: ["next_reference"],
        acyclic: "yes",
      },
      {
        rule_id: "bad_graph",
        reference_rules: ["next_reference"],
        acyclic: true,
        unknown: true,
      },
    ]) {
      expect(() =>
        validate_profile({ ...reference_profile(), graphs: [graph] }),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }
  });

  it("resolves valid scalar and sequence references by typed identity", () => {
    const sources = [
      input(
        `- code: alpha
  next: beta
  links: [beta, gamma]
- code: beta
  next: gamma
- code: gamma
  next: null
`,
        "/repo/nodes.yaml",
      ),
    ];
    const result = validate({ original: sources });
    expect(result.diagnostics).toEqual([]);
    expect(result.reference_summary).toEqual({
      resolved: 4,
      missing: 0,
      non_unique: 0,
      duplicate: 0,
      invalid_type: 0,
    });
  });

  it("reports wrong shape/type, duplicate values, missing targets, and non-unique targets", () => {
    const sources = [
      input(
        `- code: alpha
  next: 7
  links: [beta, beta, missing]
- code: beta
- code: beta
`,
        "/repo/invalid.yaml",
      ),
    ];
    const result = validate({ original: sources });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        diagnostic("REFERENCE_VIOLATION", "next_reference"),
        diagnostic("REFERENCE_VIOLATION", "links_reference"),
      ]),
    );
    expect(result.reference_summary).toMatchObject({
      missing: 1,
      non_unique: expect.any(Number),
      duplicate: 1,
      invalid_type: 1,
    });
    expect(result.reference_summary.non_unique).toBeGreaterThan(0);
  });

  it("honors null policy and reference cardinality", () => {
    const strict_null = reference_profile({
      references: [
        {
          ...reference_profile().references[0],
          null_policy: "error",
          cardinality: { kind: "scalar", min: 1, max: 1 },
        },
      ],
      graphs: [],
    });
    const result = validate({
      original: [input("- code: alpha\n  next: null\n", "/repo/null.yaml")],
      profile: strict_null,
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        diagnostic("REFERENCE_VIOLATION", "next_reference"),
      ]),
    );
  });

  it("supports composite target identities using sequence-shaped reference values", () => {
    const base = reference_profile();
    const composite = reference_profile({
      identity: [
        {
          ...base.identity[0],
          fields: ["code", ["metadata", "region"]],
        },
      ],
      references: [
        {
          ...base.references[0],
          source_field: "links",
          cardinality: { kind: "sequence", min: 0, max: 10 },
        },
      ],
      graphs: [],
    });
    const result = validate({
      original: [
        input(
          `- code: alpha
  metadata: { region: north }
  links:
    - [beta, south]
- code: beta
  metadata: { region: south }
`,
          "/repo/composite.yaml",
        ),
      ],
      profile: composite,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.reference_summary.resolved).toBe(1);
  });

  it("applies null policy to composite reference components", () => {
    const base = reference_profile();
    const composite_reference = {
      ...base.references[0],
      source_field: "links",
      cardinality: { kind: "sequence", min: 0, max: 10 },
      null_policy: "allow",
    };
    const composite = reference_profile({
      identity: [
        {
          ...base.identity[0],
          fields: ["code", ["metadata", "region"]],
        },
      ],
      references: [composite_reference],
      graphs: [],
    });
    const sources = [
      input(
        `- code: alpha
  metadata: { region: north }
  links:
    - [beta, null]
- code: beta
  metadata: { region: south }
`,
        "/repo/composite-null.yaml",
      ),
    ];
    expect(
      validate({ original: sources, profile: composite }).diagnostics,
    ).toEqual([]);
    const strict = {
      ...composite,
      references: [{ ...composite_reference, null_policy: "error" }],
    };
    expect(
      validate({ original: sources, profile: strict }).diagnostics,
    ).toEqual(
      expect.arrayContaining([
        diagnostic("REFERENCE_VIOLATION", "next_reference"),
      ]),
    );
  });

  it("returns an ordered readable cycle path with edge source locations", () => {
    const result = validate({
      original: [
        input(
          `- code: alpha
  next: beta
- code: beta
  next: gamma
- code: gamma
  next: alpha
`,
          "/repo/cycle.yaml",
        ),
      ],
    });
    const cycle = result.diagnostics.find(
      (item) => item.code === "CYCLE_DETECTED",
    );
    expect(cycle).toEqual(diagnostic("CYCLE_DETECTED", "next_graph"));
    expect(cycle.projection.cycle_path).toHaveLength(4);
    expect(cycle.projection.edges).toHaveLength(3);
    expect(cycle.projection.edges[0]).toEqual(
      expect.objectContaining({
        rule_id: "next_reference",
        file: "/repo/cycle.yaml",
        line: expect.any(Number),
        column: expect.any(Number),
      }),
    );
  });

  it("rejects deletion of a referenced target unless the final candidate updates dependencies", () => {
    const original = [
      input(
        `- code: alpha
  next: beta
- code: beta
`,
        "/repo/delete.yaml",
      ),
    ];
    const broken = [
      input("- code: alpha\n  next: beta\n", "/repo/delete.yaml"),
    ];
    expect(validate({ original, candidate: broken }).diagnostics).toEqual(
      expect.arrayContaining([
        diagnostic("REFERENCE_VIOLATION", "next_reference"),
      ]),
    );

    const repaired = [
      input("- code: alpha\n  next: null\n", "/repo/delete.yaml"),
    ];
    expect(validate({ original, candidate: repaired }).diagnostics).toEqual(
      expect.not.arrayContaining([
        diagnostic("REFERENCE_VIOLATION", "next_reference"),
      ]),
    );
  });

  it("reports incomplete specified-file validation and safely falls back for complete validation", () => {
    const sources = [
      input("- code: alpha\n  next: null\n", "/repo/a.yaml"),
      input("- code: beta\n  next: missing\n", "/repo/b.yaml"),
    ];
    const partial = validate({
      original: sources,
      scope: { kind: "specified_files", files: ["/repo/a.yaml"] },
    });
    expect(partial.diagnostics).toEqual([]);
    expect(partial.scope_report).toMatchObject({
      requested: "specified_files",
      complete: false,
      fallback_to_full: false,
      validated_files: ["/repo/a.yaml"],
      unvalidated_files: ["/repo/b.yaml"],
    });

    const complete = validate({
      original: sources,
      scope: { kind: "specified_files", files: ["/repo/a.yaml"] },
      options: { require_complete: true },
    });
    expect(complete.scope_report).toMatchObject({
      complete: true,
      fallback_to_full: true,
    });
    expect(complete.diagnostics).toEqual(
      expect.arrayContaining([
        diagnostic("REFERENCE_VIOLATION", "next_reference"),
      ]),
    );
  });

  it("falls back to full validation when affected reference closure is uncertain", () => {
    const sources = [
      input("- code: alpha\n  next: null\n", "/repo/a.yaml"),
      input("- code: beta\n  next: missing\n", "/repo/b.yaml"),
    ];
    const result = validate({
      original: sources,
      scope: { kind: "reference_closure", files: ["/repo/a.yaml"] },
    });
    expect(result.scope_report).toMatchObject({
      requested: "reference_closure",
      complete: true,
      fallback_to_full: true,
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        diagnostic("REFERENCE_VIOLATION", "next_reference"),
      ]),
    );
  });

  it("marks changed-node validation incomplete unless complete validation is required", () => {
    const source = input(
      `- code: alpha
  next: null
- code: beta
  next: missing
`,
      "/repo/nodes.yaml",
    );
    const addressable = build_addressable_index(source.index);
    const first_mapping = addressable.entries.find(
      (entry) =>
        entry.addressable_type === "mapping" &&
        entry.path.some((step) => step.sequence_index === 0),
    );
    const partial = validate({
      original: [source],
      scope: { kind: "changed_nodes", node_locators: [first_mapping.locator] },
    });
    expect(partial.diagnostics).toEqual([]);
    expect(partial.scope_report).toMatchObject({
      requested: "changed_nodes",
      complete: false,
      fallback_to_full: false,
      unvalidated_node_scope: true,
    });

    const complete = validate({
      original: [source],
      scope: { kind: "changed_nodes", node_locators: [first_mapping.locator] },
      options: { require_complete: true },
    });
    expect(complete.scope_report).toMatchObject({
      complete: true,
      fallback_to_full: true,
    });
    expect(complete.diagnostics).toEqual(
      expect.arrayContaining([
        diagnostic("REFERENCE_VIOLATION", "next_reference"),
      ]),
    );
  });

  it("enforces independent graph resource limits", () => {
    const sources = [
      input(
        `- code: alpha
  next: beta
- code: beta
`,
        "/repo/limit.yaml",
      ),
    ];
    for (const limits of [
      { max_graph_node: 1 },
      { max_graph_edge: 0 },
      { max_graph_visit: 0 },
      { max_graph_time_ms: 0 },
    ]) {
      expect(() =>
        validate({ sources, original: sources, limits }),
      ).toThrowError(
        expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }),
      );
    }
  });
});
