import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import artifact_version_module from "../lib/yaml_patch/artifact_version";
import source_module from "../lib/yaml_patch/source";
import parser_module from "../lib/yaml_patch/parser";
import node_index_module from "../lib/yaml_patch/node_index";
import addressable_module from "../lib/yaml_patch/addressable";

const require = createRequire(import.meta.url);
const { canonical_json } = artifact_version_module;
const { create_source_record } = source_module;
const { parse_yaml_source } = parser_module;
const { build_node_index, get_index_node } = node_index_module;
const {
  DEFAULT_MAX_ADDRESSABLE_COUNT,
  DEFAULT_MAX_ALIAS_RESOLUTION_COUNT,
  DEFAULT_MAX_LOCATOR_BYTES,
  DEFAULT_MAX_TOTAL_PATH_STEPS,
  build_addressable_index,
  encode_locator_v2,
  resolve_alias_target,
} = addressable_module;

function create_index(text, options = {}) {
  const source = create_source_record(Buffer.from(text, "utf8"));
  return build_node_index(source, parse_yaml_source(source), options);
}

function entries_of_type(addressable_index, addressable_type) {
  return addressable_index.entries.filter(
    (entry) => entry.addressable_type === addressable_type,
  );
}

function mapping_value(index, addressable_index, mapping_key) {
  const v1_entry = index.entries.find(
    (entry) =>
      entry.relationship === "mapping_value" &&
      entry.mapping_key === mapping_key,
  );
  return addressable_index.node_entry_by_id.get(v1_entry.id);
}

