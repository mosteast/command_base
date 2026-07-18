import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import source_module from "../lib/yaml_patch/source";
import parser_module from "../lib/yaml_patch/parser";
import node_index_module from "../lib/yaml_patch/node_index";
import addressable_module from "../lib/yaml_patch/addressable";

const { create_source_record, sha256_digest } = source_module;
const { parse_yaml_source } = parser_module;
const { build_node_index, get_index_node } = node_index_module;
const { build_addressable_index, resolve_alias_target, typed_scalar_metadata } =
  addressable_module;
const commonjs_node_index = createRequire(import.meta.url)(
  "../lib/yaml_patch/node_index",
);

function create_index(text_or_buffer, options = {}) {
  const buffer = Buffer.isBuffer(text_or_buffer)
    ? text_or_buffer
    : Buffer.from(text_or_buffer, "utf8");
  const source = create_source_record(buffer, options);
  return build_node_index(source, parse_yaml_source(source));
}

function entries_of_type(addressable_index, addressable_type) {
  return addressable_index.entries.filter(
    (entry) => entry.addressable_type === addressable_type,
  );
}

function decode_locator(locator) {
  return JSON.parse(Buffer.from(locator, "base64url").toString("utf8"));
}

const graph_fixture = `---
root:
  text: value
  integer: 1
  float: 1.0
  boolean: true
  null: null
  strings: ["1", '1.0', "true", 'null']
  aliases:
    - &shared target
    - *shared
? [complex, key]
: result
...
`;

