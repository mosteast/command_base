import { describe, expect, it } from "vitest";

import source_module from "../lib/yaml_patch/source";
import parser_module from "../lib/yaml_patch/parser";
import node_index_module from "../lib/yaml_patch/node_index";
import query_module from "../lib/yaml_patch/query";
import edit_range_module from "../lib/yaml_patch/edit_range";

const { create_source_record } = source_module;
const { parse_yaml_source } = parser_module;
const { build_node_index, get_index_node } = node_index_module;
const { find_nodes, select_unique_node } = query_module;
const { resolve_edit_range } = edit_range_module;

function create_index(text) {
  const source = create_source_record(Buffer.from(text, "utf8"));
  return build_node_index(source, parse_yaml_source(source));
}

const query_fixture = `---
services:
  - name: api
    status: 'active'
  - name: worker
    status: inactive
flow: { retries: 3 }
---
enabled: true
`;

describe("YAML node index and first-version query", () => {
  it("finds a node by document and exact generic structure path", () => {
    const index = create_index(query_fixture);

    const matches = find_nodes(index, {
      version: 1,
      document: 0,
      path: [
        { mapping_key: "services" },
        { sequence_index: 1 },
        { mapping_key: "status" },
      ],
      node_type: "scalar",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      document: 0,
      node_type: "scalar",
      raw: "inactive",
      mapping_key: "status",
      relationship: "mapping_value",
      source: { line: 6, column: 13 },
    });
    expect(matches[0].path).toEqual([
      expect.objectContaining({ mapping_pair_index: 0 }),
      { sequence_index: 1 },
      expect.objectContaining({ mapping_pair_index: 1 }),
    ]);
    expect(matches[0].locator).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("supports pair indexes with a key raw digest and exact raw scalars", () => {
    const index = create_index(query_fixture);
    const flow_entry = select_unique_node(index, {
      version: 1,
      document: 0,
      path: [{ mapping_key: "flow" }],
      node_type: "mapping",
    });
    const retries_entry = select_unique_node(index, {
      version: 1,
      document: 0,
      path: [
        { mapping_key: "flow" },
        {
          mapping_pair_index: 0,
          key_raw_digest: flow_entry.child_key_digests[0],
        },
      ],
      raw_equals: "3",
    });

    expect(retries_entry.mapping_pair_index).toBe(0);
    expect(retries_entry.raw).toBe("3");
    expect(retries_entry.source.start_byte).toBe(
      Buffer.byteLength(query_fixture.slice(0, query_fixture.indexOf("3"))),
    );
  });

  it("keeps quoted raw values distinct from resolved values", () => {
    const index = create_index(query_fixture);

    expect(find_nodes(index, { raw_equals: "'active'" })).toHaveLength(1);
    expect(find_nodes(index, { raw_equals: "active" })).toEqual([]);
  });

  it("matches complete block-scalar raw text", () => {
    const index = create_index("value: |-\n  first\n  第二😀\n");

    expect(
      find_nodes(index, {
        node_type: "scalar",
        raw_equals: "|-\n  first\n  第二😀\n",
      }),
    ).toHaveLength(1);
  });

  it("uses stable zero and ambiguous match errors", () => {
    const index = create_index(query_fixture);

    expect(() =>
      select_unique_node(index, {
        document: 0,
        path: [{ mapping_key: "missing" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "NO_MATCH" }));
    expect(() =>
      select_unique_node(index, { document: 0, raw_equals: "name" }),
    ).toThrowError(expect.objectContaining({ code: "AMBIGUOUS_MATCH" }));
  });

  it("rejects unknown or mixed nested query fields", () => {
    const index = create_index(query_fixture);

    expect(() =>
      find_nodes(index, {
        version: 1,
        path: [{ mapping_key: "services", required_future_field: true }],
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() =>
      find_nodes(index, {
        version: 1,
        path: [{ mapping_key: "services", sequence_index: 0 }],
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() =>
      find_nodes(index, {
        version: 1,
        source: { line: 1, required_future_field: true },
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() =>
      find_nodes(index, {
        version: 1,
        path: [{ mapping_pair_index: 0 }],
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("selects documents and exact source positions", () => {
    const index = create_index(query_fixture);
    const enabled = select_unique_node(index, {
      version: 1,
      document: 1,
      path: [{ mapping_key: "enabled" }],
      source: { line: 9, column: 10 },
    });

    expect(enabled.raw).toBe("true");
    expect(enabled.document).toBe(1);
  });

  it("keeps collection indexes compact and enforces post-parse resource limits", () => {
    const source = create_source_record(Buffer.from("root:\n  child: value\n"));
    const parsed = parse_yaml_source(source);
    const index = build_node_index(source, parsed);
    const root = select_unique_node(index, {
      document: 0,
      path: [],
      node_type: "mapping",
    });

    expect(root.raw).toBeUndefined();
    expect(root.raw_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      build_node_index(source, parsed, { max_node_count: 2 }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
    expect(() =>
      build_node_index(source, parsed, { max_depth: 1 }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
  });
});

const range_fixture = `plain: value # tail
single: 'one'
double: "two"
literal: |+
  line 1
  line 2
flow_map: { a: 1, b: two }
flow_seq: [one, two]
block_map:
  child: yes
block_seq:
  - alpha
  - beta
anchored: &shared !custom tagged
alias: *shared
empty:
`;

describe("YAML edit range resolver", () => {
  it.each([
    ["plain", "value"],
    ["single", "'one'"],
    ["double", '"two"'],
  ])("resolves only the %s scalar token", (mapping_key, expected) => {
    const index = create_index(range_fixture);
    const entry = select_unique_node(index, {
      document: 0,
      path: [{ mapping_key }],
    });

    const edit_range = resolve_edit_range(index, entry, "scalar-token");

    expect(
      index.source.buffer
        .subarray(edit_range.start_byte, edit_range.end_byte)
        .toString("utf8"),
    ).toBe(expected);
    expect(edit_range.node_type).toBe("scalar");
  });

  it.each([
    ["literal", "|+\n  line 1\n  line 2\n", "scalar"],
    ["flow_map", "{ a: 1, b: two }", "mapping"],
    ["flow_seq", "[one, two]", "sequence"],
    ["block_map", "child: yes\n", "mapping"],
    ["block_seq", "- alpha\n  - beta\n", "sequence"],
  ])(
    "resolves the complete %s node value",
    (mapping_key, expected, node_type) => {
      const index = create_index(range_fixture);
      const entry = select_unique_node(index, {
        document: 0,
        path: [{ mapping_key }],
      });

      const edit_range = resolve_edit_range(index, entry, "node-value");
      const actual = index.source.buffer
        .subarray(edit_range.start_byte, edit_range.end_byte)
        .toString("utf8");

      expect(actual).toBe(expected);
      expect(edit_range.node_type).toBe(node_type);
    },
  );

  it("keeps anchor and tag prefixes outside mapping-value edits", () => {
    const index = create_index(range_fixture);
    const entry = select_unique_node(index, {
      document: 0,
      path: [{ mapping_key: "anchored" }],
    });

    const edit_range = resolve_edit_range(index, entry, "mapping-value");

    expect(
      index.source.buffer
        .subarray(edit_range.start_byte, edit_range.end_byte)
        .toString("utf8"),
    ).toBe("tagged");
    expect(entry.anchor).toBe("shared");
    expect(entry.tag).toBe("!custom");
  });

  it("maps Unicode block scalar character spans to exact byte ranges", () => {
    const index = create_index("label: |-\n  中文😀\n");
    const entry = select_unique_node(index, {
      path: [{ mapping_key: "label" }],
    });

    const edit_range = resolve_edit_range(index, entry, "node-value");

    expect(
      index.source.buffer
        .subarray(edit_range.start_byte, edit_range.end_byte)
        .toString("utf8"),
    ).toBe("|-\n  中文😀\n");
  });

  it("rejects block scalar tokens, implicit values, and unsupported units", () => {
    const index = create_index(range_fixture);
    const literal = select_unique_node(index, {
      path: [{ mapping_key: "literal" }],
    });
    const empty = select_unique_node(index, {
      path: [{ mapping_key: "empty" }],
    });

    expect(() =>
      resolve_edit_range(index, literal, "scalar-token"),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_EDIT_SHAPE" }));
    expect(() => resolve_edit_range(index, empty, "node-value")).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_EDIT_SHAPE" }),
    );
    expect(() =>
      resolve_edit_range(index, literal, "mapping-pair"),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_EDIT_UNIT" }));
  });

  it("rejects a collection whose recursive CST span disagrees with Node.range", () => {
    const index = create_index(range_fixture);
    const flow_map = select_unique_node(index, {
      path: [{ mapping_key: "flow_map" }],
    });
    const flow_node = get_index_node(index, flow_map);
    const closing_token = flow_node.srcToken.end.find(
      (token) => token.type === "flow-map-end",
    );
    closing_token.offset += 1;

    expect(() =>
      resolve_edit_range(index, flow_map, "node-value"),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_EDIT_SHAPE" }));
  });

  it("cross-checks scalar-token source text before authorizing bytes", () => {
    const index = create_index("value: old\n");
    const entry = select_unique_node(index, {
      path: [{ mapping_key: "value" }],
    });
    index.source.text = "value: NEW\n";

    expect(() => resolve_edit_range(index, entry, "scalar-token")).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_EDIT_SHAPE" }),
    );
  });
});
