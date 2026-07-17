"use strict";

const YAML = require("yaml");

const {
  canonical_json,
  validate_artifact_version,
} = require("./artifact_version");
const { Yaml_patch_error } = require("./error");
const { sha256_digest, utf16_offset_to_byte } = require("./source");

const DEFAULT_MAX_ALIAS_HOP = 64;
const DEFAULT_MAX_ALIAS_VISIT = 256;
const STANDARD_SCALAR_TAG_TYPE = Object.freeze({
  "tag:yaml.org,2002:bool": "boolean",
  "tag:yaml.org,2002:float": "float",
  "tag:yaml.org,2002:int": "integer",
  "tag:yaml.org,2002:null": "null",
  "tag:yaml.org,2002:str": "string",
});

function validation_error(message, details = {}) {
  return new Yaml_patch_error("VALIDATION_FAILED", message, {
    details,
    next_action: "reparse the unchanged source with the supported YAML parser",
  });
}

function clone_path(path) {
  return Array.isArray(path) ? path.map((step) => ({ ...step })) : [];
}

function assert_character_range(source, start_character, end_character, kind) {
  if (
    !Number.isInteger(start_character) ||
    !Number.isInteger(end_character) ||
    start_character < 0 ||
    end_character < start_character ||
    end_character > source.text.length
  ) {
    throw validation_error(`Cannot prove ${kind} source range`, {
      kind,
      start_character,
      end_character,
      source_size_characters: source.text.length,
    });
  }
}

function token_source_ranges(source, token, kind) {
  const ranges = [];
  const visited = new WeakSet();

  function visit(value) {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);

    if (
      value.type === "block-scalar" &&
      Number.isInteger(value.offset) &&
      typeof value.source === "string"
    ) {
      const first_property_range = ranges.length;
      visit(value.props);
      const property_ranges = ranges.slice(first_property_range);
      if (property_ranges.length === 0) {
        throw validation_error(`Cannot prove ${kind} block scalar header`, {
          kind,
          start_character: value.offset,
        });
      }
      const start_character = value.offset;
      const content_start_character = Math.max(
        ...property_ranges.map((range) => range.end_character),
      );
      const end_character = content_start_character + value.source.length;
      assert_character_range(source, start_character, end_character, kind);
      const actual_source = source.text.slice(
        content_start_character,
        end_character,
      );
      if (actual_source !== value.source) {
        throw validation_error(
          `Cannot match ${kind} block scalar content to source`,
          {
            kind,
            start_character: content_start_character,
            expected_source: value.source,
            actual_source,
          },
        );
      }
      ranges.push({
        start_character,
        end_character,
        token_type: value.type,
      });
      visit(value.end);
      return;
    }

    if (Number.isInteger(value.offset) && typeof value.source === "string") {
      const start_character = value.offset;
      const end_character = start_character + value.source.length;
      assert_character_range(source, start_character, end_character, kind);
      const actual_source = source.text.slice(start_character, end_character);
      if (actual_source !== value.source) {
        throw validation_error(`Cannot match ${kind} CST token to source`, {
          kind,
          token_type: value.type,
          start_character,
          expected_source: value.source,
          actual_source,
        });
      }
      ranges.push({
        start_character,
        end_character,
        token_type: value.type,
      });
    }

    for (const [property, child] of Object.entries(value)) {
      if (property !== "source") visit(child);
    }
  }

  visit(token);
  return ranges;
}

function token_character_range(source, token, kind) {
  const ranges = token_source_ranges(source, token, kind);
  if (ranges.length === 0) {
    if (token && Number.isInteger(token.offset)) {
      assert_character_range(source, token.offset, token.offset, kind);
      return {
        start_character: token.offset,
        end_character: token.offset,
      };
    }
    throw validation_error(`Cannot derive ${kind} range from CST tokens`, {
      kind,
    });
  }
  return {
    start_character: Math.min(...ranges.map((range) => range.start_character)),
    end_character: Math.max(...ranges.map((range) => range.end_character)),
  };
}

