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
const { build_node_index, get_index_node } = node_index_module;
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
    ["value: 01\n", "plain", { type: "integer", value: 1 }],
    ["value: TRUE\n", "plain", { type: "boolean", value: true }],
    ['value: "a\\x62"\n', "double", { type: "string", value: "ab" }],
    ["value: |2-\n    old\n", "literal", { type: "string", value: "  old" }],
    ["value: >+\n  old\n\n", "folded", { type: "string", value: "old\n\n" }],
  ])(
    "keeps current %s bytes for an explicit same-style typed value",
    (source, style, value) => {
      const index = create_index(source);
      const result = apply_operation(index, scalar_for(index, "value"), {
        id: `same-${style}-style`,
        type: "set_scalar_value",
        value,
        style,
      });
      expect(result.text).toBe(source);
      expect(result.compiled.splices).toEqual([]);
      expect(result.compiled.result_range).toBeNull();
      expect(result.compiled.semantic_change.no_op).toBe(true);
    },
  );

  it.each([
    {
      name: "literal clip with LF",
      source: "value: |\n  old",
      expected: "value: |\n  new",
      style: "literal",
      before: "old\n",
      after: "new\n",
    },
    {
      name: "literal strip with LF",
      source: "value: |-\n  old",
      expected: "value: |-\n  new",
      style: "literal",
      before: "old",
      after: "new",
    },
    {
      name: "literal keep with CRLF",
      source: "value: |+\r\n  old",
      expected: "value: |+\r\n  new",
      style: "literal",
      before: "old\n",
      after: "new\n",
    },
    {
      name: "folded clip with CR",
      source: "value: >\r  old",
      expected: "value: >\r  new",
      style: "folded",
      before: "old\n",
      after: "new\n",
    },
  ])("preserves missing physical EOF newline for $name", (test_case) => {
    const index = create_index(test_case.source);
    const target = scalar_for(index, "value");
    const no_op = apply_operation(index, target, {
      id: `block-eof-no-op-${test_case.name}`,
      type: "set_scalar_value",
      value: { type: "string", value: test_case.before },
      style: test_case.style,
    });
    expect(no_op.compiled.splices).toEqual([]);
    expect(no_op.text).toBe(test_case.source);

    const changed = apply_operation(index, target, {
      id: `block-eof-change-${test_case.name}`,
      type: "set_scalar_value",
      value: { type: "string", value: test_case.after },
      style: test_case.style,
    });
    expect(changed.text).toBe(test_case.expected);
    expect(changed.text).not.toMatch(/[\r\n]$/);
    const candidate_source = create_source_record(Buffer.from(changed.text));
    expect(
      parse_yaml_source(candidate_source).documents[0].toJSON().value,
    ).toBe(test_case.after);
  });

  it.each([
    {
      name: "plain to literal without an EOF newline",
      source: "value: old",
      expected: "value: |\n  changed",
      style: "literal",
      value: "changed\n",
      header: "|",
    },
    {
      name: "literal to folded",
      source: "value: |\n  old\n",
      expected: "value: >\n  changed\n",
      style: "folded",
      value: "changed\n",
      header: ">",
    },
    {
      name: "folded to literal without an EOF newline",
      source: "value: >\n  old",
      expected: "value: |\n  changed",
      style: "literal",
      value: "changed\n",
      header: "|",
    },
  ])("converts $name with a source-bound block range", (test_case) => {
    const index = create_index(test_case.source);
    const result = apply_operation(index, scalar_for(index, "value"), {
      id: `convert-${test_case.name}`,
      type: "set_scalar_value",
      value: { type: "string", value: test_case.value },
      style: test_case.style,
    });
    expect(result.text).toBe(test_case.expected);

    const candidate_index = create_index(result.text);
    const candidate_target = scalar_for(candidate_index, "value");
    const candidate_node = get_index_node(candidate_index, candidate_target);
    expect(candidate_index.parser_result.errors).toEqual([]);
    expect(candidate_node.value).toBe(test_case.value);
    expect(candidate_node.srcToken.props[0].source[0]).toBe(test_case.header);
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

  it.each([
    [
      "literal keep with trailing breaks",
      "value: |+ # literal header\n  old\n",
      "new\n\n\n",
      "value: |+ # literal header\n  new\n\n\n",
    ],
    [
      "folded keep with two trailing breaks",
      "value: >+ # folded header\n  old\n",
      "new\n\n",
      "value: >+ # folded header\n  new\n\n",
    ],
    [
      "chomping before indent indicator",
      "value: |+2 # plus first\n  old\n",
      "new\n\n",
      "value: |+2 # plus first\n  new\n\n",
    ],
    [
      "indent before chomping indicator",
      "value: >2+ # indent first\n  old\n",
      "first\n\nsecond\n\n\n",
      "value: >2+ # indent first\n  first\n\n\n  second\n\n\n",
    ],
  ])(
    "preserves block scalar header trivia for %s",
    (_name, source, value, expected) => {
      const index = create_index(source);
      const result = apply_operation(index, scalar_for(index, "value"), {
        id: "block-style-regression",
        type: "set_scalar_value",
        value: { type: "string", value },
      });

      expect(result.text).toBe(expected);
    },
  );

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
