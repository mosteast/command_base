import { describe, expect, it } from "vitest";

import node_index_module from "../lib/yaml_patch/node_index";
import parser_module from "../lib/yaml_patch/parser";
import query_module from "../lib/yaml_patch/query";
import range_set_module from "../lib/yaml_patch/range_set";
import source_module from "../lib/yaml_patch/source";
import subtree_edit_module from "../lib/yaml_patch/subtree_edit";

const { build_node_index } = node_index_module;
const { parse_yaml_source } = parser_module;
const { select_unique_node } = query_module;
const { apply_range_set } = range_set_module;
const { create_source_record } = source_module;
const { compile_subtree_operation } = subtree_edit_module;

function create_index(text, requested_path) {
  const source = create_source_record(Buffer.from(text), { requested_path });
  return build_node_index(source, parse_yaml_source(source));
}

function target(index, path) {
  return select_unique_node(index, { version: 1, path });
}

function compile_cross_file(
  source,
  source_path,
  destination,
  destination_path,
  operation,
) {
  const source_index = create_index(source, "/repo/source.yaml");
  const destination_index = create_index(destination, "/repo/destination.yaml");
  const compiled = compile_subtree_operation(
    { index: source_index },
    target(source_index, source_path),
    { index: destination_index },
    target(destination_index, destination_path),
    operation,
  );
  return {
    compiled,
    source_text: apply_range_set(
      source_index.source.buffer,
      compiled.source.splices,
    ).candidate_buffer.toString(),
    destination_text: apply_range_set(
      destination_index.source.buffer,
      compiled.destination.splices,
    ).candidate_buffer.toString(),
  };
}

describe("YAML full-subtree edits", () => {
  it("adds a raw subtree as a complete sequence item", () => {
    const destination_index = create_index(
      "items:\n  - name: existing\n",
      "/repo/destination.yaml",
    );
    const destination_target = target(destination_index, [
      { mapping_key: "items" },
    ]);
    const compiled = compile_subtree_operation(
      null,
      null,
      { index: destination_index },
      destination_target,
      {
        id: "add-created",
        type: "add_subtree",
        raw: "name: created\nunknown: 'preserved'\n",
        position: { kind: "append" },
      },
    );
    expect(
      apply_range_set(
        destination_index.source.buffer,
        compiled.destination.splices,
      ).candidate_buffer.toString(),
    ).toBe(
      "items:\n  - name: existing\n  - name: created\n    unknown: 'preserved'\n",
    );
    expect(compiled.destination.result_range).toEqual({
      start_byte: 28,
      end_byte: 69,
    });
  });

  it("deletes only the selected subtree without business-policy guesses", () => {
    const source_index = create_index(
      "items:\n  - name: remove\n    unknown: keep\n  - name: remain\n",
      "/repo/source.yaml",
    );
    const source_target = target(source_index, [
      { mapping_key: "items" },
      { sequence_index: 0 },
    ]);
    const compiled = compile_subtree_operation(
      { index: source_index },
      source_target,
      null,
      null,
      { id: "delete-selected", type: "delete_subtree" },
    );
    expect(
      apply_range_set(
        source_index.source.buffer,
        compiled.source.splices,
      ).candidate_buffer.toString(),
    ).toBe("items:\n  - name: remain\n");
  });

  it("moves a complete mapping pair with its owned comment and original child bytes", () => {
    const source = `catalog:
  keep:
    value: one
  # owned by opaque
  opaque: !!map
    unknown_field: 'leave exactly'
    descendant:
      enabled: true
  # separator remains

  tail:
    value: three
`;
    const destination = `archive:
  existing:
    value: zero
`;
    const result = compile_cross_file(
      source,
      [{ mapping_key: "catalog" }, { mapping_key: "opaque" }],
      destination,
      [{ mapping_key: "archive" }],
      {
        id: "move-opaque",
        type: "move_subtree",
        position: { kind: "append" },
      },
    );

    expect(result.source_text).toBe(`catalog:
  keep:
    value: one
  # separator remains

  tail:
    value: three
`);
    expect(result.destination_text).toBe(`archive:
  existing:
    value: zero
  # owned by opaque
  opaque: !!map
    unknown_field: 'leave exactly'
    descendant:
      enabled: true
`);
    expect(result.compiled.moved_ranges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation_id: "move-opaque",
          owner: "source",
          includes_owned_comment: true,
        }),
      ]),
    );
  });

  it("copies a nested sequence item while changing only structural indentation prefixes", () => {
    const source = `source:
  items:
    # owned item
    - name: original
      unknown: "keep me"
      child:
        - nested
`;
    const destination = `destination:
  deeply:
    nested:
      items:
        - name: existing
`;
    const result = compile_cross_file(
      source,
      [
        { mapping_key: "source" },
        { mapping_key: "items" },
        { sequence_index: 0 },
      ],
      destination,
      [
        { mapping_key: "destination" },
        { mapping_key: "deeply" },
        { mapping_key: "nested" },
        { mapping_key: "items" },
      ],
      {
        id: "copy-item",
        type: "copy_subtree",
        position: { kind: "prepend" },
      },
    );

    expect(result.source_text).toBe(source);
    expect(result.destination_text).toContain(
      `        # owned item
        - name: original
          unknown: "keep me"
          child:
            - nested
`,
    );
    expect(result.destination_text).toContain("        - name: existing\n");
  });

  it("rejects relocation shapes whose byte safety cannot be proven", () => {
    const cases = [
      {
        code: "UNSUPPORTED_EDIT_SHAPE",
        source: "items:\n  - text: |2\n      exact\n",
        path: [{ mapping_key: "items" }, { sequence_index: 0 }],
      },
      {
        code: "UNSUPPORTED_EDIT_SHAPE",
        source: "items:\n  - value: { nested: flow }\n",
        path: [{ mapping_key: "items" }, { sequence_index: 0 }],
      },
      {
        code: "UNSUPPORTED_EDIT_SHAPE",
        source:
          "%TAG !app! tag:example.test,2026:\n---\nitems:\n  - !app!record { value: one }\n",
        path: [{ mapping_key: "items" }, { sequence_index: 0 }],
      },
      {
        code: "UNSUPPORTED_EDIT_SHAPE",
        source: "items:\n  - !custom\n    value: one\n",
        path: [{ mapping_key: "items" }, { sequence_index: 0 }],
      },
      {
        code: "CROSS_BOUNDARY_DEPENDENCY",
        source: "items:\n  - value: &shared one\n  - value: *shared\n",
        path: [{ mapping_key: "items" }, { sequence_index: 0 }],
      },
    ];
    const destination = "items:\n  - value: existing\n";

    for (const test_case of cases) {
      expect(() =>
        compile_cross_file(
          test_case.source,
          test_case.path,
          destination,
          [{ mapping_key: "items" }],
          {
            id: `unsafe-${test_case.code}`,
            type: "move_subtree",
            position: { kind: "append" },
          },
        ),
      ).toThrowError(expect.objectContaining({ code: test_case.code }));
    }
  });

  it("rejects a destination anchor collision before producing either candidate", () => {
    expect(() =>
      compile_cross_file(
        "items:\n  - value: &record one\n    mirror: *record\n",
        [{ mapping_key: "items" }, { sequence_index: 0 }],
        "items:\n  - value: &record existing\n",
        [{ mapping_key: "items" }],
        {
          id: "duplicate-anchor",
          type: "copy_subtree",
          position: { kind: "append" },
        },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "CROSS_BOUNDARY_DEPENDENCY" }),
    );
  });
});
