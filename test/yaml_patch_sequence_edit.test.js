import { describe, expect, it } from "vitest";

import source_module from "../lib/yaml_patch/source";
import parser_module from "../lib/yaml_patch/parser";
import node_index_module from "../lib/yaml_patch/node_index";
import query_module from "../lib/yaml_patch/query";
import range_set_module from "../lib/yaml_patch/range_set";
import sequence_edit_module from "../lib/yaml_patch/sequence_edit";
import addressable_module from "../lib/yaml_patch/addressable";

const { create_source_record } = source_module;
const { parse_yaml_source } = parser_module;
const { build_node_index } = node_index_module;
const { select_unique_node } = query_module;
const { apply_range_set } = range_set_module;
const { compile_cross_file_move, compile_operation } = sequence_edit_module;
const { build_addressable_index } = addressable_module;

function create_index(text, requested_path) {
  const source = create_source_record(Buffer.from(text, "utf8"), {
    ...(requested_path === undefined ? {} : { requested_path }),
  });
  return build_node_index(source, parse_yaml_source(source));
}

function sequence_for(index, mapping_key) {
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

const sequence_source = `items:
  - one # first
  - two
  - three
`;

describe("YAML sequence structural edits", () => {
  it("prepends, appends, and inserts at current snapshot positions", () => {
    const index = create_index(sequence_source);
    const target = sequence_for(index, "items");
    const prepended = apply_operation(index, target, {
      id: "prepend",
      type: "prepend_sequence_item",
      value: "zero",
    });
    expect(prepended.text).toBe(`items:
  - zero
  - one # first
  - two
  - three
`);

    const inserted = apply_operation(index, target, {
      id: "insert-before-two",
      type: "insert_sequence_item",
      value: "middle",
      position: { kind: "before", index: 1 },
    });
    expect(inserted.text).toBe(`items:
  - one # first
  - middle
  - two
  - three
`);

    const appended = apply_operation(index, target, {
      id: "append",
      type: "append_sequence_item",
      value: "four",
    });
    expect(appended.text).toBe(`items:
  - one # first
  - two
  - three
  - four
`);
  });

  it("deletes, swaps, reorders, and moves source item slices", () => {
    const index = create_index(sequence_source);
    const target = sequence_for(index, "items");
    const deleted = apply_operation(index, target, {
      id: "delete-two",
      type: "delete_sequence_item",
      index: 1,
    });
    expect(deleted.text).toBe(`items:
  - one # first
  - three
`);

    const swapped = apply_operation(index, target, {
      id: "swap",
      type: "swap_sequence_items",
      left_index: 0,
      right_index: 2,
    });
    expect(swapped.text).toBe(`items:
  - three
  - two
  - one # first
`);

    const reordered = apply_operation(index, target, {
      id: "reorder",
      type: "reorder_sequence_items",
      indices: [2, 1, 0],
    });
    expect(reordered.text).toBe(swapped.text);

    const moved = apply_operation(index, target, {
      id: "move",
      type: "move_sequence_item",
      index: 0,
      position: { kind: "after", index: 2 },
    });
    expect(moved.text).toBe(`items:
  - two
  - three
  - one # first
`);
  });

  it("moves owned comments while leaving blank-line separator comments behind", () => {
    const source =
      "items:\n  - a # inline a\n  # owned b\n  - b # inline b\n  # separator\n\n  - c # inline c\n";
    const index = create_index(source);
    const result = apply_operation(index, sequence_for(index, "items"), {
      id: "sequence-comment-move",
      type: "move_sequence_item",
      index: 2,
      position: { kind: "prepend" },
    });
    expect(result.text).toBe(
      "items:\n  - c # inline c\n  - a # inline a\n  # owned b\n  - b # inline b\n  # separator\n\n",
    );
    expect(
      parse_yaml_source(create_source_record(Buffer.from(result.text))).errors,
    ).toEqual([]);
  });

  it("reports identity edits and exact structural result ranges", () => {
    const index = create_index(sequence_source);
    const target = sequence_for(index, "items");
    for (const operation of [
      {
        id: "identity-reorder",
        type: "reorder_sequence_items",
        indices: [0, 1, 2],
      },
      {
        id: "identity-move",
        type: "move_sequence_item",
        index: 0,
        position: { kind: "prepend" },
      },
    ]) {
      const { compiled, text } = apply_operation(index, target, operation);
      expect(text).toBe(sequence_source);
      expect(compiled.splices).toEqual([]);
      expect(compiled.result_range).toBeNull();
      expect(compiled.semantic_change).toMatchObject({ no_op: true });
    }

    const appended = apply_operation(index, target, {
      id: "range-append",
      type: "append_sequence_item",
      value: "four",
    });
    expect(
      Buffer.from(appended.text)
        .subarray(
          appended.compiled.result_range.start_byte,
          appended.compiled.result_range.end_byte,
        )
        .toString("utf8"),
    ).toBe("- four\n");

    const moved = apply_operation(index, target, {
      id: "range-move",
      type: "move_sequence_item",
      index: 0,
      position: { kind: "append" },
    });
    expect(
      Buffer.from(moved.text)
        .subarray(
          moved.compiled.result_range.start_byte,
          moved.compiled.result_range.end_byte,
        )
        .toString("utf8"),
    ).toBe("- one # first\n");

    const deleted = apply_operation(index, target, {
      id: "range-delete",
      type: "delete_sequence_item",
      index: 1,
    });
    expect(deleted.compiled.result_range).toBeNull();
  });

  it("compiles a cross-file move into source and destination contracts", () => {
    const source_index = create_index(
      `items:
  - keep: source
  - name: 'move me' # retained
    nested:
      key: value
`,
      "/tmp/source.yaml",
    );
    const destination_index = create_index(
      `items:
  - name: existing
`,
      "/tmp/destination.yaml",
    );
    const operation = {
      id: "cross-file-move",
      type: "move_sequence_item",
      index: 1,
      position: { kind: "prepend" },
    };

    const compiled = compile_cross_file_move(
      { index: source_index },
      sequence_for(source_index, "items"),
      { index: destination_index },
      sequence_for(destination_index, "items"),
      operation,
    );

    expect(Object.keys(compiled).sort()).toEqual(["destination", "source"]);
    for (const side of [compiled.source, compiled.destination]) {
      expect(side).toMatchObject({
        splices: [
          {
            operation_id: "cross-file-move",
            replacement_buffer: expect.any(Buffer),
          },
        ],
        provenance: {
          operation_id: "cross-file-move",
          type: "move_sequence_item",
        },
        semantic_change: { no_op: false },
      });
    }
    expect(compiled.source.result_range).toBeNull();
    expect(
      apply_range_set(
        source_index.source.buffer,
        compiled.source.splices,
      ).candidate_buffer.toString("utf8"),
    ).toBe(`items:
  - keep: source
`);
    const destination_text = apply_range_set(
      destination_index.source.buffer,
      compiled.destination.splices,
    ).candidate_buffer.toString("utf8");
    expect(destination_text).toBe(`items:
  - name: 'move me' # retained
    nested:
      key: value
  - name: existing
`);
    expect(destination_text).toContain(
      "- name: 'move me' # retained\n    nested:\n      key: value\n",
    );
    expect(
      Buffer.from(destination_text)
        .subarray(
          compiled.destination.result_range.start_byte,
          compiled.destination.result_range.end_byte,
        )
        .toString("utf8"),
    ).toBe("- name: 'move me' # retained\n    nested:\n      key: value\n");
  });

  it("rebases only structural indentation for a cross-file move", () => {
    const source_index = create_index(`items:
  - name: moved # retain
    nested: value
`);
    const destination_index = create_index(`wrapper:
  items:
    - name: existing
`);
    const compiled = compile_cross_file_move(
      { index: source_index },
      sequence_for(source_index, "items"),
      { index: destination_index },
      select_unique_node(destination_index, {
        path: [{ mapping_key: "wrapper" }, { mapping_key: "items" }],
      }),
      {
        id: "rebase-cross-file-move",
        type: "move_sequence_item",
        index: 0,
        position: { kind: "prepend" },
      },
    );

    const destination_text = apply_range_set(
      destination_index.source.buffer,
      compiled.destination.splices,
    ).candidate_buffer.toString("utf8");
    expect(destination_text).toBe(`wrapper:
  items:
    - name: moved # retain
      nested: value
    - name: existing
`);
    expect(destination_text).toContain("name: moved # retain");
    expect(destination_text).toContain("nested: value");
  });

  it("uses typed equality for unique append and precise value deletion", () => {
    const source = `values:
  - 1
  - "1"
  - 1
`;
    const index = create_index(source);
    const target = sequence_for(index, "values");
    const unique = apply_operation(index, target, {
      id: "unique",
      type: "append_unique_sequence_value",
      value: { type: "integer", value: 1 },
    });
    expect(unique.compiled.splices).toEqual([]);

    const deleted_one = apply_operation(index, target, {
      id: "delete-one",
      type: "delete_one_sequence_value",
      value: { type: "integer", value: 1 },
    });
    expect(deleted_one.text).toBe(`values:
  - "1"
  - 1
`);

    const deleted_all = apply_operation(index, target, {
      id: "delete-all",
      type: "delete_all_sequence_values",
      value: { type: "integer", value: 1 },
    });
    expect(deleted_all.text).toBe(`values:
  - "1"
`);

    expect(() =>
      apply_operation(index, target, {
        id: "duplicates",
        type: "assert_sequence_unique",
      }),
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  });

  it("validates new sequence subtrees before YAML serialization", () => {
    const index = create_index("items:\n  - keep # retain\n");
    const target = sequence_for(index, "items");
    const cyclic = {};
    cyclic.self = cyclic;
    const sparse = [];
    sparse[1] = "value";
    const invalid_values = [
      undefined,
      () => true,
      Symbol("value"),
      1n,
      new Date(0),
      cyclic,
      sparse,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
    ];
    invalid_values.forEach((value, case_index) => {
      expect(() =>
        apply_operation(index, target, {
          id: `unsafe-append-${case_index}`,
          type: "append_sequence_item",
          value,
        }),
      ).toThrowError(expect.objectContaining({ code: "REQUEST_ERROR" }));
    });

    const legal = apply_operation(index, target, {
      id: "safe-append-subtree",
      type: "append_sequence_item",
      value: { nested: ["one", true] },
    });
    expect(legal.text).toContain("- keep # retain");
    expect(
      parse_yaml_source(
        create_source_record(Buffer.from(legal.text)),
      ).documents[0].toJSON(),
    ).toEqual({ items: ["keep", { nested: ["one", true] }] });
  });

  it("treats safe integer and decimal_string representations as one typed value", () => {
    const index = create_index(`values:
  - 1
  - 01
`);
    const target = sequence_for(index, "values");
    const encoded_one = {
      type: "integer",
      value: "1",
      value_encoding: "decimal_string",
    };

    const appended = apply_operation(index, target, {
      id: "encoded-append",
      type: "append_unique_sequence_value",
      value: encoded_one,
    });
    expect(appended.compiled.splices).toEqual([]);

    const deleted = apply_operation(index, target, {
      id: "encoded-delete",
      type: "delete_one_sequence_value",
      value: encoded_one,
    });
    expect(deleted.text).toBe(`values:
  - 01
`);

    expect(() =>
      apply_operation(index, target, {
        id: "encoded-duplicates",
        type: "assert_sequence_unique",
      }),
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  });

  it("resolves before and after against current sequence item references", () => {
    const index = create_index(sequence_source);
    const target = sequence_for(index, "items");
    const addressable_index = build_addressable_index(index);
    const target_addressable = addressable_index.node_entry_by_id.get(
      target.id,
    );
    const item_entries = addressable_index.entries.filter(
      (entry) =>
        entry.addressable_type === "sequence_item" &&
        entry.parent_id === target_addressable.id,
    );

    const before = apply_operation(
      index,
      target,
      {
        id: "before-locator",
        type: "insert_sequence_item",
        value: "inserted",
        position: {
          kind: "before",
          item: { locator: item_entries[1].locator },
        },
      },
      { addressable_index },
    );
    expect(before.text).toContain("- inserted\n  - two");

    const after = apply_operation(
      index,
      target,
      {
        id: "after-current-entry",
        type: "insert_sequence_item",
        value: "inserted",
        position: {
          kind: "after",
          item: { current_entry: item_entries[1] },
        },
      },
      { addressable_index },
    );
    expect(after.text).toContain("- two\n  - inserted");
  });

  it("rejects stale sequence targets and vanished current item references", () => {
    const old_index = create_index(sequence_source);
    const old_target = sequence_for(old_index, "items");
    const old_addressable = build_addressable_index(old_index);
    const old_target_addressable = old_addressable.node_entry_by_id.get(
      old_target.id,
    );
    const old_item = old_addressable.entries.find(
      (entry) =>
        entry.addressable_type === "sequence_item" &&
        entry.parent_id === old_target_addressable.id &&
        entry.sequence_index === 1,
    );
    const current_index = create_index(`items:
  - one # first
  - replacement
  - three
`);
    const current_target = sequence_for(current_index, "items");
    const current_addressable = build_addressable_index(current_index);

    expect(() =>
      apply_operation(
        current_index,
        old_target,
        { id: "stale-target", type: "append_sequence_item", value: "four" },
        { addressable_index: current_addressable },
      ),
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));

    const destination_index = create_index(`items:
  - destination
`);
    expect(() =>
      compile_cross_file_move(
        { index: current_index },
        old_target,
        { index: destination_index },
        sequence_for(destination_index, "items"),
        {
          id: "stale-cross-file-source",
          type: "move_sequence_item",
          index: 0,
          position: { kind: "append" },
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
    expect(() =>
      apply_operation(
        current_index,
        current_target,
        {
          id: "vanished-item",
          type: "insert_sequence_item",
          value: "inserted",
          position: {
            kind: "before",
            item: { current_entry: old_item },
          },
        },
        { addressable_index: current_addressable },
      ),
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  });

  it.each(["compile_operation", "compile_cross_file_move"])(
    "%s rejects a target from a stale source digest when target bytes are unchanged",
    (compiler_name) => {
      const old_index = create_index(`meta: old
items:
  - one
  - two
`);
      const current_index = create_index(`meta: new
items:
  - one
  - two
`);
      const old_target = sequence_for(old_index, "items");
      const current_target = sequence_for(current_index, "items");
      expect(old_target).toMatchObject({
        locator: current_target.locator,
        raw_digest: current_target.raw_digest,
        source: {
          start_byte: current_target.source.start_byte,
          end_byte: current_target.source.end_byte,
        },
      });
      expect(old_index.source.digest).not.toBe(current_index.source.digest);
      expect(old_target.source_digest).toBe(old_index.source.digest);
      expect(current_target.source_digest).toBe(current_index.source.digest);

      if (compiler_name === "compile_operation") {
        expect(() =>
          apply_operation(current_index, old_target, {
            id: "stale-source-single-file",
            type: "append_sequence_item",
            value: "three",
          }),
        ).toThrowError(
          expect.objectContaining({ code: "PRECONDITION_FAILED" }),
        );
        return;
      }

      const destination_index = create_index(`items:
  - destination
`);
      expect(() =>
        compile_cross_file_move(
          { index: current_index },
          old_target,
          { index: destination_index },
          sequence_for(destination_index, "items"),
          {
            id: "stale-source-cross-file",
            type: "move_sequence_item",
            index: 0,
            position: { kind: "append" },
          },
        ),
      ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
    },
  );

  it("rejects negative, out-of-range, vanished, and flow collection positions", () => {
    const index = create_index(sequence_source);
    const target = sequence_for(index, "items");
    for (const index_value of [-1, 3]) {
      expect(() =>
        apply_operation(index, target, {
          id: `bad-${index_value}`,
          type: "delete_sequence_item",
          index: index_value,
        }),
      ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
    }

    const flow_index = create_index("items: [one, two]\n");
    expect(() =>
      apply_operation(flow_index, sequence_for(flow_index, "items"), {
        id: "flow",
        type: "append_sequence_item",
        value: "three",
      }),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_EDIT_SHAPE" }));
  });

  it("keeps CRLF records and supports deletion of the final sequence item", () => {
    const crlf_index = create_index("items:\r\n  - one\r\n");
    const appended = apply_operation(
      crlf_index,
      sequence_for(crlf_index, "items"),
      {
        id: "crlf-append",
        type: "append_sequence_item",
        value: "two",
      },
    );
    expect(appended.text).toBe("items:\r\n  - one\r\n  - two\r\n");

    const final_index = create_index("- one\n");
    const deleted = apply_operation(
      final_index,
      select_unique_node(final_index, { path: [], node_type: "sequence" }),
      { id: "delete-final", type: "delete_sequence_item", index: 0 },
    );
    expect(deleted.text).toBe("[]\n");
  });

  it("keeps CR-only separators in structural sequence edits", () => {
    const index = create_index("items:\r  - one\r");
    const result = apply_operation(index, sequence_for(index, "items"), {
      id: "cr-append",
      type: "append_sequence_item",
      value: "two",
    });
    expect(result.text).toBe("items:\r  - one\r  - two\r");
  });

  it.each([
    {
      name: "LF append",
      source: "items:\n  - one",
      operation: {
        id: "eof-append",
        type: "append_sequence_item",
        value: "two",
      },
      expected: "items:\n  - one\n  - two",
    },
    {
      name: "CRLF move",
      source: "items:\r\n  - one\r\n  - two",
      operation: {
        id: "eof-move",
        type: "move_sequence_item",
        index: 1,
        position: { kind: "prepend" },
      },
      expected: "items:\r\n  - two\r\n  - one",
    },
    {
      name: "CR reorder",
      source: "items:\r  - one\r  - two\r  - three",
      operation: {
        id: "eof-reorder",
        type: "reorder_sequence_items",
        indices: [2, 0, 1],
      },
      expected: "items:\r  - three\r  - one\r  - two",
    },
  ])("preserves a missing terminal newline for sequence $name", (test_case) => {
    const index = create_index(test_case.source);
    const result = apply_operation(
      index,
      sequence_for(index, "items"),
      test_case.operation,
    );
    expect(result.text).toBe(test_case.expected);
    expect(result.text).not.toMatch(/[\r\n]$/);
  });
});
