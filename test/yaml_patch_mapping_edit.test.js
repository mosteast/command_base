import { describe, expect, it } from "vitest";

import source_module from "../lib/yaml_patch/source";
import parser_module from "../lib/yaml_patch/parser";
import node_index_module from "../lib/yaml_patch/node_index";
import query_module from "../lib/yaml_patch/query";
import range_set_module from "../lib/yaml_patch/range_set";
import mapping_edit_module from "../lib/yaml_patch/mapping_edit";
import addressable_module from "../lib/yaml_patch/addressable";

const { create_source_record } = source_module;
const { parse_yaml_source } = parser_module;
const { build_node_index, get_index_node } = node_index_module;
const { select_unique_node } = query_module;
const { apply_range_set } = range_set_module;
const { compile_operation } = mapping_edit_module;
const { build_addressable_index } = addressable_module;

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
    const profile_order = {
      suggested_mapping_order: ["gamma", "alpha", "beta"],
    };
    const suggested = apply_operation(
      index,
      target,
      { id: "profile-order", type: "add_mapping_pair", key: "gamma", value: 3 },
      { profile: profile_order },
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
      { profile: profile_order },
    );
    expect(explicit.text).toBe("map:\n  alpha: one\n  beta: two\n  gamma: 3\n");
  });

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
      apply_operation(
        index,
        target,
        {
          id: "cross-parent",
          type: "delete_mapping_pair",
          pair: { locator: other_pair.locator },
        },
        { addressable_index },
      ),
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  });
});