function assert_top_level_token_coverage(source, tokens) {
  let cursor = 0;
  for (const token of tokens) {
    const range = token_character_range(source, token, "document stream");
    if (range.start_character !== cursor) {
      throw validation_error("YAML CST tokens do not cover the source stream", {
        expected_character: cursor,
        actual_character: range.start_character,
        token_type: token.type,
      });
    }
    cursor = range.end_character;
  }
  if (cursor !== source.text.length) {
    throw validation_error("YAML CST tokens do not reach the source end", {
      token_end_character: cursor,
      source_size_characters: source.text.length,
    });
  }
}

function document_character_ranges(index) {
  const { source, parser_result } = index;
  if (parser_result.errors.length > 0) {
    throw validation_error(
      "Cannot build an addressable index for invalid YAML",
      {
        errors: parser_result.errors,
      },
    );
  }

  let tokens;
  try {
    tokens = Array.from(new YAML.Parser().parse(source.text));
  } catch (error) {
    throw new Yaml_patch_error(
      "VALIDATION_FAILED",
      "Cannot independently parse YAML CST ranges",
      { cause: error },
    );
  }
  assert_top_level_token_coverage(source, tokens);

  const document_token_indexes = [];
  tokens.forEach((token, token_index) => {
    if (token.type === "document") document_token_indexes.push(token_index);
  });
  if (document_token_indexes.length !== parser_result.documents.length) {
    throw validation_error("Document and CST document counts disagree", {
      document_count: parser_result.documents.length,
      cst_document_count: document_token_indexes.length,
    });
  }

  let previous_end_character = 0;
  return parser_result.documents.map((document, document_index) => {
    const range = document.range;
    const contents_range = document.contents && document.contents.range;
    if (
      !Array.isArray(range) ||
      range.length < 3 ||
      !Array.isArray(contents_range) ||
      contents_range.length < 3
    ) {
      throw validation_error("YAML document has no provable parser range", {
        document: document_index,
      });
    }
    const token_index = document_token_indexes[document_index];
    const document_token = tokens[token_index];
    const document_token_range = token_character_range(
      source,
      document_token,
      "document",
    );
    const document_end_token =
      tokens[token_index + 1] && tokens[token_index + 1].type === "doc-end"
        ? tokens[token_index + 1]
        : null;
    const effective_end_range = document_end_token
      ? token_character_range(source, document_end_token, "document end")
      : document_token_range;
    const start_character = previous_end_character;
    const end_character = effective_end_range.end_character;

    assert_character_range(source, start_character, end_character, "document");
    if (
      document_token.offset !== range[0] ||
      range[1] !== contents_range[2] ||
      range[0] < start_character ||
      range[2] < range[1] ||
      range[2] > end_character
    ) {
      throw validation_error("Document parser and CST ranges disagree", {
        document: document_index,
        document_range: range,
        contents_range,
        cst_offset: document_token.offset,
        start_character,
        end_character,
      });
    }
    if (document_end_token && range[2] !== end_character) {
      throw validation_error("Explicit document end range disagrees with CST", {
        document: document_index,
        document_end_character: range[2],
        cst_end_character: end_character,
      });
    }
    if (!document_end_token && range[2] !== end_character) {
      const trailing_source = source.text.slice(range[2], end_character);
      if (trailing_source !== "\n" && trailing_source !== "\r\n") {
        throw validation_error("Document end range disagrees with CST", {
          document: document_index,
          document_end_character: range[2],
          cst_end_character: end_character,
          trailing_source,
        });
      }
    }

    previous_end_character = end_character;
    return { start_character, end_character };
  });
}

function first_meaningful_token_range(source, tokens, kind) {
  const ignored_types = new Set(["comma", "comment", "newline", "space"]);
  for (let index = 0; index < (tokens || []).length; index += 1) {
    const token = tokens[index];
    if (!ignored_types.has(token.type)) {
      return token_character_range(source, tokens.slice(index), kind);
    }
  }
  return null;
}

function yaml_node_character_range(source, node, kind) {
  if (!node || !Array.isArray(node.range) || node.range.length < 2) {
    throw validation_error(`Cannot prove ${kind} YAML node range`, { kind });
  }
  const start_character = node.range[0];
  const end_character = node.range[1];
  assert_character_range(source, start_character, end_character, kind);
  return { start_character, end_character };
}

