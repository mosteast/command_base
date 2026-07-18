import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

import source_module from "../lib/yaml_patch/source";
import parser_module from "../lib/yaml_patch/parser";
import node_index_module from "../lib/yaml_patch/node_index";
import query_module from "../lib/yaml_patch/query";
import operation_module from "../lib/yaml_patch/operation";
import mapping_edit_module from "../lib/yaml_patch/mapping_edit";
import scalar_edit_module from "../lib/yaml_patch/scalar_edit";
import sequence_edit_module from "../lib/yaml_patch/sequence_edit";
import range_set_module from "../lib/yaml_patch/range_set";

const { create_source_record } = source_module;
const { parse_yaml_source } = parser_module;
const { build_node_index } = node_index_module;
const { select_unique_node } = query_module;
const { compile_operation: compile_structural_operation } = operation_module;
const { compile_operation: compile_mapping_operation } = mapping_edit_module;
const { compile_operation: compile_scalar_operation } = scalar_edit_module;
const { compile_operation: compile_sequence_operation } = sequence_edit_module;
const { apply_range_set } = range_set_module;
const public_api = createRequire(import.meta.url)("..");

function create_index(text) {
  const source = create_source_record(Buffer.from(text, "utf8"));
  return build_node_index(source, parse_yaml_source(source));
}

function target_for(index, key) {
  return select_unique_node(index, { path: [{ mapping_key: key }] });
}

function expect_request_error(callback) {
  expect(callback).toThrowError(
    expect.objectContaining({ code: "REQUEST_ERROR" }),
  );
}

