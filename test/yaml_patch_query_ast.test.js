import { describe, expect, it } from "vitest";

import addressable_module from "../lib/yaml_patch/addressable";
import node_index_module from "../lib/yaml_patch/node_index";
import parser_module from "../lib/yaml_patch/parser";
import query_module from "../lib/yaml_patch/query";
import query_v2_module from "../lib/yaml_patch/query_v2";
import source_module from "../lib/yaml_patch/source";

const { build_addressable_index } = addressable_module;
const { build_node_index } = node_index_module;
const { parse_yaml_source } = parser_module;
const { run_query_v2, validate_query_v2 } = query_v2_module;
const { create_source_record } = source_module;

function create_input(text, file_path = "/tmp/query.yaml") {
  const source = create_source_record(Buffer.from(text, "utf8"), {
    file_path,
  });
  const index = build_node_index(source, parse_yaml_source(source));
  return { index, addressable_index: build_addressable_index(index) };
}

function query(
  where,
  fields = ["raw", "scalar_type", "scalar_value", "scalar_value_encoding"],
) {
  return {
    version: 2,
    where,
    projection: { fields, missing: "omit" },
    limits: { max_result: 1000, max_output_bytes: 1024 * 1024 },
  };
}

describe("YAML query v2 AST", () => {
  it("validates a strict v2 query and supplies semantic defaults", () => {
    expect(
      validate_query_v2({
        version: 2,
        projection: { fields: ["source_path", "path"], missing: "error" },
      }),
    ).toMatchObject({
      version: 2,
      where: { all: [] },
      select: { kind: "self", missing: "error" },
      resolve_alias: "preserve",
    });
  });

  it.each([
    ["where", null],
    ["where", false],
    ["where", ""],
    ["select", null],
    ["select", false],
    ["select", ""],
    ["resolve_alias", null],
    ["resolve_alias", false],
    ["resolve_alias", ""],
  ])("does not default a present invalid %s value", (field, value) => {
    expect(() =>
      validate_query_v2({
        version: 2,
        projection: { fields: ["path"], missing: "error" },
        [field]: value,
      }),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_ERROR" }));
  });

  it("exposes v2 APIs from the query facade without changing v1 lookup", () => {
    for (const export_name of [
      "validate_query_v2",
      "evaluate_predicate",
      "select_query_results",
      "project_query_results",
      "normalize_expect_matches",
      "assert_match_expectation",
      "run_query_v2",
      "create_query_cursor",
      "decode_query_cursor",
    ]) {
      expect(query_module[export_name]).toBeTypeOf("function");
    }
    const input = create_input("value: old\n");
    expect(
      query_module.find_nodes(input.index, { raw_equals: "old" }),
    ).toHaveLength(1);
  });

  it("matches exact typed scalars without conflating quoted values", () => {
    const input = create_input(
      `values: [0, 1, 1.0, "1", true, "true", null]\n`,
    );
    const cases = [
      [{ type: "integer", value: 0 }, "0"],
      [{ type: "integer", value: 1 }, "1"],
      [{ type: "float", value: 1 }, "1.0"],
      [{ type: "string", value: "1" }, '"1"'],
      [{ type: "boolean", value: true }, "true"],
      [{ type: "string", value: "true" }, '"true"'],
      [{ type: "null", value: null }, "null"],
    ];

    for (const [value, raw] of cases) {
      const result = run_query_v2(
        [input],
        query({ predicate: "typed_equals", value }),
      );
      expect(result.matches).toEqual([expect.objectContaining({ raw })]);
    }
  });

  it("keeps unsafe integers and non-finite floats exact", () => {
    const input = create_input(
      `unsafe: 9007199254740993\nnan: .nan\npos: .inf\nneg: -.inf\n`,
    );

    expect(
      run_query_v2(
        [input],
        query({
          predicate: "typed_equals",
          value: {
            type: "integer",
            value: "9007199254740993",
            value_encoding: "decimal_string",
          },
        }),
      ).matches,
    ).toEqual([
      expect.objectContaining({
        scalar_value: "9007199254740993",
        scalar_value_encoding: "decimal_string",
      }),
    ]);
    expect(
      run_query_v2(
        [input],
        query({
          predicate: "typed_in",
          values: [
            {
              type: "float",
              value: "nan",
              value_encoding: "non_finite",
            },
            {
              type: "float",
              value: "positive_infinity",
              value_encoding: "non_finite",
            },
          ],
        }),
      ).matches,
    ).toHaveLength(2);
  });

  it("evaluates all, any, and not including explicit empty identities", () => {
    const input = create_input("one: 1\ntwo: 2\n");
    expect(run_query_v2([input], query({ all: [] })).total_match_count).toBe(
      input.addressable_index.entries.length,
    );
    expect(run_query_v2([input], query({ any: [] })).total_match_count).toBe(0);
    expect(
      run_query_v2(
        [input],
        query({
          all: [
            { predicate: "scalar_type", equals: "integer" },
            {
              not: {
                predicate: "typed_equals",
                value: { type: "integer", value: 1 },
              },
            },
          ],
        }),
      ).matches,
    ).toEqual([expect.objectContaining({ raw: "2" })]);
  });

  it("returns a mapping carrier for field predicates and preserves complex keys", () => {
    const input = create_input(
      `name: root\nchild: 3\n? [complex, key]\n: result\n`,
    );
    const complex_pair = input.addressable_index.entries.find(
      (entry) =>
        entry.addressable_type === "mapping_pair" &&
        entry.raw.startsWith("? [complex"),
    );
    const root = { predicate: "depth", comparison: { eq: 2 } };

    const simple = run_query_v2(
      [input],
      query(
        {
          all: [
            root,
            {
              predicate: "field_value",
              field: { key: { type: "string", value: "child" } },
              comparison: { equals: { type: "integer", value: 3 } },
            },
          ],
        },
        ["addressable_type", "path"],
      ),
    );
    expect(simple.matches).toEqual([{ addressable_type: "mapping", path: [] }]);

    const complex = run_query_v2(
      [input],
      query(
        {
          all: [
            root,
            {
              predicate: "field_value",
              field: {
                pair_index: complex_pair.mapping_pair_index,
                key_raw_digest: complex_pair.key_raw_digest,
              },
              comparison: { equals: { type: "string", value: "result" } },
            },
          ],
        },
        ["addressable_type"],
      ),
    );
    expect(complex.matches).toEqual([{ addressable_type: "mapping" }]);
  });

  it("matches paths, source positions, relations, and structural counts", () => {
    const input = create_input("root:\n  items: [one, two]\n");
    const scalar = input.addressable_index.entries.find(
      (entry) => entry.addressable_type === "scalar" && entry.raw === "two",
    );
    const result = run_query_v2(
      [input],
      query({
        all: [
          { predicate: "document", equals: 0 },
          { predicate: "path", equals: scalar.path },
          { predicate: "source_path", equals: "/tmp/query.yaml" },
          {
            predicate: "source_position",
            equals: {
              line: scalar.source.line,
              column: scalar.source.column,
            },
          },
          { predicate: "scalar_type", equals: "string" },
          {
            predicate: "relation",
            relation: "ancestor",
            min_distance: 1,
            where: {
              all: [
                { predicate: "node_type", equals: "sequence" },
                { predicate: "direct_child_count", comparison: { eq: 2 } },
                { predicate: "descendant_count", comparison: { gte: 4 } },
              ],
            },
          },
        ],
      }),
    );
    expect(result.matches).toEqual([expect.objectContaining({ raw: "two" })]);
  });

  it("supports exact raw, digest, string policy, and number ranges", () => {
    const input = create_input("word: 'Café'\nfold: 'Straße'\nnumber: 2.5\n");
    const word = input.addressable_index.entries.find(
      (entry) => entry.addressable_type === "scalar" && entry.raw === "'Café'",
    );
    const predicates = [
      { predicate: "raw_equals", equals: "'Café'" },
      { predicate: "raw_digest", equals: word.raw_digest },
      {
        predicate: "string_equals",
        value: "CAFÉ",
        case_fold: "unicode",
        normalization: "NFC",
      },
    ];
    for (const predicate of predicates) {
      const where = {
        all: [{ predicate: "addressable_type", equals: "scalar" }, predicate],
      };
      expect(run_query_v2([input], query(where)).matches).toEqual([
        expect.objectContaining({ raw: "'Café'" }),
      ]);
    }
    expect(
      run_query_v2(
        [input],
        query({
          predicate: "string_equals",
          value: "STRASSE",
          case_fold: "unicode",
          normalization: "none",
        }),
      ).matches,
    ).toEqual([expect.objectContaining({ raw: "'Straße'" })]);
    expect(
      run_query_v2(
        [input],
        query({
          predicate: "number_range",
          min: 2,
          max: 3,
          include_min: false,
          include_max: false,
        }),
      ).matches,
    ).toEqual([expect.objectContaining({ raw: "2.5" })]);
  });

  it("rejects raw regex execution outside an isolated worker", () => {
    const input = create_input("word: value\n");

    expect(() =>
      run_query_v2(
        [input],
        query({ predicate: "raw_regex", pattern: "^value$", flags: "" }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CHANGE_LIMIT_EXCEEDED",
        details: {
          limit_name: "raw_regex_execution",
          required_execution: "isolated_worker",
        },
      }),
    );
  });

  it.each([
    ["parent", { kind: "parent" }, "sequence_item"],
    ["ancestor", { kind: "ancestor", levels: 2 }, "sequence"],
    ["siblings", { kind: "siblings" }, "sequence_item"],
    ["mapping_key", { kind: "mapping_key" }, "scalar"],
    ["mapping_value", { kind: "mapping_value" }, "scalar"],
  ])("applies the %s selector", (_name, select, expected_type) => {
    const input = create_input("pair: value\nitems: [one, two]\n");
    const where = select.kind.startsWith("mapping")
      ? { predicate: "raw_equals", equals: "pair: value\n" }
      : {
          all: [
            { predicate: "raw_equals", equals: "one" },
            {
              predicate: "addressable_type",
              equals: select.kind === "siblings" ? "sequence_item" : "scalar",
            },
          ],
        };
    const result = run_query_v2([input], {
      ...query(where, ["addressable_type"]),
      select,
    });
    expect(result.matches).toContainEqual({ addressable_type: expected_type });
  });

  it("selects fields and children with stable deduplication", () => {
    const input = create_input("name: root\nchild: value\n");
    const field_result = run_query_v2([input], {
      ...query({ predicate: "node_type", equals: "mapping" }, [
        "raw",
        "scalar_value",
      ]),
      select: {
        kind: "field",
        field: { key: { type: "string", value: "child" } },
      },
    });
    expect(field_result.matches).toEqual([
      { raw: "value", scalar_value: "value" },
    ]);

    const children = run_query_v2([input], {
      ...query({ predicate: "node_type", equals: "mapping" }, [
        "addressable_type",
      ]),
      select: { kind: "children" },
    });
    expect(children.matches).toEqual([
      { addressable_type: "mapping_pair" },
      { addressable_type: "mapping_pair" },
    ]);
  });

  it("keeps aliases opaque by default and projects both locations on resolution", () => {
    const input = create_input("values: [&shared target, *shared]\n");
    const preserve = run_query_v2(
      [input],
      query({ predicate: "addressable_type", equals: "alias" }, [
        "addressable_type",
        "raw",
      ]),
    );
    expect(preserve.matches).toEqual([
      { addressable_type: "alias", raw: "*shared" },
    ]);

    const target = run_query_v2([input], {
      ...query({ predicate: "addressable_type", equals: "alias" }, [
        "addressable_type",
        "raw",
        "alias_location",
        "target_location",
      ]),
      resolve_alias: "target",
    });
    expect(target.matches).toEqual([
      expect.objectContaining({
        addressable_type: "scalar",
        raw: "target",
        alias_location: expect.objectContaining({
          locator: expect.any(String),
        }),
        target_location: expect.objectContaining({
          locator: expect.any(String),
        }),
      }),
    ]);
  });

  it("keeps each alias location when distinct aliases resolve to one target", () => {
    const input = create_input("values: [&shared target, *shared, *shared]\n");
    const result = run_query_v2([input], {
      ...query({ predicate: "addressable_type", equals: "alias" }, [
        "raw",
        "alias_location",
        "target_location",
      ]),
      resolve_alias: "target",
    });

    expect(result.matches).toHaveLength(2);
    expect(
      new Set(result.matches.map((match) => match.alias_location.locator)),
    ).toHaveLength(2);
    expect(
      new Set(result.matches.map((match) => match.target_location.locator)),
    ).toHaveLength(1);
  });

  it("requires explicit projection and never emits raw implicitly", () => {
    const input = create_input("secret: value\n");
    const result = run_query_v2([input], {
      version: 2,
      where: {
        all: [
          { predicate: "addressable_type", equals: "scalar" },
          { predicate: "raw_equals", equals: "value" },
        ],
      },
      projection: { fields: ["path"], missing: "error" },
    });
    expect(result.matches).toEqual([{ path: expect.any(Array) }]);
    expect(result.matches[0]).not.toHaveProperty("raw");
    expect(() =>
      run_query_v2([input], {
        version: 2,
        projection: { fields: ["scalar_type"], missing: "error" },
      }),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_ERROR" }));
  });

  it("projects an explicit JSON-safe byte range", () => {
    const input = create_input("name: café\n");
    const result = run_query_v2(
      [input],
      query(
        {
          all: [
            { predicate: "addressable_type", equals: "scalar" },
            { predicate: "raw_equals", equals: "café" },
          ],
        },
        ["byte_range", "start_byte", "end_byte"],
      ),
    );

    expect(result.matches).toEqual([
      {
        byte_range: {
          start_byte: expect.any(Number),
          end_byte: expect.any(Number),
        },
        start_byte: expect.any(Number),
        end_byte: expect.any(Number),
      },
    ]);
    expect(result.matches[0].byte_range).toEqual({
      start_byte: result.matches[0].start_byte,
      end_byte: result.matches[0].end_byte,
    });
  });

  it("rejects unknown schemas, malicious data, AST excess, and regex excess", () => {
    const input = create_input("value: text\n");
    const base = {
      version: 2,
      projection: { fields: ["path"], missing: "error" },
    };
    expect(() => validate_query_v2({ ...base, unknown: true })).toThrowError(
      expect.objectContaining({ code: "REQUEST_ERROR" }),
    );
    expect(() =>
      validate_query_v2({
        ...base,
        where: { all: [], any: [] },
      }),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_ERROR" }));
    expect(() =>
      validate_query_v2({
        ...base,
        where: { predicate: "path", equals: [{ unknown: 1 }] },
      }),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_ERROR" }));
    expect(() => validate_query_v2(new Proxy(base, {}))).toThrowError(
      expect.objectContaining({ code: "REQUEST_ERROR" }),
    );
    const accessor = { ...base };
    Object.defineProperty(accessor, "where", {
      enumerable: true,
      get() {
        throw new Error("must not run");
      },
    });
    expect(() => validate_query_v2(accessor)).toThrowError(
      expect.objectContaining({ code: "REQUEST_ERROR" }),
    );

    let nested = { predicate: "raw_equals", equals: "text" };
    for (let index = 0; index < 70; index += 1) nested = { not: nested };
    expect(() =>
      run_query_v2([input], { ...base, where: nested }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
    expect(() =>
      run_query_v2([input], {
        ...base,
        where: { predicate: "raw_regex", pattern: "12345", flags: "" },
        limits: { max_regex_pattern_length: 4 },
      }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
  });

  it.each([
    "^(a+)+$",
    "^a+a+$",
    "^(?:value)$",
    "value|other",
    "value{1,2}",
    "(value)\\1",
  ])("rejects unsafe native regex syntax: %s", (pattern) => {
    expect(() =>
      validate_query_v2({
        version: 2,
        where: { predicate: "raw_regex", pattern, flags: "" },
        projection: { fields: ["path"], missing: "error" },
      }),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_ERROR" }));
  });

  it("counts typed values, comparison values, and path steps against AST budgets", () => {
    const values = Array.from({ length: 1001 }, () => ({
      type: "string",
      value: "same",
    }));
    const base = {
      version: 2,
      projection: { fields: ["path"], missing: "error" },
    };

    expect(() =>
      validate_query_v2({
        ...base,
        where: { predicate: "typed_in", values },
      }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
    expect(() =>
      validate_query_v2({
        ...base,
        where: {
          predicate: "field_value",
          field: { key: { type: "string", value: "name" } },
          comparison: { in: values },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
    expect(() =>
      validate_query_v2({
        ...base,
        where: {
          predicate: "path",
          equals: Array.from({ length: 1001 }, (_, sequence_index) => ({
            sequence_index,
          })),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
  });
});