function combined_character_range(source, ranges, kind) {
  const proven_ranges = ranges.filter(Boolean);
  if (proven_ranges.length === 0) {
    throw validation_error(`Cannot derive ${kind} range from CST`, { kind });
  }
  const start_character = Math.min(
    ...proven_ranges.map((range) => range.start_character),
  );
  const end_character = Math.max(
    ...proven_ranges.map((range) => range.end_character),
  );
  assert_character_range(source, start_character, end_character, kind);
  return { start_character, end_character };
}

function mapping_pair_character_range(
  source,
  mapping_node,
  pair,
  pair_index,
  collection_item_token,
) {
  const collection_items =
    mapping_node && mapping_node.srcToken && mapping_node.srcToken.items;
  const backing_item_token = Array.isArray(collection_items)
    ? collection_items[pair_index]
    : pair_index === 0
      ? collection_item_token
      : null;
  if (
    !pair ||
    !pair.srcToken ||
    !backing_item_token ||
    backing_item_token !== pair.srcToken
  ) {
    throw validation_error("Mapping pair is not backed by its collection CST", {
      pair_index,
    });
  }
  token_source_ranges(source, pair.srcToken, "mapping pair");

  const structural_ranges = [
    first_meaningful_token_range(
      source,
      pair.srcToken.start,
      "mapping pair start",
    ),
    pair.srcToken.key
      ? token_character_range(source, pair.srcToken.key, "mapping pair key")
      : null,
    Array.isArray(pair.srcToken.sep) && pair.srcToken.sep.length > 0
      ? token_character_range(
          source,
          pair.srcToken.sep,
          "mapping pair separator",
        )
      : null,
    pair.srcToken.value
      ? token_character_range(source, pair.srcToken.value, "mapping pair value")
      : null,
    pair.key
      ? yaml_node_character_range(source, pair.key, "mapping key")
      : null,
    pair.value
      ? yaml_node_character_range(source, pair.value, "mapping value")
      : null,
  ];
  const pair_range = combined_character_range(
    source,
    structural_ranges,
    "mapping pair",
  );
  for (const node of [pair.key, pair.value]) {
    if (
      node &&
      Array.isArray(node.range) &&
      (node.range[0] < pair_range.start_character ||
        node.range[1] > pair_range.end_character)
    ) {
      throw validation_error("Mapping pair does not contain its YAML node", {
        pair_index,
        pair_range: [pair_range.start_character, pair_range.end_character],
        node_range: node.range,
      });
    }
  }
  return pair_range;
}

function sequence_item_character_range(
  source,
  sequence_node,
  item_node,
  sequence_index,
) {
  const collection_items =
    sequence_node && sequence_node.srcToken && sequence_node.srcToken.items;
  const item_token =
    Array.isArray(collection_items) && collection_items[sequence_index];
  if (!item_token) {
    throw validation_error("Sequence item is not backed by collection CST", {
      sequence_index,
    });
  }
  token_source_ranges(source, item_token, "sequence item");

  const item_range = combined_character_range(
    source,
    [
      first_meaningful_token_range(
        source,
        item_token.start,
        "sequence item start",
      ),
      item_token.key
        ? token_character_range(source, item_token.key, "sequence item key")
        : null,
      Array.isArray(item_token.sep) && item_token.sep.length > 0
        ? token_character_range(
            source,
            item_token.sep,
            "sequence item separator",
          )
        : null,
      item_token.value
        ? token_character_range(source, item_token.value, "sequence item value")
        : null,
      item_node
        ? yaml_node_character_range(source, item_node, "sequence item node")
        : null,
    ],
    "sequence item",
  );
  if (
    item_node &&
    Array.isArray(item_node.range) &&
    (item_node.range[0] < item_range.start_character ||
      item_node.range[1] > item_range.end_character)
  ) {
    throw validation_error("Sequence item does not contain its YAML node", {
      sequence_index,
      item_range: [item_range.start_character, item_range.end_character],
      node_range: item_node.range,
    });
  }
  return item_range;
}

