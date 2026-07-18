import { describe, expect, it } from "vitest";

import source_module from "../lib/yaml_patch/source";
import parser_module from "../lib/yaml_patch/parser";
import node_index_module from "../lib/yaml_patch/node_index";
import query_module from "../lib/yaml_patch/query";
import range_set_module from "../lib/yaml_patch/range_set";
import sequence_edit_module from "../lib/yaml_patch/sequence_edit";

const { create_source_record } = source_module;
const { parse_yaml_source } = parser_module;
const { build_node_index } = node_index_module;
const { select_unique_node } = query_module;
const { apply_range_set } = range_set_module;
const { compile_operation } = sequence_edit_module;

function create_index(text) {
  const source = create_source_record(Buffer.from(text, "utf8"));
  return build_node_index(source, parse_yaml_source(source));
}

function sequence_for(index, mapping_key) {
  return select_unique_node(index, { path: [{ mapping_key }] });
}

function apply_operation(index, target, operation) {
  const compiled = compile_operation({ index }, target, operation);
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
});
