import { describe, expect, it } from "vitest";

import source_module from "../lib/yaml_patch/source";
import parser_module from "../lib/yaml_patch/parser";
import node_index_module from "../lib/yaml_patch/node_index";
import query_module from "../lib/yaml_patch/query";
import range_set_module from "../lib/yaml_patch/range_set";
import mapping_edit_module from "../lib/yaml_patch/mapping_edit";
import addressable_module from "../lib/yaml_patch/addressable";
import profile_module from "../lib/yaml_patch/profile";
import layout_module from "../lib/yaml_patch/layout";

const { create_source_record } = source_module;
const { parse_yaml_source } = parser_module;
const { build_node_index, get_index_node } = node_index_module;
const { select_unique_node } = query_module;
const { apply_range_set } = range_set_module;
const { compile_operation } = mapping_edit_module;
const { build_addressable_index } = addressable_module;
const { load_profile } = profile_module;
const { collection_items, join_item_buffers } = layout_module;

function create_index(text) {
  const source = create_source_record(Buffer.from(text, "utf8"));
  return build_node_index(source, parse_yaml_source(source));
}

function mapping_for(index, mapping_key) {
  return select_unique_node(index, { path: [{ mapping_key }] });
}

function apply_operation(index, target, operation, context = {}) {
  const compiled = compile_operation({ index, ...context }, target, operation);
  return {
    compiled,
    text: apply_range_set(
      index.source.buffer,
      compiled.splices,
    ).candidate_buffer.toString("utf8"),
  };
}

const mapping_source = `settings:
  alpha: one # preserve alpha
  beta: two
  gamma:
    nested: yes
`;

