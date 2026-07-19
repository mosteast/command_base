import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { main as generate_fixtures, ROOT } from "../benchmark/yaml_patch/generate_fixture";
import source_module from "../lib/yaml_patch/source";
import parser_module from "../lib/yaml_patch/parser";
import node_index_module from "../lib/yaml_patch/node_index";
import query_v2_module from "../lib/yaml_patch/query_v2";
import profile_validate_module from "../lib/yaml_patch/profile_validate";

const { create_source_record } = source_module;
const { parse_yaml_source } = parser_module;
const { build_node_index } = node_index_module;
const { run_query_v2 } = query_v2_module;
const { validate_profile_candidates } = profile_validate_module;

function ensure_fixtures() {
  if (!fs.existsSync(path.join(ROOT, "baseline/01_plain.yaml"))) {
    return generate_fixtures();
  }
  return Promise.resolve();
}

function load_index(relative_path) {
  const file_path = path.join(ROOT, relative_path);
  const buffer = fs.readFileSync(file_path);
  const source = create_source_record(buffer, { file_path });
  return build_node_index(source, parse_yaml_source(source));
}

describe("YAML patch resource limits", () => {
  it("fails closed on bounded query result and output limits", async () => {
    await ensure_fixtures();
    const index = load_index("baseline/01_plain.yaml");
    expect(() =>
      run_query_v2(
        [{ index }],
        {
          version: 2,
          where: { predicate: "node_type", equals: "scalar" },
          select: { kind: "self" },
          projection: { fields: ["path", "raw"], missing: "error" },
          expect_matches: { min: 0, max: 1 },
        },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: expect.stringMatching(/EXPECTATION_FAILED|CHANGE_LIMIT_EXCEEDED/),
      }),
    );
    expect(() =>
      run_query_v2(
        [{ index }],
        {
          version: 2,
          where: { predicate: "node_type", equals: "scalar" },
          select: { kind: "self" },
          projection: { fields: ["path", "raw"], missing: "error" },
          limits: { max_output_bytes: 8 },
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
  });

  it("fails closed on regex pattern and node index depth/node limits", async () => {
    await ensure_fixtures();
    const file_path = path.join(ROOT, "baseline/01_plain.yaml");
    const buffer = fs.readFileSync(file_path);
    const source = create_source_record(buffer, { file_path });
    const parsed = parse_yaml_source(source);
    expect(() =>
      run_query_v2(
        [{ index: build_node_index(source, parsed) }],
        {
          version: 2,
          where: { predicate: "raw_regex", pattern: "abcdef", flags: "" },
          select: { kind: "self" },
          projection: { fields: ["path", "raw"], missing: "error" },
          limits: { max_regex_pattern_length: 3 },
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
    expect(() =>
      build_node_index(source, parsed, { max_node_count: 1 }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
    expect(() => build_node_index(source, parsed, { max_depth: 0 })).toThrowError(
      expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }),
    );
  });

  it("fails closed on independent graph traversal limits", () => {
    const source = create_source_record(
      Buffer.from("- code: alpha\n  next: beta\n- code: beta\n"),
      { requested_path: "/repo/graph.yaml" },
    );
    const index = build_node_index(source, parse_yaml_source(source));
    const profile = {
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
            allowed: ["code", "next"],
            required: ["code"],
            optional: ["next"],
            rules: {
              code: { types: ["string"] },
              next: { types: ["string", "null"] },
            },
          },
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
      ],
      graphs: [
        {
          rule_id: "next_graph",
          reference_rules: ["next_reference"],
          acyclic: true,
        },
      ],
    };
    expect(() =>
      validate_profile_candidates({
        profile,
        original_inputs: [{ index }],
        candidate_inputs: [{ index }],
        operation_provenance: [],
        scope: { kind: "all_inputs" },
        limits: { max_graph_time_ms: 0 },
      }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
  });

  it("rejects oversized source reads with a fatal limit error", async () => {
    await ensure_fixtures();
    const file_path = path.join(ROOT, "scale/large_2mib.yaml");
    await expect(
      source_module.read_bounded_file(file_path, {
        max_file_bytes: 1024,
        allow_symbolic_link: false,
        limit_error_code: "CHANGE_LIMIT_EXCEEDED",
      }),
    ).rejects.toMatchObject({ code: "CHANGE_LIMIT_EXCEEDED" });
  });

  it("completes or limit-errors on the 10x growth corpus without crashing", async () => {
    await ensure_fixtures();
    const growth_path = path.join(ROOT, "scale/growth_10x.yaml");
    expect(fs.existsSync(growth_path)).toBe(true);
    const stats = fs.statSync(growth_path);
    expect(stats.size).toBeGreaterThan(10 * 1024 * 1024);
    await expect(
      source_module.read_bounded_file(growth_path, {
        max_file_bytes: 1024 * 1024,
        allow_symbolic_link: false,
        limit_error_code: "CHANGE_LIMIT_EXCEEDED",
      }),
    ).rejects.toMatchObject({ code: "CHANGE_LIMIT_EXCEEDED" });
  });
});