function typed_scalar_metadata(node, raw) {
  if (!YAML.isScalar(node)) return {};
  if (node.tag) {
    const scalar_type = STANDARD_SCALAR_TAG_TYPE[node.tag];
    const resolved_type_matches =
      (scalar_type === "string" && typeof node.value === "string") ||
      (scalar_type === "integer" &&
        typeof node.value === "number" &&
        Number.isInteger(node.value)) ||
      (scalar_type === "float" && typeof node.value === "number") ||
      (scalar_type === "boolean" && typeof node.value === "boolean") ||
      (scalar_type === "null" && node.value === null);
    return resolved_type_matches
      ? { scalar_type, scalar_value: node.value }
      : {};
  }
  if (node.value === null) {
    return { scalar_type: "null", scalar_value: null };
  }
  if (typeof node.value === "string") {
    return { scalar_type: "string", scalar_value: node.value };
  }
  if (typeof node.value === "boolean") {
    return { scalar_type: "boolean", scalar_value: node.value };
  }
  if (typeof node.value === "number") {
    const float_syntax =
      node.format === "EXP" ||
      Number.isInteger(node.minFractionDigits) ||
      !Number.isInteger(node.value) ||
      /^(?:[-+]?\.(?:inf|nan))$/i.test(String(raw));
    return {
      scalar_type: float_syntax ? "float" : "integer",
      scalar_value: node.value,
    };
  }
  return {};
}

function encode_locator_v2(entry, source_digest) {
  validate_artifact_version("locator", 2);
  const locator_data = {
    version: 2,
    source_digest,
    document: entry.document,
    path: entry.path,
    addressable_type: entry.addressable_type,
    start_byte: entry.source.start_byte,
    end_byte: entry.source.end_byte,
    target_digest: entry.raw_digest,
  };
  return Buffer.from(canonical_json(locator_data), "utf8").toString(
    "base64url",
  );
}