describe("YAML addressable index", () => {
  it("keeps the node-index compatibility exports bound to the facade", () => {
    expect(commonjs_node_index.build_addressable_index).toBeTypeOf("function");
    expect(commonjs_node_index.encode_locator_v2).toBeTypeOf("function");
    expect(commonjs_node_index.resolve_alias_target).toBeTypeOf("function");
    expect(commonjs_node_index.typed_scalar_metadata).toBeTypeOf("function");
  });

  it("adds every node and relationship without changing the v1 index", () => {
    const index = create_index(graph_fixture);
    const v1_snapshot = JSON.stringify(index.entries);
    const v1_locators = index.entries.map((entry) => entry.locator);

    const addressable_index = build_addressable_index(index);

    expect(
      new Set(addressable_index.entries.map((entry) => entry.addressable_type)),
    ).toEqual(
      new Set([
        "stream",
        "document",
        "mapping",
        "mapping_pair",
        "mapping_key",
        "mapping_value",
        "sequence",
        "sequence_item",
        "scalar",
        "alias",
      ]),
    );
    expect(JSON.stringify(index.entries)).toBe(v1_snapshot);
    expect(index.entries.map((entry) => entry.locator)).toEqual(v1_locators);

    const node_entries = addressable_index.entries.filter((entry) =>
      ["mapping", "sequence", "scalar", "alias"].includes(
        entry.addressable_type,
      ),
    );
    expect(node_entries).toHaveLength(index.entries.length);
    expect(addressable_index.node_entry_by_id.size).toBe(index.entries.length);
    expect(new Set(addressable_index.node_entry_by_id.values()).size).toBe(
      index.entries.length,
    );

    const stream = entries_of_type(addressable_index, "stream")[0];
    const document = entries_of_type(addressable_index, "document")[0];
    const root_mapping = addressable_index.by_id.get(document.child_ids[0]);
    expect(stream).toMatchObject({
      parent_id: null,
      sibling_position: 0,
      depth: 0,
      direct_child_count: 1,
    });
    expect(document).toMatchObject({
      parent_id: stream.id,
      parent_path: stream.path,
      sibling_position: 0,
      depth: 1,
      direct_child_count: 1,
    });
    expect(root_mapping).toMatchObject({
      addressable_type: "mapping",
      parent_id: document.id,
      parent_path: document.path,
      sibling_position: 0,
      depth: 2,
    });

    const pair = addressable_index.entries.find(
      (entry) =>
        entry.addressable_type === "mapping_pair" &&
        entry.raw.startsWith("root:"),
    );
    const pair_children = pair.child_ids.map((id) =>
      addressable_index.by_id.get(id),
    );
    expect(pair_children.map((entry) => entry.addressable_type)).toEqual([
      "mapping_key",
      "mapping_value",
    ]);
    expect(pair_children.map((entry) => entry.sibling_position)).toEqual([
      0, 1,
    ]);
    for (const relationship_entry of pair_children) {
      expect(relationship_entry.direct_child_count).toBe(1);
      const contained_node = addressable_index.by_id.get(
        relationship_entry.child_ids[0],
      );
      expect(contained_node.parent_id).toBe(relationship_entry.id);
      expect(contained_node.path).toEqual(relationship_entry.path);
    }

    const sequence_item = entries_of_type(
      addressable_index,
      "sequence_item",
    ).find((entry) => entry.raw.includes("*shared"));
    const contained_alias = addressable_index.by_id.get(
      sequence_item.child_ids[0],
    );
    expect(contained_alias).toMatchObject({
      addressable_type: "alias",
      parent_id: sequence_item.id,
      sibling_position: 0,
      raw: "*shared",
    });

    for (const entry of addressable_index.entries) {
      expect(addressable_index.by_id.get(entry.id)).toBe(entry);
      expect(entry.direct_child_count).toBe(entry.child_ids.length);
      if (entry.parent_id !== null) {
        const parent = addressable_index.by_id.get(entry.parent_id);
        expect(entry.parent_path).toEqual(parent.path);
        expect(entry.depth).toBe(parent.depth + 1);
        expect(parent.child_ids[entry.sibling_position]).toBe(entry.id);
      }
      const descendants = [];
      const pending = [...entry.child_ids];
      while (pending.length > 0) {
        const child = addressable_index.by_id.get(pending.pop());
        descendants.push(child);
        pending.push(...child.child_ids);
      }
      expect(entry.descendant_count).toBe(descendants.length);
    }
  });

  it("distinguishes YAML 1.2 scalar types while preserving exact raw tokens", () => {
    const index = create_index(`integer: 1
float: 1.0
boolean: true
"null": null
quoted_integer: "1"
quoted_float: '1.0'
quoted_boolean: "true"
quoted_null: 'null'
custom: !opaque 1
`);
    const addressable_index = build_addressable_index(index);

    function mapping_value(mapping_key) {
      const v1_entry = index.entries.find(
        (entry) =>
          entry.relationship === "mapping_value" &&
          entry.mapping_key === mapping_key,
      );
      return addressable_index.node_entry_by_id.get(v1_entry.id);
    }

    expect(mapping_value("integer")).toMatchObject({
      scalar_type: "integer",
      scalar_value: 1,
      raw: "1",
    });
    expect(mapping_value("float")).toMatchObject({
      scalar_type: "float",
      scalar_value: 1,
      raw: "1.0",
    });
    expect(mapping_value("boolean")).toMatchObject({
      scalar_type: "boolean",
      scalar_value: true,
      raw: "true",
    });
    expect(mapping_value("null")).toMatchObject({
      scalar_type: "null",
      scalar_value: null,
      raw: "null",
    });
    expect(mapping_value("quoted_integer")).toMatchObject({
      scalar_type: "string",
      scalar_value: "1",
      raw: '"1"',
    });
    expect(mapping_value("quoted_float")).toMatchObject({
      scalar_type: "string",
      scalar_value: "1.0",
      raw: "'1.0'",
    });
    expect(mapping_value("quoted_boolean")).toMatchObject({
      scalar_type: "string",
      scalar_value: "true",
      raw: '"true"',
    });
    expect(mapping_value("quoted_null")).toMatchObject({
      scalar_type: "string",
      scalar_value: "null",
      raw: "'null'",
    });
    expect(mapping_value("custom")).toMatchObject({
      tag: "!opaque",
      raw: "1",
    });
    expect(mapping_value("custom").scalar_type).toBeUndefined();

    const integer_node = get_index_node(
      index,
      index.entries.find(
        (entry) => entry.mapping_key === "integer" && entry.raw === "1",
      ),
    );
    expect(typed_scalar_metadata(integer_node, "1")).toEqual({
      scalar_type: "integer",
      scalar_value: 1,
    });
  });

  it("omits typed metadata when a standard tag fails to resolve", () => {
    const index = create_index(`failed_float: !!float nope
failed_integer: !!int nope
failed_boolean: !!bool nope
failed_null: !!null nope
valid_float: !!float 1.0
valid_integer: !!int 1
valid_boolean: !!bool true
valid_null: !!null null
`);
    const addressable_index = build_addressable_index(index);

    function mapping_value(mapping_key) {
      const v1_entry = index.entries.find(
        (entry) =>
          entry.relationship === "mapping_value" &&
          entry.mapping_key === mapping_key,
      );
      return addressable_index.node_entry_by_id.get(v1_entry.id);
    }

    for (const mapping_key of [
      "failed_float",
      "failed_integer",
      "failed_boolean",
      "failed_null",
    ]) {
      const entry = mapping_value(mapping_key);
      expect(entry.raw).toBe("nope");
      expect(entry.scalar_type).toBeUndefined();
      expect(entry.scalar_value).toBeUndefined();
    }
    expect(mapping_value("valid_float")).toMatchObject({
      scalar_type: "float",
      scalar_value: 1,
    });
    expect(mapping_value("valid_integer")).toMatchObject({
      scalar_type: "integer",
      scalar_value: 1,
    });
    expect(mapping_value("valid_boolean")).toMatchObject({
      scalar_type: "boolean",
      scalar_value: true,
    });
    expect(mapping_value("valid_null")).toMatchObject({
      scalar_type: "null",
      scalar_value: null,
    });
  });

  it("derives BOM, document, complex pair, and sequence item ranges from CST", () => {
    const text = `%YAML 1.2
---
? [complex, key]
: result
...
---
items:
  - first
  - second
`;
    const buffer = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(text, "utf8"),
    ]);
    const index = create_index(buffer, { file_path: "/tmp/source.yaml" });
    const addressable_index = build_addressable_index(index);

    const stream = entries_of_type(addressable_index, "stream")[0];
    const documents = entries_of_type(addressable_index, "document");
    expect(stream).toMatchObject({
      raw: `\ufeff${text}`,
      raw_digest: index.source.digest,
      source_digest: index.source.digest,
      source_path: "/tmp/source.yaml",
      source: { start_byte: 0, end_byte: buffer.length },
    });
    expect(documents.map((entry) => entry.raw)).toEqual([
      `%YAML 1.2
---
? [complex, key]
: result
...
`,
      `---
items:
  - first
  - second
`,
    ]);
    expect(documents[0].source.start_byte).toBe(3);
    expect(documents[1].source.end_byte).toBe(buffer.length);

    const complex_pair = entries_of_type(
      addressable_index,
      "mapping_pair",
    ).find((entry) => entry.raw.startsWith("? [complex"));
    expect(complex_pair.raw).toBe("? [complex, key]\n: result\n");
    expect(complex_pair.source.start_byte).toBe(
      buffer.indexOf(Buffer.from("? [complex", "utf8")),
    );
    const complex_key_relation = addressable_index.by_id.get(
      complex_pair.child_ids[0],
    );
    const complex_key_node = addressable_index.by_id.get(
      complex_key_relation.child_ids[0],
    );
    expect(complex_key_node).toMatchObject({
      addressable_type: "sequence",
      relationship: "mapping_key",
    });

    const sequence_items = entries_of_type(
      addressable_index,
      "sequence_item",
    ).filter((entry) => entry.document === 1);
    expect(sequence_items.map((entry) => entry.raw)).toEqual([
      "- first\n",
      "- second\n",
    ]);

    const implicit_index = create_index("empty: # retained\n");
    const implicit_addressable = build_addressable_index(implicit_index);
    expect(entries_of_type(implicit_addressable, "mapping_pair")[0].raw).toBe(
      "empty: # retained\n",
    );

    const block_scalar_index = create_index("literal: |+\n  first\n  second\n");
    const block_scalar_addressable =
      build_addressable_index(block_scalar_index);
    const block_scalar = entries_of_type(
      block_scalar_addressable,
      "scalar",
    ).find((entry) => entry.relationship === "mapping_value");
    expect(block_scalar.raw).toBe("|+\n  first\n  second\n");
  });

  it.each([
    ["{? key}\n", "? key"],
    ["{ : value }\n", " : value "],
    ["{key: value}\n", "key: value"],
  ])(
    "indexes every key, value, and indicator in flow mapping %s",
    (text, expected_pair_raw) => {
      const index = create_index(text);
      const addressable_index = build_addressable_index(index);
      const pair = entries_of_type(addressable_index, "mapping_pair")[0];
      const relationships = pair.child_ids.map((id) =>
        addressable_index.by_id.get(id),
      );

      expect(pair.raw).toBe(expected_pair_raw);
      expect(relationships.map((entry) => entry.addressable_type)).toEqual([
        "mapping_key",
        "mapping_value",
      ]);
      for (const relationship of relationships) {
        expect(relationship.source.start_byte).toBeGreaterThanOrEqual(
          pair.source.start_byte,
        );
        expect(relationship.source.end_byte).toBeLessThanOrEqual(
          pair.source.end_byte,
        );
        expect(relationship.direct_child_count).toBe(1);
        if (relationship.raw === "") {
          const scalar = addressable_index.by_id.get(relationship.child_ids[0]);
          expect(relationship.raw_digest).toBe(sha256_digest(Buffer.alloc(0)));
          expect(scalar).toMatchObject({
            addressable_type: "scalar",
            scalar_type: "null",
            scalar_value: null,
            raw: "",
            size_bytes: 0,
          });
        }
      }
    },
  );

  it("indexes a compact mapping as the contained node of a flow sequence item", () => {
    const index = create_index("[a: b]\n");
    const addressable_index = build_addressable_index(index);
    const sequence = entries_of_type(addressable_index, "sequence")[0];
    const sequence_item = addressable_index.by_id.get(sequence.child_ids[0]);
    const mapping = addressable_index.by_id.get(sequence_item.child_ids[0]);

    expect(sequence_item).toMatchObject({
      addressable_type: "sequence_item",
      raw: "a: b",
    });
    expect(mapping).toMatchObject({
      addressable_type: "mapping",
      raw: "a: b",
      parent_id: sequence_item.id,
    });
    expect(addressable_index.by_id.get(mapping.child_ids[0])).toMatchObject({
      addressable_type: "mapping_pair",
      raw: "a: b",
    });
  });

  it.each(["{key}\n", "key:\n"])(
    "creates a zero-width typed null mapping value for %s",
    (text) => {
      const index = create_index(text);
      const addressable_index = build_addressable_index(index);
      const pair = entries_of_type(addressable_index, "mapping_pair")[0];
      const mapping_value = pair.child_ids
        .map((id) => addressable_index.by_id.get(id))
        .find((entry) => entry.addressable_type === "mapping_value");
      const scalar = addressable_index.by_id.get(mapping_value.child_ids[0]);

      expect(mapping_value).toMatchObject({ raw: "", size_bytes: 0 });
      expect(mapping_value.mapping_key).toBe("key");
      expect(scalar).toMatchObject({
        addressable_type: "scalar",
        node_type: "scalar",
        scalar_type: "null",
        scalar_value: null,
        raw: "",
        size_bytes: 0,
        mapping_key: "key",
      });
      expect(scalar.raw_digest).toBe(mapping_value.raw_digest);
      expect(scalar.raw_digest).toBe(sha256_digest(Buffer.alloc(0)));
    },
  );

  it("keeps a legal implicit null sequence item zero-width", () => {
    const index = create_index("- # empty\n- value\n");
    const addressable_index = build_addressable_index(index);
    const sequence_item = entries_of_type(
      addressable_index,
      "sequence_item",
    )[0];
    const scalar = addressable_index.by_id.get(sequence_item.child_ids[0]);

    expect(sequence_item.raw).toBe("- # empty\n");
    expect(scalar).toMatchObject({
      addressable_type: "scalar",
      scalar_type: "null",
      scalar_value: null,
      raw: "",
      size_bytes: 0,
    });
  });

  it("keeps aliases opaque by default and resolves targets only on request", () => {
    const index = create_index("values: [&shared target, *shared]\n");
    const addressable_index = build_addressable_index(index);
    const alias_entry = entries_of_type(addressable_index, "alias")[0];

    expect(alias_entry.target_id).toBeUndefined();
    expect(alias_entry.child_ids).toEqual([]);

    const resolution = resolve_alias_target(index, alias_entry, {
      addressable_index,
      max_alias_hop: 8,
    });

    expect(resolution.alias_entry).toBe(alias_entry);
    expect(resolution.target_entry).toMatchObject({
      addressable_type: "scalar",
      raw: "target",
      anchor: "shared",
    });
    expect(resolution.alias_location).toEqual({
      locator: alias_entry.locator,
      document: alias_entry.document,
      path: alias_entry.path,
      source: alias_entry.source,
    });
    expect(resolution.target_location).toEqual({
      locator: resolution.target_entry.locator,
      document: resolution.target_entry.document,
      path: resolution.target_entry.path,
      source: resolution.target_entry.source,
    });
    expect(resolution.hop_count).toBe(1);

    const resolved_addressable = build_addressable_index(index, {
      resolve_alias_target: true,
    });
    const resolved_alias = entries_of_type(resolved_addressable, "alias")[0];
    expect(resolved_alias.alias_target).toMatchObject({
      target_id: expect.any(Number),
      hop_count: 1,
      alias_location: { locator: resolved_alias.locator },
      target_location: { locator: expect.any(String) },
    });
    expect(() => JSON.stringify(resolved_addressable.entries)).not.toThrow();

    expect(() =>
      resolve_alias_target(index, alias_entry, {
        addressable_index,
        max_alias_hop: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));

    const missing_index = create_index("value: *missing\n");
    const missing_addressable = build_addressable_index(missing_index);
    const missing_alias = entries_of_type(missing_addressable, "alias")[0];
    expect(() =>
      resolve_alias_target(missing_index, missing_alias, {
        addressable_index: missing_addressable,
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("binds locator v2 to the artifact, source snapshot, and target", () => {
    const first_index = create_index("value: same\n");
    const second_index = create_index("# changed\nvalue: same\n");
    const first_addressable = build_addressable_index(first_index);
    const second_addressable = build_addressable_index(second_index);
    const first_entry = first_addressable.entries.find(
      (entry) => entry.addressable_type === "scalar" && entry.raw === "same",
    );
    const second_entry = second_addressable.entries.find(
      (entry) => entry.addressable_type === "scalar" && entry.raw === "same",
    );

    const locator_data = decode_locator(first_entry.locator);
    expect(locator_data).toEqual({
      addressable_type: "scalar",
      document: 0,
      end_byte: first_entry.source.end_byte,
      path: first_entry.path,
      source_digest: first_index.source.digest,
      source_identity: first_index.source.source_identity,
      start_byte: first_entry.source.start_byte,
      target_digest: first_entry.raw_digest,
      version: 2,
    });
    expect(first_entry.locator).not.toBe(second_entry.locator);
  });

  it("fails stably when document or pair CST ranges cannot be proven", () => {
    const document_index = create_index("---\nvalue: old\n");
    document_index.parser_result.documents[0].range[2] -= 1;
    expect(() => build_addressable_index(document_index)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );

    const pair_index = create_index("? [complex, key]\n: value\n");
    const mapping = get_index_node(pair_index, pair_index.entries[0]);
    mapping.items[0].srcToken.sep[1].offset += 1;
    expect(() => build_addressable_index(pair_index)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );

    const stale_source_index = create_index("# note\nvalue: old\n");
    stale_source_index.source.buffer[2] = "N".charCodeAt(0);
    expect(() => build_addressable_index(stale_source_index)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
});