describe("YAML structural operation request contracts", () => {
  it("rejects malformed operations before compiling candidate edits", () => {
    const index = create_index(`value: old
map:
  alpha: one
items:
  - one
`);
    const scalar_target = target_for(index, "value");
    const mapping_target = target_for(index, "map");
    const sequence_target = target_for(index, "items");

    expect_request_error(() =>
      compile_structural_operation({ index }, scalar_target, {
        id: "unknown-operation",
        type: "unknown_operation",
      }),
    );
    expect_request_error(() =>
      compile_scalar_operation({ index }, scalar_target, {
        type: "replace_scalar_raw",
        raw: "new",
      }),
    );
    expect_request_error(() =>
      compile_mapping_operation({ index }, mapping_target, {
        id: "missing-mapping-value",
        type: "add_mapping_pair",
        key: "beta",
      }),
    );
    expect_request_error(() =>
      compile_scalar_operation({ index }, scalar_target, {
        id: "missing-raw",
        type: "replace_scalar_raw",
      }),
    );
    expect_request_error(() =>
      compile_sequence_operation({}, sequence_target, {
        id: "malformed-context",
        type: "append_sequence_item",
        value: "two",
      }),
    );
    expect_request_error(() =>
      compile_mapping_operation({ index }, null, {
        id: "malformed-target",
        type: "add_mapping_pair",
        key: "beta",
        value: "two",
      }),
    );
    expect_request_error(() =>
      compile_sequence_operation({ index }, sequence_target, {
        id: "malformed-position",
        type: "insert_sequence_item",
        value: "two",
        position: { kind: "before" },
      }),
    );
  });

  it("rejects unknown fields for every structural operation", () => {
    const index = create_index(`value: old
map:
  alpha: one
items:
  - one
`);
    const scalar_target = target_for(index, "value");
    const mapping_target = target_for(index, "map");
    const sequence_target = target_for(index, "items");
    const typed_one = { type: "integer", value: 1 };
    const cases = [
      [
        compile_scalar_operation,
        scalar_target,
        { type: "replace_scalar_raw", raw: "new" },
      ],
      [
        compile_scalar_operation,
        scalar_target,
        { type: "set_scalar_value", value: { type: "string", value: "new" } },
      ],
      [
        compile_mapping_operation,
        mapping_target,
        { type: "add_mapping_pair", key: "beta", value: 2 },
      ],
      [
        compile_mapping_operation,
        mapping_target,
        { type: "set_mapping_value", pair: { index: 0 }, value: 2 },
      ],
      [
        compile_mapping_operation,
        mapping_target,
        { type: "delete_mapping_pair", pair: { index: 0 } },
      ],
      [
        compile_mapping_operation,
        mapping_target,
        { type: "rename_mapping_key", pair: { index: 0 }, key: "beta" },
      ],
      [
        compile_mapping_operation,
        mapping_target,
        {
          type: "move_mapping_pair",
          pair: { index: 0 },
          position: { kind: "append" },
        },
      ],
      [
        compile_mapping_operation,
        mapping_target,
        { type: "reorder_mapping_pairs", pairs: [{ index: 0 }] },
      ],
      [
        compile_sequence_operation,
        sequence_target,
        { type: "append_sequence_item", value: 2 },
      ],
      [
        compile_sequence_operation,
        sequence_target,
        { type: "prepend_sequence_item", value: 2 },
      ],
      [
        compile_sequence_operation,
        sequence_target,
        {
          type: "insert_sequence_item",
          value: 2,
          position: { kind: "append" },
        },
      ],
      [
        compile_sequence_operation,
        sequence_target,
        { type: "delete_sequence_item", index: 0 },
      ],
      [
        compile_sequence_operation,
        sequence_target,
        { type: "swap_sequence_items", left_index: 0, right_index: 0 },
      ],
      [
        compile_sequence_operation,
        sequence_target,
        { type: "reorder_sequence_items", indices: [0] },
      ],
      [
        compile_sequence_operation,
        sequence_target,
        { type: "move_sequence_item", index: 0, position: { kind: "append" } },
      ],
      [
        compile_sequence_operation,
        sequence_target,
        { type: "append_unique_sequence_value", value: typed_one },
      ],
      [
        compile_sequence_operation,
        sequence_target,
        { type: "delete_one_sequence_value", value: typed_one },
      ],
      [
        compile_sequence_operation,
        sequence_target,
        { type: "delete_all_sequence_values", value: typed_one },
      ],
      [
        compile_sequence_operation,
        sequence_target,
        { type: "assert_sequence_unique" },
      ],
    ];

    cases.forEach(([compile, target, operation], case_index) => {
      expect_request_error(() =>
        compile({ index }, target, {
          id: `unknown-field-${case_index}`,
          ...operation,
          unexpected: true,
        }),
      );
    });
  });

  it("rejects malformed required fields, references, and positions", () => {
    const index = create_index(`value: old
map:
  alpha: one
items:
  - one
`);
    const scalar_target = target_for(index, "value");
    const mapping_target = target_for(index, "map");
    const sequence_target = target_for(index, "items");
    const invalid_cases = [
      () =>
        compile_scalar_operation({ index }, scalar_target, {
          id: "raw-type",
          type: "replace_scalar_raw",
          raw: 1,
        }),
      () =>
        compile_mapping_operation({ index }, mapping_target, {
          id: "pair-index-type",
          type: "delete_mapping_pair",
          pair: { index: "0" },
        }),
      () =>
        compile_mapping_operation({ index }, mapping_target, {
          id: "mapping-position-fields",
          type: "add_mapping_pair",
          key: "beta",
          value: 2,
          position: { kind: "prepend", index: 0 },
        }),
      () =>
        compile_mapping_operation({ index }, mapping_target, {
          id: "mapping-before-fields",
          type: "move_mapping_pair",
          pair: { index: 0 },
          position: { kind: "before", pair: { index: 0 }, index: 0 },
        }),
      () =>
        compile_sequence_operation({ index }, sequence_target, {
          id: "missing-delete-index",
          type: "delete_sequence_item",
        }),
      () =>
        compile_sequence_operation({ index }, sequence_target, {
          id: "swap-index-type",
          type: "swap_sequence_items",
          left_index: "0",
          right_index: 0,
        }),
      () =>
        compile_sequence_operation({ index }, sequence_target, {
          id: "reorder-index-type",
          type: "reorder_sequence_items",
          indices: ["0"],
        }),
      () =>
        compile_sequence_operation({ index }, sequence_target, {
          id: "sequence-position-fields",
          type: "insert_sequence_item",
          value: 2,
          position: { kind: "append", index: 0 },
        }),
      () =>
        compile_sequence_operation({ index }, sequence_target, {
          id: "sequence-before-ambiguous",
          type: "move_sequence_item",
          index: 0,
          position: { kind: "before", index: 0, item: { index: 0 } },
        }),
      () =>
        compile_sequence_operation({ index }, sequence_target, {
          id: "sequence-item-fields",
          type: "move_sequence_item",
          index: 0,
          position: {
            kind: "before",
            item: { locator: "ignored", unexpected: true },
          },
        }),
    ];
    invalid_cases.forEach((compile) => expect_request_error(compile));
  });

  it("publishes cross-file moves with side-specific snapshot provenance", () => {
    expect(public_api.compile_cross_file_move).toBeTypeOf("function");
    const source_index = create_index("items:\n  - moved\n");
    source_index.source.requested_path = "/tmp/source.yaml";
    const destination_index = create_index("items:\n  - kept\n");
    destination_index.source.requested_path = "/tmp/destination.yaml";
    const compiled = public_api.compile_cross_file_move(
      { index: source_index },
      target_for(source_index, "items"),
      { index: destination_index },
      target_for(destination_index, "items"),
      {
        id: "public-cross-file",
        type: "move_sequence_item",
        index: 0,
        position: { kind: "prepend" },
      },
    );

    expect(compiled.source.provenance).toEqual({
      operation_id: "public-cross-file",
      type: "move_sequence_item",
      side: "source",
      source_digest: source_index.source.digest,
      source_path: "/tmp/source.yaml",
    });
    expect(compiled.destination.provenance).toEqual({
      operation_id: "public-cross-file",
      type: "move_sequence_item",
      side: "destination",
      source_digest: destination_index.source.digest,
      source_path: "/tmp/destination.yaml",
    });
  });

  it("keeps BOM and Unicode byte ranges bound across multiple documents", () => {
    const bom_index = create_index("\ufeff标题: 保留\nvalue: old\n");
    const bom_target = target_for(bom_index, "value");
    const compiled = compile_scalar_operation(
      { index: bom_index },
      bom_target,
      {
        id: "bom-unicode",
        type: "replace_scalar_raw",
        raw: "new",
      },
    );
    expect(compiled.splices[0].start_byte).toBe(
      bom_index.source.buffer.indexOf(Buffer.from("old")),
    );
    expect(
      apply_range_set(bom_index.source.buffer, compiled.splices)
        .candidate_buffer,
    ).toEqual(Buffer.from("\ufeff标题: 保留\nvalue: new\n", "utf8"));

    const old_index = create_index("---\nmeta: old\n---\nvalue: target\n");
    const current_index = create_index("---\nmeta: new\n---\nvalue: target\n");
    const old_target = select_unique_node(old_index, {
      document: 1,
      path: [{ mapping_key: "value" }],
    });
    expect(() =>
      compile_scalar_operation({ index: current_index }, old_target, {
        id: "stale-multi-document",
        type: "replace_scalar_raw",
        raw: "changed",
      }),
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  });

  it.each([
    "scalar unchanged local bytes",
    "scalar shifted range",
    "mapping unchanged local bytes",
    "mapping changed pair membership",
  ])("binds %s to the active source snapshot", (case_name) => {
    const is_mapping = case_name.startsWith("mapping");
    let old_source;
    let current_source;
    if (case_name === "scalar unchanged local bytes") {
      old_source = "meta: old\nvalue: target\n";
      current_source = "meta: new\nvalue: target\n";
    } else if (case_name === "scalar shifted range") {
      old_source = "meta: x\nvalue: target\n";
      current_source = "meta: longer\nvalue: target\n";
    } else if (case_name === "mapping unchanged local bytes") {
      old_source = "meta: old\nmap:\n  alpha: one\n";
      current_source = "meta: new\nmap:\n  alpha: one\n";
    } else {
      old_source = "map:\n  alpha: one\n";
      current_source = "map:\n  beta: two\n  alpha: one\n";
    }
    const old_index = create_index(old_source);
    const current_index = create_index(current_source);
    const old_target = target_for(old_index, is_mapping ? "map" : "value");

    expect(() => {
      if (is_mapping) {
        compile_mapping_operation({ index: current_index }, old_target, {
          id: `stale-${case_name}`,
          type: "add_mapping_pair",
          key: "added",
          value: true,
        });
        return;
      }
      compile_scalar_operation({ index: current_index }, old_target, {
        id: `stale-${case_name}`,
        type: "replace_scalar_raw",
        raw: "changed",
      });
    }).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  });
});