function build_addressable_index(index, options = {}) {
  if (
    !index ||
    !index.source ||
    !index.parser_result ||
    !index._internal ||
    !(index._internal.node_to_id instanceof WeakMap)
  ) {
    throw validation_error("build_addressable_index requires a node index");
  }
  const source = index.source;
  const source_digest = source.digest;
  const actual_source_digest = sha256_digest(source.buffer);
  if (actual_source_digest !== source_digest) {
    throw validation_error("Source bytes changed after v1 indexing", {
      expected_source_digest: source_digest,
      actual_source_digest,
    });
  }
  const entries = [];
  const by_id = new Map();
  const node_entry_by_id = new Map();
  const document_ranges = document_character_ranges(index);

  function add_entry(addressable_type, context, range, metadata = {}) {
    assert_character_range(
      source,
      range.start_character,
      range.end_character,
      addressable_type,
    );
    const start_byte =
      range.start_byte === undefined
        ? utf16_offset_to_byte(source, range.start_character)
        : range.start_byte;
    const end_byte =
      range.end_byte === undefined
        ? utf16_offset_to_byte(source, range.end_character)
        : range.end_byte;
    if (
      !Number.isInteger(start_byte) ||
      !Number.isInteger(end_byte) ||
      start_byte < 0 ||
      end_byte < start_byte ||
      end_byte > source.buffer.length
    ) {
      throw validation_error(`Cannot prove ${addressable_type} byte range`, {
        start_byte,
        end_byte,
        source_size_bytes: source.buffer.length,
      });
    }

    const parent = context.parent_id ? by_id.get(context.parent_id) : null;
    if (context.parent_id && !parent) {
      throw validation_error("Addressable parent must precede its child", {
        parent_id: context.parent_id,
        addressable_type,
      });
    }
    const raw_buffer = source.buffer.subarray(start_byte, end_byte);
    const line_position = index.parser_result.line_counter.linePos(
      range.start_character,
    );
    const entry = {
      id: entries.length + 1,
      addressable_type,
      document: context.document,
      path: clone_path(context.path),
      relationship: context.relationship,
      parent_id: parent ? parent.id : null,
      parent_path: parent ? clone_path(parent.path) : null,
      sibling_position: parent ? parent.child_ids.length : 0,
      depth: parent ? parent.depth + 1 : 0,
      direct_child_count: 0,
      descendant_count: 0,
      child_ids: [],
      raw: raw_buffer.toString("utf8"),
      raw_digest: sha256_digest(raw_buffer),
      source_digest,
      source_path: source.file_path,
      source: {
        line: line_position.line,
        column: line_position.col,
        start_character: range.start_character,
        end_character: range.end_character,
        start_byte,
        end_byte,
      },
      size_bytes: end_byte - start_byte,
      size_characters: range.end_character - range.start_character,
      ordinal: entries.length,
      ...metadata,
    };
    entries.push(entry);
    by_id.set(entry.id, entry);
    if (parent) parent.child_ids.push(entry.id);
    return entry;
  }

  function add_implicit_null_relationship(
    relationship,
    pair_entry,
    relationship_path,
    insertion_character,
    metadata,
  ) {
    const range = {
      start_character: insertion_character,
      end_character: insertion_character,
    };
    const relationship_entry = add_entry(
      relationship,
      {
        document: pair_entry.document,
        path: relationship_path,
        relationship,
        parent_id: pair_entry.id,
      },
      range,
      metadata,
    );
    add_entry(
      "scalar",
      {
        document: pair_entry.document,
        path: relationship_path,
        relationship,
        parent_id: relationship_entry.id,
      },
      range,
      {
        node_type: "scalar",
        tag: null,
        anchor: null,
        alias: null,
        ...metadata,
        scalar_type: "null",
        scalar_value: null,
      },
    );
  }

  function add_node(v1_entry, parent_id, node_context = {}) {
    if (!v1_entry) return null;
    const node = index._internal.node_by_id.get(v1_entry.id);
    if (!node || node_entry_by_id.has(v1_entry.id)) {
      throw validation_error("YAML node identity is missing or duplicated", {
        node_id: v1_entry.id,
      });
    }
    const range = {
      start_character: v1_entry.source.start_character,
      end_character: v1_entry.source.end_character,
    };
    const raw_buffer = source.buffer.subarray(
      v1_entry.source.start_byte,
      v1_entry.source.end_byte,
    );
    if (sha256_digest(raw_buffer) !== v1_entry.raw_digest) {
      throw validation_error("YAML node bytes changed after v1 indexing", {
        node_id: v1_entry.id,
      });
    }
    const node_entry = add_entry(
      v1_entry.node_type,
      {
        document: v1_entry.document,
        path: v1_entry.path,
        relationship: v1_entry.relationship,
        parent_id,
      },
      range,
      {
        node_type: v1_entry.node_type,
        node_id: v1_entry.id,
        tag: v1_entry.tag,
        anchor: v1_entry.anchor,
        alias: v1_entry.alias,
        mapping_pair_index: v1_entry.mapping_pair_index,
        mapping_key: v1_entry.mapping_key,
        key_raw_digest: v1_entry.key_raw_digest,
        sequence_index: v1_entry.sequence_index,
        ...(YAML.isScalar(node)
          ? typed_scalar_metadata(node, raw_buffer.toString("utf8"))
          : {}),
      },
    );
    node_entry_by_id.set(v1_entry.id, node_entry);

    if (YAML.isMap(node)) {
      node.items.forEach((pair, pair_index) => {
        const key_id = index._internal.node_to_id.get(pair.key);
        const value_id = index._internal.node_to_id.get(pair.value);
        const key_v1_entry = index._internal.entry_by_id.get(key_id);
        const value_v1_entry = index._internal.entry_by_id.get(value_id);
        const key_raw_digest =
          (value_v1_entry && value_v1_entry.key_raw_digest) ??
          (key_v1_entry && key_v1_entry.key_raw_digest) ??
          v1_entry.child_key_digests[pair_index];
        let pair_path;
        if (value_v1_entry) {
          pair_path = clone_path(value_v1_entry.path);
        } else if (key_v1_entry) {
          pair_path = clone_path(key_v1_entry.path);
          const final_step = pair_path[pair_path.length - 1];
          if (final_step && final_step.node === "key") {
            delete final_step.node;
          }
        } else {
          pair_path = clone_path(v1_entry.path).concat({
            mapping_pair_index: pair_index,
            key_raw_digest,
          });
        }
        const pair_range = mapping_pair_character_range(
          source,
          node,
          pair,
          pair_index,
          node_context.collection_item_token,
        );
        const pair_entry = add_entry(
          "mapping_pair",
          {
            document: v1_entry.document,
            path: pair_path,
            relationship: "mapping_pair",
            parent_id: node_entry.id,
          },
          pair_range,
          {
            mapping_pair_index: pair_index,
            mapping_key:
              (value_v1_entry && value_v1_entry.mapping_key) ??
              (key_v1_entry && key_v1_entry.mapping_key),
            key_raw_digest,
          },
        );
        for (const [relationship, child_v1_entry] of [
          ["mapping_key", key_v1_entry],
          ["mapping_value", value_v1_entry],
        ]) {
          if (!child_v1_entry) {
            const relationship_path = clone_path(pair_path);
            if (relationship === "mapping_key") {
              const final_step =
                relationship_path[relationship_path.length - 1];
              if (final_step) final_step.node = "key";
            }
            add_implicit_null_relationship(
              relationship,
              pair_entry,
              relationship_path,
              relationship === "mapping_key"
                ? pair_range.start_character
                : pair_range.end_character,
              {
                mapping_pair_index: pair_index,
                mapping_key: pair_entry.mapping_key,
                key_raw_digest,
              },
            );
            continue;
          }
          const relationship_entry = add_entry(
            relationship,
            {
              document: v1_entry.document,
              path: child_v1_entry.path,
              relationship,
              parent_id: pair_entry.id,
            },
            {
              start_character: child_v1_entry.source.start_character,
              end_character: child_v1_entry.source.end_character,
            },
            {
              mapping_pair_index: pair_index,
              mapping_key: child_v1_entry.mapping_key,
              key_raw_digest: child_v1_entry.key_raw_digest,
            },
          );
          add_node(child_v1_entry, relationship_entry.id);
        }
      });
    } else if (YAML.isSeq(node)) {
      node.items.forEach((item_node, sequence_index) => {
        const child_id = index._internal.node_to_id.get(item_node);
        const child_v1_entry = index._internal.entry_by_id.get(child_id);
        if (!child_v1_entry) {
          throw validation_error("Sequence item has no v1 node identity", {
            node_id: v1_entry.id,
            sequence_index,
          });
        }
        const item_range = sequence_item_character_range(
          source,
          node,
          item_node,
          sequence_index,
        );
        const item_entry = add_entry(
          "sequence_item",
          {
            document: v1_entry.document,
            path: child_v1_entry.path,
            relationship: "sequence_item",
            parent_id: node_entry.id,
          },
          item_range,
          { sequence_index },
        );
        const collection_item_token =
          node.srcToken &&
          Array.isArray(node.srcToken.items) &&
          node.srcToken.items[sequence_index];
        add_node(child_v1_entry, item_entry.id, { collection_item_token });
      });
    }
    return node_entry;
  }

  const stream_entry = add_entry(
    "stream",
    {
      document: null,
      path: [],
      relationship: "stream",
      parent_id: null,
    },
    {
      start_character: 0,
      end_character: source.text.length,
      start_byte: 0,
      end_byte: source.buffer.length,
    },
  );

  index.parser_result.documents.forEach((document, document_index) => {
    const document_entry = add_entry(
      "document",
      {
        document: document_index,
        path: [],
        relationship: "document",
        parent_id: stream_entry.id,
      },
      document_ranges[document_index],
    );
    const root_id = index.document_root_ids[document_index];
    const root_v1_entry = index._internal.entry_by_id.get(root_id);
    if (!root_v1_entry) {
      throw validation_error("Document has no v1 root node", {
        document: document_index,
      });
    }
    add_node(root_v1_entry, document_entry.id);
  });

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    entry.direct_child_count = entry.child_ids.length;
    entry.descendant_count = entry.child_ids.reduce((count, child_id) => {
      const child = by_id.get(child_id);
      return count + child.descendant_count + 1;
    }, 0);
  }
  for (const entry of entries) {
    entry.locator = encode_locator_v2(entry, source_digest);
  }

  if (node_entry_by_id.size !== index.entries.length) {
    throw validation_error("Addressable index omitted a v1 YAML node", {
      v1_node_count: index.entries.length,
      addressable_node_count: node_entry_by_id.size,
    });
  }
  if (options.resolve_alias_target === true) {
    for (const alias_entry of entries_of_type(entries, "alias")) {
      const resolution = resolve_alias_target(index, alias_entry, {
        ...options,
        addressable_index: { entries, by_id, node_entry_by_id },
      });
      alias_entry.alias_target = {
        target_id: resolution.target_entry.id,
        hop_count: resolution.hop_count,
        alias_location: resolution.alias_location,
        target_location: resolution.target_location,
      };
    }
  }

  return { entries, by_id, node_entry_by_id };
}