describe("YAML mapping structural edits", () => {
  it("adds pairs at explicit positions while preserving every existing pair byte", () => {
    const index = create_index(mapping_source);
    const target = mapping_for(index, "settings");
    const result = apply_operation(index, target, {
      id: "add-before-beta",
      type: "add_mapping_pair",
      key: "inserted",
      value: "value",
      position: { kind: "before", pair: { index: 1 } },
    });

    expect(result.text).toBe(`settings:
  alpha: one # preserve alpha
  inserted: value
  beta: two
  gamma:
    nested: yes
`);
    expect(result.text).toContain("alpha: one # preserve alpha");
  });

  it("uses explicit position before profile order and otherwise appends stably", () => {
    const index = create_index("map:\n  alpha: one\n  beta: two\n");
    const target = mapping_for(index, "map");
    const profile = load_profile(
      Buffer.from(`version: 1
node_sets:
  root_mapping:
    query:
      version: 2
      where:
        all:
          - { predicate: node_type, equals: mapping }
          - predicate: field_exists
            field: { key: { type: string, value: map } }
      select: { kind: self, missing: error }
      projection: { fields: [path], missing: error }
    fields: { allowed: [map] }
    field_order: [map]
  ordered_mapping:
    query:
      version: 2
      where:
        all:
          - { predicate: node_type, equals: mapping }
          - predicate: field_exists
            field: { key: { type: string, value: alpha } }
      select: { kind: self, missing: error }
      projection: { fields: [path], missing: error }
    fields: { allowed: [gamma, alpha, beta] }
    field_order: [gamma, alpha, beta]
`),
    );
    const suggested = apply_operation(
      index,
      target,
      { id: "profile-order", type: "add_mapping_pair", key: "gamma", value: 3 },
      { profile },
    );
    expect(suggested.text).toBe(
      "map:\n  gamma: 3\n  alpha: one\n  beta: two\n",
    );

    const explicit = apply_operation(
      index,
      target,
      {
        id: "explicit-append",
        type: "add_mapping_pair",
        key: "gamma",
        value: 3,
        position: { kind: "append" },
      },
      { profile },
    );
    expect(explicit.text).toBe("map:\n  alpha: one\n  beta: two\n  gamma: 3\n");
  });

  it("rejects conflicting matching field orders and accepts identical orders", () => {
    const index = create_index("map:\n  alpha: one\n  beta: two\n");
    const target = mapping_for(index, "map");
    const profile_source = (second_order) => `version: 1
node_sets:
  first:
    query:
      version: 2
      where:
        all:
          - { predicate: node_type, equals: mapping }
          - predicate: field_exists
            field: { key: { type: string, value: alpha } }
      select: { kind: self, missing: error }
      projection: { fields: [path], missing: error }
    fields: { allowed: [gamma, beta, alpha] }
    field_order: [gamma, beta, alpha]
  second:
    query:
      version: 2
      where:
        all:
          - { predicate: node_type, equals: mapping }
          - predicate: field_exists
            field: { key: { type: string, value: alpha } }
      select: { kind: self, missing: error }
      projection: { fields: [path], missing: error }
    fields: { allowed: [gamma, beta, alpha] }
    field_order: ${second_order}
`;

    const conflicting_profile = load_profile(
      Buffer.from(profile_source("[beta, gamma, alpha]")),
    );
    expect(() =>
      apply_operation(
        index,
        target,
        {
          id: "conflicting-field-order",
          type: "add_mapping_pair",
          key: "gamma",
          value: 3,
        },
        { profile: conflicting_profile },
      ),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_ERROR" }));

    const identical_profile = load_profile(
      Buffer.from(profile_source("[gamma, beta, alpha]")),
    );
    const result = apply_operation(
      index,
      target,
      {
        id: "identical-field-order",
        type: "add_mapping_pair",
        key: "gamma",
        value: 3,
      },
      { profile: identical_profile },
    );
    expect(result.text).toBe("map:\n  gamma: 3\n  alpha: one\n  beta: two\n");
  });

  it("resolves field order for a late target without projecting all matches", () => {
    const record_count = 6_000;
    const source = `records:\n${Array.from(
      { length: record_count },
      (_, index) => `  - alpha: value-${index}\n    beta: kept-${index}\n`,
    ).join("")}`;
    const index = create_index(source);
    const target = select_unique_node(index, {
      path: [{ mapping_key: "records" }, { sequence_index: record_count - 1 }],
      node_type: "mapping",
    });
    const profile = load_profile(
      Buffer.from(`version: 1
node_sets:
  record:
    query:
      version: 2
      where:
        all:
          - { predicate: node_type, equals: mapping }
          - predicate: field_exists
            field: { key: { type: string, value: alpha } }
      select: { kind: self, missing: error }
      projection: { fields: [path], missing: error }
    fields: { allowed: [gamma, alpha, beta] }
    field_order: [gamma, alpha, beta]
`),
    );

    const result = apply_operation(
      index,
      target,
      {
        id: "late-profile-target",
        type: "add_mapping_pair",
        key: "gamma",
        value: true,
      },
      { profile },
    );
    expect(result.text).toContain(
      `  - gamma: true\n    alpha: value-${record_count - 1}\n    beta: kept-${record_count - 1}\n`,
    );
  }, 15_000);

  it("sets, deletes, moves, and reorders pairs as source slices", () => {
    const index = create_index(mapping_source);
    const target = mapping_for(index, "settings");
    const changed = apply_operation(index, target, {
      id: "set-beta",
      type: "set_mapping_value",
      pair: { index: 1 },
      value: "changed",
    });
    expect(changed.text).toContain("beta: changed");
    expect(changed.text).toContain("alpha: one # preserve alpha");

    const quoted_index = create_index("map:\n  string: 'old value' # note\n");
    const quoted = apply_operation(
      quoted_index,
      mapping_for(quoted_index, "map"),
      {
        id: "set-quoted",
        type: "set_mapping_value",
        pair: { index: 0 },
        value: "new value",
      },
    );
    expect(quoted.text).toBe("map:\n  string: 'new value' # note\n");

    const subtree_index = create_index(
      "map:\n  value: old\n  keep: untouched\n",
    );
    const subtree = apply_operation(
      subtree_index,
      mapping_for(subtree_index, "map"),
      {
        id: "set-subtree",
        type: "set_mapping_value",
        pair: { index: 0 },
        value: { nested: true },
      },
    );
    expect(subtree.text).toBe(
      "map:\n  value:\n    nested: true\n  keep: untouched\n",
    );

    const later_subtree = apply_operation(
      subtree_index,
      mapping_for(subtree_index, "map"),
      {
        id: "set-later-subtree",
        type: "set_mapping_value",
        pair: { index: 1 },
        value: { still: "preserved" },
      },
    );
    expect(later_subtree.text).toBe(
      "map:\n  value: old\n  keep:\n    still: preserved\n",
    );

    const deleted = apply_operation(index, target, {
      id: "delete-beta",
      type: "delete_mapping_pair",
      pair: { index: 1 },
    });
    expect(deleted.text).not.toContain("beta:");
    expect(deleted.text).toContain("alpha: one # preserve alpha");

    const moved = apply_operation(index, target, {
      id: "move-gamma",
      type: "move_mapping_pair",
      pair: { index: 2 },
      position: { kind: "prepend" },
    });
    expect(moved.text).toBe(`settings:
  gamma:
    nested: yes
  alpha: one # preserve alpha
  beta: two
`);

    const moved_after = apply_operation(index, target, {
      id: "move-alpha-after-gamma",
      type: "move_mapping_pair",
      pair: { index: 0 },
      position: { kind: "after", pair: { index: 2 } },
    });
    expect(moved_after.text).toBe(`settings:
  beta: two
  gamma:
    nested: yes
  alpha: one # preserve alpha
`);

    const reordered = apply_operation(index, target, {
      id: "reorder",
      type: "reorder_mapping_pairs",
      pairs: [{ index: 2 }, { index: 0 }, { index: 1 }],
    });
    expect(reordered.text).toBe(moved.text);
  });

  it.each([
    {
      name: "LF add before an owned comment",
      source: "map:\n  a: one # inline a\n  # owned b\n  b: two # inline b\n",
      operation: {
        id: "comment-add",
        type: "add_mapping_pair",
        key: "added",
        value: true,
        position: { kind: "before", pair: { index: 1 } },
      },
      expected:
        "map:\n  a: one # inline a\n  added: true\n  # owned b\n  b: two # inline b\n",
    },
    {
      name: "CRLF move leaves a blank-line separator comment behind",
      source:
        "map:\r\n  a: one # inline a\r\n  b: two # inline b\r\n  # separator\r\n\r\n  c: three # inline c\r\n",
      operation: {
        id: "comment-move",
        type: "move_mapping_pair",
        pair: { index: 2 },
        position: { kind: "prepend" },
      },
      expected:
        "map:\r\n  c: three # inline c\r\n  a: one # inline a\r\n  b: two # inline b\r\n  # separator\r\n\r\n",
    },
    {
      name: "CR reorder moves an owned comment with its pair",
      source:
        "map:\r  a: one # inline a\r  # owned b\r  b: two # inline b\r  c: three # inline c\r",
      operation: {
        id: "comment-reorder",
        type: "reorder_mapping_pairs",
        pairs: [{ index: 1 }, { index: 0 }, { index: 2 }],
      },
      expected:
        "map:\r  # owned b\r  b: two # inline b\r  a: one # inline a\r  c: three # inline c\r",
    },
  ])("preserves mapping comment ownership for $name", (test_case) => {
    const index = create_index(test_case.source);
    const result = apply_operation(
      index,
      mapping_for(index, "map"),
      test_case.operation,
    );
    expect(result.text).toBe(test_case.expected);
    expect(
      parse_yaml_source(create_source_record(Buffer.from(result.text))).errors,
    ).toEqual([]);
  });

  it("covers mapping collection bytes with non-overlapping comment-aware records", () => {
    const index = create_index(
      "map:\n  a: one\n  # owned b\n  b: two\n  # separator\n\n  c: three\n",
    );
    const layout = collection_items(
      { index },
      mapping_for(index, "map"),
      "mapping",
    );
    expect(layout.records[0].coverage_start_byte).toBe(layout.start_byte);
    for (
      let record_index = 1;
      record_index < layout.records.length;
      record_index += 1
    ) {
      expect(layout.records[record_index - 1].coverage_end_byte).toBe(
        layout.records[record_index].coverage_start_byte,
      );
    }
    expect(layout.records.at(-1).coverage_end_byte).toBe(layout.end_byte);
    expect(
      join_item_buffers(layout.records, layout.indent, layout.line_break),
    ).toEqual(index.source.buffer.subarray(layout.start_byte, layout.end_byte));
  });

  it("reports identity edits and exact structural result ranges", () => {
    const index = create_index(mapping_source);
    const target = mapping_for(index, "settings");
    const identity_operations = [
      {
        id: "identity-rename",
        type: "rename_mapping_key",
        pair: { index: 0 },
        key: "alpha",
      },
      {
        id: "identity-reorder",
        type: "reorder_mapping_pairs",
        pairs: [{ index: 0 }, { index: 1 }, { index: 2 }],
      },
      {
        id: "identity-move",
        type: "move_mapping_pair",
        pair: { index: 0 },
        position: { kind: "prepend" },
      },
    ];
    for (const operation of identity_operations) {
      const { compiled, text } = apply_operation(index, target, operation);
      expect(text).toBe(mapping_source);
      expect(compiled.splices).toEqual([]);
      expect(compiled.result_range).toBeNull();
      expect(compiled.semantic_change).toMatchObject({ no_op: true });
    }

    const added = apply_operation(index, target, {
      id: "range-add",
      type: "add_mapping_pair",
      key: "inserted",
      value: "value",
      position: { kind: "before", pair: { index: 1 } },
    });
    expect(
      Buffer.from(added.text)
        .subarray(
          added.compiled.result_range.start_byte,
          added.compiled.result_range.end_byte,
        )
        .toString("utf8"),
    ).toBe("inserted: value\n");

    const moved = apply_operation(index, target, {
      id: "range-move",
      type: "move_mapping_pair",
      pair: { index: 2 },
      position: { kind: "prepend" },
    });
    expect(
      Buffer.from(moved.text)
        .subarray(
          moved.compiled.result_range.start_byte,
          moved.compiled.result_range.end_byte,
        )
        .toString("utf8"),
    ).toBe("gamma:\n    nested: yes\n");

    const deleted = apply_operation(index, target, {
      id: "range-delete",
      type: "delete_mapping_pair",
      pair: { index: 1 },
    });
    expect(deleted.compiled.result_range).toBeNull();
  });

  it("replaces existing collection values without rebuilding their pairs", () => {
    const mapping_index = create_index(`map:
  target: # retain header
    nested: old
  keep: untouched # retain pair
`);
    const mapping_result = apply_operation(
      mapping_index,
      mapping_for(mapping_index, "map"),
      {
        id: "mapping-to-scalar",
        type: "set_mapping_value",
        pair: { index: 0 },
        value: "changed",
      },
    );
    expect(mapping_result.text).toBe(`map:
  target: # retain header
    changed
  keep: untouched # retain pair
`);
    expect(mapping_result.compiled.splices[0]).toMatchObject({
      start_byte: mapping_index.source.buffer.indexOf(
        Buffer.from("nested: old"),
      ),
      replacement_buffer: Buffer.from("changed"),
    });

    const sequence_index = create_index(`map:
  target:
    - old # replaced value
  keep: untouched # retain pair
`);
    const sequence_result = apply_operation(
      sequence_index,
      mapping_for(sequence_index, "map"),
      {
        id: "sequence-to-mapping",
        type: "set_mapping_value",
        pair: { index: 0 },
        value: { nested: true },
      },
    );
    expect(sequence_result.text).toBe(`map:
  target:
    nested: true
  keep: untouched # retain pair
`);
    expect(sequence_result.text).toContain("keep: untouched # retain pair");
  });

  it("rejects structural styles and non-JSON mapping values", () => {
    const index = create_index("map:\n  target: old\n  keep: untouched\n");
    const target = mapping_for(index, "map");
    const cyclic = { nested: true };
    cyclic.self = cyclic;
    const invalid_operations = [
      {
        id: "mapping-style",
        type: "set_mapping_value",
        pair: { index: 0 },
        value: { nested: true },
        style: "plain",
      },
      {
        id: "sequence-style",
        type: "set_mapping_value",
        pair: { index: 0 },
        value: ["one"],
        style: "double",
      },
      ...[
        undefined,
        () => true,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        cyclic,
        new Date(0),
      ].map((value, case_index) => ({
        id: `unsafe-value-${case_index}`,
        type: "set_mapping_value",
        pair: { index: 0 },
        value,
      })),
    ];
    invalid_operations.forEach((operation) => {
      expect(() => apply_operation(index, target, operation)).toThrowError(
        expect.objectContaining({ code: "REQUEST_ERROR" }),
      );
    });

    const scalar_style = apply_operation(index, target, {
      id: "scalar-style-remains-supported",
      type: "set_mapping_value",
      pair: { index: 0 },
      value: "changed",
      style: "double",
    });
    expect(scalar_style.text).toBe(
      'map:\n  target: "changed"\n  keep: untouched\n',
    );
  });

  it("returns exact value-node ranges for scalar-to-collection replacements", () => {
    const source = `map:
  before: keep # before
  target: old # target header
  after: keep # after
`;
    const path = [{ mapping_key: "map" }, { mapping_key: "target" }];
    const index = create_index(source);
    const target = mapping_for(index, "map");

    for (const [id, value, expected] of [
      ["scalar-to-mapping-range", { nested: true }, "nested: true\n"],
      ["scalar-to-sequence-range", ["one", "two"], "- one\n    - two\n"],
    ]) {
      const result = apply_operation(index, target, {
        id,
        type: "set_mapping_value",
        pair: { index: 1 },
        value,
      });
      const candidate_source = create_source_record(
        Buffer.from(result.text, "utf8"),
      );
      const candidate_index = build_node_index(
        candidate_source,
        parse_yaml_source(candidate_source),
      );
      const candidate_value = select_unique_node(candidate_index, { path });
      expect(result.compiled.result_range).toEqual({
        start_byte: candidate_value.source.start_byte,
        end_byte: candidate_value.source.end_byte,
      });
      expect(
        Buffer.from(result.text, "utf8")
          .subarray(
            result.compiled.result_range.start_byte,
            result.compiled.result_range.end_byte,
          )
          .toString("utf8"),
      ).toBe(expected);
    }
  });

  it.each([
    {
      name: "spaced LF separator with comment",
      source:
        "map:\n  before: keep\n  target : old # target header\n  after: keep\n",
      expected:
        "map:\n  before: keep\n  target : # target header\n    nested: true\n  after: keep\n",
      value_raw: "nested: true\n",
    },
    {
      name: "ordinary LF separator without comment",
      source: "map:\n  before: keep\n  target: old\n  after: keep\n",
      expected:
        "map:\n  before: keep\n  target:\n    nested: true\n  after: keep\n",
      value_raw: "nested: true\n",
    },
    {
      name: "spaced CRLF separator with comment",
      source:
        "map:\r\n  before: keep\r\n  target : old # target header\r\n  after: keep\r\n",
      expected:
        "map:\r\n  before: keep\r\n  target : # target header\r\n    nested: true\r\n  after: keep\r\n",
      value_raw: "nested: true\r\n",
    },
    {
      name: "ordinary CR separator without comment",
      source: "map:\r  before: keep\r  target: old\r  after: keep\r",
      expected:
        "map:\r  before: keep\r  target:\r    nested: true\r  after: keep\r",
      value_raw: "nested: true\r",
    },
    {
      name: "LF separator header comment",
      source:
        "map:\n  before: keep\n  target: # header\n    old\n  after: keep\n",
      expected:
        "map:\n  before: keep\n  target: # header\n    nested: true\n  after: keep\n",
      value_raw: "nested: true\n",
      value: { nested: true },
    },
    {
      name: "CRLF separator header comment for a sequence",
      source:
        "map:\r\n  before: keep\r\n  target: # header\r\n    old\r\n  after: keep\r\n",
      expected:
        "map:\r\n  before: keep\r\n  target: # header\r\n    - one\r\n    - two\r\n  after: keep\r\n",
      value_raw: "- one\r\n    - two\r\n",
      value: ["one", "two"],
    },
  ])("preserves $name when creating a collection value", (test_case) => {
    const index = create_index(test_case.source);
    const result = apply_operation(index, mapping_for(index, "map"), {
      id: `preserve-${test_case.name}`,
      type: "set_mapping_value",
      pair: { index: 1 },
      value: test_case.value || { nested: true },
    });
    expect(result.text).toBe(test_case.expected);

    const candidate_source = create_source_record(
      Buffer.from(result.text, "utf8"),
    );
    const candidate_index = build_node_index(
      candidate_source,
      parse_yaml_source(candidate_source),
    );
    const candidate_value = select_unique_node(candidate_index, {
      path: [{ mapping_key: "map" }, { mapping_key: "target" }],
    });
    expect(result.compiled.result_range).toEqual({
      start_byte: candidate_value.source.start_byte,
      end_byte: candidate_value.source.end_byte,
    });
    expect(
      candidate_source.buffer
        .subarray(
          result.compiled.result_range.start_byte,
          result.compiled.result_range.end_byte,
        )
        .toString("utf8"),
    ).toBe(test_case.value_raw);
  });

  it("renames only a selected key and supports complex-key pair locators", () => {
    const index = create_index(`? [complex, key]
: first # retain
plain: second
`);
    const target = select_unique_node(index, {
      path: [],
      node_type: "mapping",
    });
    const key_digest = target.child_key_digests[0];

    const result = apply_operation(index, target, {
      id: "rename-complex",
      type: "rename_mapping_key",
      pair: { key_raw_digest: key_digest },
      key: "renamed",
    });
    expect(result.text).toBe("? renamed\n: first # retain\nplain: second\n");
    expect(result.text).toContain("first # retain");
  });

  it("resolves a mapping pair locator without a prebuilt addressable context", () => {
    const index = create_index(
      "? [complex, key]\n: first # retain\nplain: second\n",
    );
    const target = select_unique_node(index, {
      path: [],
      node_type: "mapping",
    });
    const addressable_index = build_addressable_index(index);
    const target_addressable = addressable_index.node_entry_by_id.get(
      target.id,
    );
    const complex_pair = addressable_index.entries.find(
      (entry) =>
        entry.addressable_type === "mapping_pair" &&
        entry.parent_id === target_addressable.id &&
        entry.mapping_pair_index === 0,
    );
    const result = apply_operation(index, target, {
      id: "public-pair-locator",
      type: "rename_mapping_key",
      pair: { locator: complex_pair.locator },
      key: "renamed",
    });
    expect(result.text).toBe("? renamed\n: first # retain\nplain: second\n");
  });

  it("rejects multiline key renames and preserves structural-looking key semantics", () => {
    const source = "old: 1\nkeep: 2\n";
    const index = create_index(source);
    const target = select_unique_node(index, {
      path: [],
      node_type: "mapping",
    });
    expect(() =>
      apply_operation(index, target, {
        id: "reject-multiline-key",
        type: "rename_mapping_key",
        pair: { index: 0 },
        key: "a\nb",
      }),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_EDIT_SHAPE" }));
    expect(index.source.buffer.toString("utf8")).toBe(source);

    const result = apply_operation(index, target, {
      id: "structural-looking-key",
      type: "rename_mapping_key",
      pair: { index: 0 },
      key: "a: b",
    });
    const candidate_source = create_source_record(Buffer.from(result.text));
    const parsed = parse_yaml_source(candidate_source);
    expect(parsed.errors).toEqual([]);
    expect(parsed.documents[0].toJSON()).toEqual({ "a: b": 1, keep: 2 });
  });

  it("rejects flow collections and invalid pair positions", () => {
    const index = create_index("map: { alpha: one }\n");
    const target = mapping_for(index, "map");
    expect(() =>
      apply_operation(index, target, {
        id: "flow",
        type: "add_mapping_pair",
        key: "beta",
        value: "two",
      }),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_EDIT_SHAPE" }));

    const block_index = create_index("map:\n  alpha: one\n");
    expect(() =>
      apply_operation(block_index, mapping_for(block_index, "map"), {
        id: "bad-index",
        type: "add_mapping_pair",
        key: "beta",
        value: "two",
        position: { kind: "index", index: -1 },
      }),
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  });

  it("keeps CRLF records and supports deletion of the final mapping pair", () => {
    const crlf_index = create_index("map:\r\n  alpha: one\r\n");
    const appended = apply_operation(
      crlf_index,
      mapping_for(crlf_index, "map"),
      {
        id: "crlf-append",
        type: "add_mapping_pair",
        key: "beta",
        value: "two",
      },
    );
    expect(appended.text).toBe("map:\r\n  alpha: one\r\n  beta: two\r\n");

    const final_index = create_index("alpha: one\n");
    const deleted = apply_operation(
      final_index,
      select_unique_node(final_index, { path: [], node_type: "mapping" }),
      { id: "delete-final", type: "delete_mapping_pair", pair: { index: 0 } },
    );
    expect(deleted.text).toBe("{}\n");
  });

  it("keeps CR-only separators in structural mapping edits", () => {
    const index = create_index("map:\r  alpha: one\r");
    const result = apply_operation(index, mapping_for(index, "map"), {
      id: "cr-add",
      type: "add_mapping_pair",
      key: "beta",
      value: "two",
    });
    expect(result.text).toBe("map:\r  alpha: one\r  beta: two\r");
  });

  it.each([
    {
      name: "LF add",
      source: "map:\n  a: one",
      operation: {
        id: "eof-add",
        type: "add_mapping_pair",
        key: "b",
        value: "two",
      },
      expected: "map:\n  a: one\n  b: two",
    },
    {
      name: "CRLF move",
      source: "map:\r\n  a: one\r\n  b: two",
      operation: {
        id: "eof-move",
        type: "move_mapping_pair",
        pair: { index: 1 },
        position: { kind: "prepend" },
      },
      expected: "map:\r\n  b: two\r\n  a: one",
    },
    {
      name: "CR reorder",
      source: "map:\r  a: one\r  b: two\r  c: three",
      operation: {
        id: "eof-reorder",
        type: "reorder_mapping_pairs",
        pairs: [{ index: 2 }, { index: 0 }, { index: 1 }],
      },
      expected: "map:\r  c: three\r  a: one\r  b: two",
    },
  ])("preserves a missing terminal newline for mapping $name", (test_case) => {
    const index = create_index(test_case.source);
    const result = apply_operation(
      index,
      mapping_for(index, "map"),
      test_case.operation,
    );
    expect(result.text).toBe(test_case.expected);
    expect(result.text).not.toMatch(/[\r\n]$/);
  });

  it("rejects a pair locator owned by another mapping", () => {
    const index = create_index("first:\n  a: one\nsecond:\n  b: two\n");
    const addressable_index = build_addressable_index(index);
    const target = mapping_for(index, "first");
    const second = mapping_for(index, "second");
    const second_addressable = addressable_index.node_entry_by_id.get(
      second.id,
    );
    const other_pair = addressable_index.entries.find(
      (entry) =>
        entry.addressable_type === "mapping_pair" &&
        entry.parent_id === second_addressable.id,
    );

    expect(() =>
      apply_operation(index, target, {
        id: "cross-parent",
        type: "delete_mapping_pair",
        pair: { locator: other_pair.locator },
      }),
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  });
});
