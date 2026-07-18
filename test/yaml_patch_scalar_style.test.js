import { describe, expect, it } from "vitest";

import source_module from "../lib/yaml_patch/source";
import parser_module from "../lib/yaml_patch/parser";
import node_index_module from "../lib/yaml_patch/node_index";
import query_module from "../lib/yaml_patch/query";
import range_set_module from "../lib/yaml_patch/range_set";
import scalar_edit_module from "../lib/yaml_patch/scalar_edit";
import operation_module from "../lib/yaml_patch/operation";

const { create_source_record } = source_module;
const { parse_yaml_source } = parser_module;
const { build_node_index } = node_index_module;
const { select_unique_node } = query_module;
const { apply_range_set } = range_set_module;
const { compile_operation } = scalar_edit_module;
const { compile_operation: compile_structural_operation } = operation_module;

function create_index(text) {
  const source = create_source_record(Buffer.from(text, "utf8"));
  return build_node_index(source, parse_yaml_source(source));
}

function scalar_for(index, mapping_key) {
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

describe("YAML scalar structural edits", () => {
  it("dispatches structural operation types through one compiler interface", () => {
    const index = create_index("value: old\n");
    const compiled = compile_structural_operation(
      { index },
      scalar_for(index, "value"),
      {
        id: "dispatch-scalar",
        type: "replace_scalar_raw",
        raw: "new",
      },
    );

    expect(
      apply_range_set(
        index.source.buffer,
        compiled.splices,
      ).candidate_buffer.toString(),
    ).toBe("value: new\n");
  });

  it("replaces a raw scalar token as YAML source and reparses the candidate", () => {
    const index = create_index("value: old # retain\n");
    const result = apply_operation(index, scalar_for(index, "value"), {
      id: "raw-replace",
      type: "replace_scalar_raw",
      raw: '"new value"',
    });

    expect(result.text).toBe('value: "new value" # retain\n');
    expect(result.compiled.provenance).toEqual({
      operation_id: "raw-replace",
      type: "replace_scalar_raw",
    });
    expect(() =>
      apply_operation(index, scalar_for(index, "value"), {
        id: "invalid-raw",
        type: "replace_scalar_raw",
        raw: "[unterminated",
      }),
    ).toThrowError(expect.objectContaining({ code: "YAML_DIAGNOSTIC" }));
    expect(() =>
      apply_operation(index, scalar_for(index, "value"), {
        id: "raw-collection",
        type: "replace_scalar_raw",
        raw: "[one, two]",
      }),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_EDIT_SHAPE" }));
  });

  it("uses byte equality for raw no-ops and typed equality for typed no-ops", () => {
    const raw_index = create_index("value: old\n");
    const raw = apply_operation(raw_index, scalar_for(raw_index, "value"), {
      id: "raw-no-op",
      type: "replace_scalar_raw",
      raw: "old",
    });
    expect(raw.compiled.splices).toEqual([]);
    expect(raw.compiled.semantic_change.no_op).toBe(true);

    const typed_index = create_index("value: 'same'\n");
    const typed = apply_operation(
      typed_index,
      scalar_for(typed_index, "value"),
      {
        id: "typed-no-op",
        type: "set_scalar_value",
        value: { type: "string", value: "same" },
      },
    );
    expect(typed.compiled.splices).toEqual([]);
    expect(typed.compiled.semantic_change.no_op).toBe(true);

    const explicit_same_style = apply_operation(
      typed_index,
      scalar_for(typed_index, "value"),
      {
        id: "typed-explicit-same-style",
        type: "set_scalar_value",
        value: { type: "string", value: "same" },
        style: "single",
      },
    );
    expect(explicit_same_style.compiled.splices).toEqual([]);
    expect(explicit_same_style.compiled.semantic_change.no_op).toBe(true);
  });

  it.each([
    ["plain: old\n", "plain", { type: "string", value: "new" }, "plain: new\n"],
    [
      "single: 'old'\n",
      "single",
      { type: "string", value: "new value" },
      "single: 'new value'\n",
    ],
    [
      'double: "old"\n',
      "double",
      { type: "string", value: "new value" },
      'double: "new value"\n',
    ],
    [
      "literal: |\n  old\n",
      "literal",
      { type: "string", value: "new\n" },
      "literal: |\n  new\n",
    ],
    [
      "strip: |-\n  old\n",
      "strip",
      { type: "string", value: "new" },
      "strip: |-\n  new\n",
    ],
    [
      "folded: >\n  old\n",
      "folded",
      { type: "string", value: "new\n" },
      "folded: >\n  new\n",
    ],
    [
      "indented: |-2\n  old\n",
      "indented",
      { type: "string", value: "new" },
      "indented: |-2\n  new\n",
    ],
  ])("preserves %s scalar style", (source, mapping_key, value, expected) => {
    const index = create_index(source);
    const result = apply_operation(index, scalar_for(index, mapping_key), {
      id: `style-${mapping_key}`,
      type: "set_scalar_value",
      value,
    });

    expect(result.text).toBe(expected);
  });

  it("requires an explicit style change when the old style is unsafe", () => {
    const index = create_index("value: old\n");
    const target = scalar_for(index, "value");
    expect(() =>
      apply_operation(index, target, {
        id: "unsafe-plain",
        type: "set_scalar_value",
        value: { type: "string", value: "# comment" },
      }),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_EDIT_SHAPE" }));

    const explicit = apply_operation(index, target, {
      id: "explicit-style",
      type: "set_scalar_value",
      value: { type: "string", value: "# comment" },
      style: "single",
    });
    expect(explicit.text).toBe("value: '# comment'\n");
  });
});