function entries_of_type(entries, addressable_type) {
  return entries.filter((entry) => entry.addressable_type === addressable_type);
}

function alias_location(entry) {
  return {
    locator: entry.locator,
    document: entry.document,
    path: entry.path,
    source: entry.source,
  };
}

function bounded_alias_option(options, name, default_value) {
  const value = options[name] === undefined ? default_value : options[name];
  if (!Number.isInteger(value) || value < 0) {
    throw validation_error(`${name} must be a non-negative integer`, {
      [name]: value,
    });
  }
  return value;
}

function resolve_alias_target(index, alias_entry, options = {}) {
  const addressable_index =
    options.addressable_index || build_addressable_index(index);
  const resolved_alias_entry =
    typeof alias_entry === "number"
      ? addressable_index.by_id.get(alias_entry)
      : alias_entry;
  if (
    !resolved_alias_entry ||
    resolved_alias_entry.addressable_type !== "alias" ||
    !Number.isInteger(resolved_alias_entry.node_id)
  ) {
    throw validation_error("Alias resolution requires an addressable alias", {
      addressable_id: resolved_alias_entry && resolved_alias_entry.id,
    });
  }
  const max_alias_hop = bounded_alias_option(
    options,
    "max_alias_hop",
    DEFAULT_MAX_ALIAS_HOP,
  );
  const max_alias_visit = bounded_alias_option(
    options,
    "max_alias_visit",
    DEFAULT_MAX_ALIAS_VISIT,
  );
  const visited = new Set();
  let current_entry = resolved_alias_entry;
  let hop_count = 0;

  while (current_entry.addressable_type === "alias") {
    if (hop_count >= max_alias_hop || visited.size >= max_alias_visit) {
      throw new Yaml_patch_error(
        "CHANGE_LIMIT_EXCEEDED",
        "Alias target resolution exceeds its configured limits",
        {
          details: {
            alias: resolved_alias_entry.alias,
            hop_count,
            visited_count: visited.size,
            max_alias_hop,
            max_alias_visit,
          },
        },
      );
    }
    if (visited.has(current_entry.node_id)) {
      throw validation_error("Alias target resolution contains a cycle", {
        alias: resolved_alias_entry.alias,
        node_id: current_entry.node_id,
        hop_count,
      });
    }
    visited.add(current_entry.node_id);

    const alias_node = index._internal.node_by_id.get(current_entry.node_id);
    const document = index.parser_result.documents[current_entry.document];
    let target_node;
    try {
      target_node = alias_node.resolve(document);
    } catch (error) {
      throw new Yaml_patch_error(
        "VALIDATION_FAILED",
        `Alias *${current_entry.alias} could not be resolved`,
        { cause: error, details: { alias: current_entry.alias } },
      );
    }
    const target_node_id = target_node
      ? index._internal.node_to_id.get(target_node)
      : undefined;
    const target_entry = Number.isInteger(target_node_id)
      ? addressable_index.node_entry_by_id.get(target_node_id)
      : null;
    if (!target_entry) {
      throw validation_error(
        `Alias *${current_entry.alias} has no preceding anchor`,
        {
          alias: current_entry.alias,
          alias_locator: current_entry.locator,
        },
      );
    }
    current_entry = target_entry;
    hop_count += 1;
  }

  return {
    alias_entry: resolved_alias_entry,
    target_entry: current_entry,
    alias_location: alias_location(resolved_alias_entry),
    target_location: alias_location(current_entry),
    hop_count,
  };
}

module.exports = {
  DEFAULT_MAX_ALIAS_HOP,
  DEFAULT_MAX_ALIAS_VISIT,
  build_addressable_index,
  encode_locator_v2,
  resolve_alias_target,
  typed_scalar_metadata,
};