describe("YAML addressable resource and integrity boundaries", () => {
  it("publishes finite aggregate budget defaults", () => {
    for (const value of [
      DEFAULT_MAX_ADDRESSABLE_COUNT,
      DEFAULT_MAX_ALIAS_RESOLUTION_COUNT,
      DEFAULT_MAX_LOCATOR_BYTES,
      DEFAULT_MAX_TOTAL_PATH_STEPS,
    ]) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it.each([
    ["max_addressable_count", 2],
    ["max_total_path_steps", 0],
    ["max_locator_bytes", 1],
  ])("fails stably when %s is exhausted", (option_name, option_value) => {
    const index = create_index("first: one\nsecond: two\n");

    expect(() =>
      build_addressable_index(index, { [option_name]: option_value }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
  });

  it("indexes 25,000 flat pairs under explicit aggregate budgets", () => {
    const pair_count = 25_000;
    const text = Array.from(
      { length: pair_count },
      (_, index) => `key_${index}: ${index}\n`,
    ).join("");
    const index = create_index(text);

    const addressable_index = build_addressable_index(index, {
      max_addressable_count: 130_000,
      max_total_path_steps: 130_000,
      max_locator_bytes: 512 * 1024 * 1024,
    });

    expect(addressable_index.entries).toHaveLength(pair_count * 5 + 3);
    expect(entries_of_type(addressable_index, "mapping_pair")).toHaveLength(
      pair_count,
    );
  }, 30_000);

  it("bounds a 1,200-level flow mapping before quadratic locator work", () => {
    const depth = 1_200;
    const text = `${"{key:".repeat(depth)}value${"}".repeat(depth)}\n`;
    let index;
    try {
      index = create_index(text, { max_depth: 2_000 });
    } catch (error) {
      expect(error).toMatchObject({ code: "CHANGE_LIMIT_EXCEEDED" });
      return;
    }

    expect(() => build_addressable_index(index)).toThrowError(
      expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }),
    );
  }, 10_000);

  it("caches recursively verified CST token ranges", () => {
    const range_module = require("../lib/yaml_patch/addressable_range");
    const text = `key: [${Array.from(
      { length: 2_000 },
      (_, index) => `value_${index}`,
    ).join(", ")}]\n`;
    const index = create_index(text);
    const root_entry = index._internal.entry_by_id.get(
      index.document_root_ids[0],
    );
    const mapping_node = get_index_node(index, root_entry);
    const pair = mapping_node.items[0];
    const range_context = range_module.create_addressable_range_context(index);

    range_context.mapping_pair_character_range(mapping_node, pair, 0);
    const first_scan_count = range_context.stats.token_scan_count;
    range_context.mapping_pair_character_range(mapping_node, pair, 0);

    expect(first_scan_count).toBeGreaterThan(0);
    expect(range_context.stats.token_scan_count).toBe(first_scan_count);
    expect(range_context.stats.token_cache_hit_count).toBeGreaterThan(0);
  });

  it("rejects node-index identity and document-root tampering", () => {
    const entry_index = create_index("value: old\n");
    entry_index.entries[0] = { ...entry_index.entries[0] };
    expect(() => build_addressable_index(entry_index)).toThrowError(
      expect.objectContaining({ code: "PRECONDITION_FAILED" }),
    );

    const root_index = create_index("value: old\n");
    root_index.document_root_ids[0] = root_index.entries.at(-1).id;
    expect(() => build_addressable_index(root_index)).toThrowError(
      expect.objectContaining({ code: "PRECONDITION_FAILED" }),
    );
  });

  it("resolves aliases from one deterministic table without node.resolve", () => {
    const alias_count = 100;
    const text = `values: [&shared target, ${Array.from(
      { length: alias_count },
      () => "*shared",
    ).join(", ")}]\n`;
    const index = create_index(text);
    let resolve_call_count = 0;
    for (const entry of index.entries.filter(
      (candidate) => candidate.node_type === "alias",
    )) {
      const alias_node = get_index_node(index, entry);
      alias_node.resolve = () => {
        resolve_call_count += 1;
        throw new Error("Alias.resolve must not be called");
      };
    }

    const addressable_index = build_addressable_index(index, {
      resolve_alias_target: true,
      max_alias_resolution_count: alias_count,
    });

    expect(resolve_call_count).toBe(0);
    expect(entries_of_type(addressable_index, "alias")).toHaveLength(
      alias_count,
    );
    expect(
      entries_of_type(addressable_index, "alias").every(
        (entry) => entry.alias_target.target_location.locator,
      ),
    ).toBe(true);
  });

  it("enforces one aggregate alias-resolution budget", () => {
    const index = create_index(
      "values: [&shared target, *shared, *shared, *shared]\n",
    );

    expect(() =>
      build_addressable_index(index, {
        resolve_alias_target: true,
        max_alias_resolution_count: 2,
      }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
  });

  it("rejects foreign and tampered object-form alias entries", () => {
    const first_index = create_index("values: [&shared target, *shared]\n");
    const second_index = create_index("values: [&shared target, *shared]\n");
    const first_addressable = build_addressable_index(first_index);
    const second_addressable = build_addressable_index(second_index);
    const first_alias = entries_of_type(first_addressable, "alias")[0];

    expect(() =>
      resolve_alias_target(second_index, first_alias, {
        addressable_index: second_addressable,
      }),
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));

    first_addressable.by_id.set(first_alias.id, { ...first_alias });
    expect(() =>
      resolve_alias_target(first_index, first_alias, {
        addressable_index: first_addressable,
      }),
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));

    const range_index = create_index("values: [&shared target, *shared]\n");
    const range_addressable = build_addressable_index(range_index);
    const range_alias = entries_of_type(range_addressable, "alias")[0];
    range_alias.source.start_byte -= 1;
    range_alias.path = [];
    range_alias.locator = encode_locator_v2(
      range_alias,
      range_index.source.digest,
    );
    expect(() =>
      resolve_alias_target(range_index, range_alias, {
        addressable_index: range_addressable,
      }),
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  });
});

describe("YAML addressable JSON-safe scalar metadata", () => {
  it("preserves exact unsafe integers and encodes non-finite floats", () => {
    const index = create_index(`safe_integer: 42
safe_float: 1.5
unsafe_decimal: 9007199254740993
unsafe_negative: -9007199254740993
unsafe_hex: 0x20000000000001
positive_infinity: .inf
negative_infinity: -.Inf
not_a_number: .NaN
`);
    const addressable_index = build_addressable_index(index);

    expect(
      mapping_value(index, addressable_index, "safe_integer"),
    ).toMatchObject({ scalar_type: "integer", scalar_value: 42 });
    expect(mapping_value(index, addressable_index, "safe_float")).toMatchObject(
      { scalar_type: "float", scalar_value: 1.5 },
    );
    expect(
      mapping_value(index, addressable_index, "unsafe_decimal"),
    ).toMatchObject({
      raw: "9007199254740993",
      scalar_type: "integer",
      scalar_value: "9007199254740993",
      scalar_value_encoding: "decimal_string",
    });
    expect(
      mapping_value(index, addressable_index, "unsafe_negative"),
    ).toMatchObject({
      scalar_value: "-9007199254740993",
      scalar_value_encoding: "decimal_string",
    });
    expect(mapping_value(index, addressable_index, "unsafe_hex")).toMatchObject(
      {
        raw: "0x20000000000001",
        scalar_value: "9007199254740993",
        scalar_value_encoding: "decimal_string",
      },
    );
    expect(
      mapping_value(index, addressable_index, "positive_infinity"),
    ).toMatchObject({
      scalar_type: "float",
      scalar_value: "positive_infinity",
      scalar_value_encoding: "non_finite",
    });
    expect(
      mapping_value(index, addressable_index, "negative_infinity"),
    ).toMatchObject({
      scalar_value: "negative_infinity",
      scalar_value_encoding: "non_finite",
    });
    expect(
      mapping_value(index, addressable_index, "not_a_number"),
    ).toMatchObject({
      scalar_value: "nan",
      scalar_value_encoding: "non_finite",
    });

    const scalar_contract = Object.fromEntries(
      index.entries
        .filter((entry) => entry.relationship === "mapping_value")
        .map((entry) => {
          const addressable_entry = addressable_index.node_entry_by_id.get(
            entry.id,
          );
          return [
            entry.mapping_key,
            {
              scalar_type: addressable_entry.scalar_type,
              scalar_value: addressable_entry.scalar_value,
              ...(addressable_entry.scalar_value_encoding
                ? {
                    scalar_value_encoding:
                      addressable_entry.scalar_value_encoding,
                  }
                : {}),
            },
          ];
        }),
    );
    expect(() => canonical_json(scalar_contract)).not.toThrow();
    expect(() => JSON.stringify(scalar_contract)).not.toThrow();
  });

  it("rejects locator encoding against a different source digest", () => {
    const index = create_index("value: old\n");
    const addressable_index = build_addressable_index(index);
    const entry = addressable_index.entries[0];

    expect(() => encode_locator_v2(entry, "0".repeat(64))).toThrowError(
      expect.objectContaining({ code: "SOURCE_CHANGED" }),
    );
  });
});
