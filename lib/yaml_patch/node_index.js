"use strict";

const YAML = require("yaml");

const { Yaml_patch_error } = require("./error");
const { sha256_digest, utf16_offset_to_byte } = require("./source");

const DEFAULT_MAX_NODE_COUNT = 1_000_000;
const DEFAULT_MAX_DEPTH = 2048;

function get_node_type(node) {
  if (YAML.isMap(node)) return "mapping";
  if (YAML.isSeq(node)) return "sequence";
  if (YAML.isScalar(node)) return "scalar";
  if (YAML.isAlias(node)) return "alias";
  return "unknown";
}

function node_character_range(node) {
  if (!node || !Array.isArray(node.range)) return [0, 0, 0];
  return [node.range[0], node.range[1], node.range[2]];
}

function node_source_buffer(source, node) {
  const [start_character, end_character] = node_character_range(node);
  return source.buffer.subarray(
    utf16_offset_to_byte(source, start_character),
    utf16_offset_to_byte(source, end_character),
  );
}

function node_raw_text(source, node) {
  if (
    YAML.isScalar(node) &&
    node.srcToken &&
    typeof node.srcToken.source === "string"
  ) {
    if (node.srcToken.type === "block-scalar") {
      return node_source_buffer(source, node).toString("utf8");
    }
    return node.srcToken.source;
  }
  if (YAML.isAlias(node) && node.srcToken) return node.srcToken.source || "";
  return undefined;
}

function key_metadata(source, pair, pair_index) {
  const key = pair ? pair.key : null;
  const raw = key ? node_raw_text(source, key) : "";
  const raw_buffer = key ? node_source_buffer(source, key) : Buffer.alloc(0);
  const explicit = Boolean(
    pair &&
    pair.srcToken &&
    Array.isArray(pair.srcToken.start) &&
    pair.srcToken.start.some((token) => token.type === "explicit-key-ind"),
  );
  const shortcut_eligible = Boolean(
    YAML.isScalar(key) &&
    typeof key.value === "string" &&
    !key.tag &&
    !key.anchor &&
    !explicit,
  );

  return {
    pair_index,
    raw,
    raw_digest: sha256_digest(raw_buffer),
    shortcut_eligible,
    string_value: shortcut_eligible ? key.value : undefined,
  };
}

function encode_locator(entry) {
  const locator_data = {
    version: 1,
    document: entry.document,
    path: entry.path,
    ordinal: entry.ordinal,
    raw_digest: entry.raw_digest,
    start_byte: entry.source.start_byte,
    end_byte: entry.source.end_byte,
  };
  return Buffer.from(JSON.stringify(locator_data), "utf8").toString(
    "base64url",
  );
}

function build_node_index(source, parsed, options = {}) {
  const entries = [];
  const entry_by_id = new Map();
  const node_by_id = new Map();
  const node_to_id = new WeakMap();
  let next_id = 1;
  const max_node_count = Number.isInteger(options.max_node_count)
    ? options.max_node_count
    : DEFAULT_MAX_NODE_COUNT;
  const max_depth = Number.isInteger(options.max_depth)
    ? options.max_depth
    : DEFAULT_MAX_DEPTH;

  function visit_node(node, context) {
    if (!node) return null;
    if (entries.length >= max_node_count || context.depth > max_depth) {
      throw new Yaml_patch_error(
        "CHANGE_LIMIT_EXCEEDED",
        "YAML node index exceeds its configured resource limits",
        {
          details: {
            node_count: entries.length,
            depth: context.depth,
            max_node_count,
            max_depth,
          },
          next_action:
            "increase resource limits only after reviewing the source",
        },
      );
    }
    const id = next_id++;
    const node_type = get_node_type(node);
    const [start_character, end_character, node_end_character] =
      node_character_range(node);
    const start_byte = utf16_offset_to_byte(source, start_character);
    const end_byte = utf16_offset_to_byte(source, end_character);
    const node_end_byte = utf16_offset_to_byte(source, node_end_character);
    const line_position = parsed.line_counter.linePos(start_character);
    const raw = node_raw_text(source, node);
    const raw_buffer = node_source_buffer(source, node);
    const entry = {
      id,
      ordinal: entries.length,
      document: context.document,
      node_type,
      path: context.path,
      parent_id: context.parent_id || null,
      relationship: context.relationship || "document_value",
      mapping_pair_index: context.mapping_pair_index,
      mapping_key: context.mapping_key,
      key_raw_digest: context.key_raw_digest,
      sequence_index: context.sequence_index,
      ...(raw === undefined ? {} : { raw }),
      raw_digest: sha256_digest(raw_buffer),
      tag: node.tag || null,
      anchor: node.anchor || null,
      alias: YAML.isAlias(node) ? node.source : null,
      source: {
        line: line_position.line,
        column: line_position.col,
        start_character,
        end_character,
        node_end_character,
        start_byte,
        end_byte,
        node_end_byte,
      },
      size_bytes: end_byte - start_byte,
      size_characters: end_character - start_character,
      child_ids: [],
      child_key_digests: [],
    };

    entries.push(entry);
    entry_by_id.set(id, entry);
    node_by_id.set(id, node);
    node_to_id.set(node, id);

    if (YAML.isMap(node)) {
      const metadata_list = node.items.map((pair, pair_index) =>
        key_metadata(source, pair, pair_index),
      );
      const shortcut_counts = new Map();
      for (const metadata of metadata_list) {
        if (!metadata.shortcut_eligible) continue;
        shortcut_counts.set(
          metadata.string_value,
          (shortcut_counts.get(metadata.string_value) || 0) + 1,
        );
      }
      entry.child_key_digests = metadata_list.map(
        (metadata) => metadata.raw_digest,
      );

      node.items.forEach((pair, pair_index) => {
        const metadata = metadata_list[pair_index];
        const mapping_key =
          metadata.shortcut_eligible &&
          shortcut_counts.get(metadata.string_value) === 1
            ? metadata.string_value
            : undefined;
        const pair_step = {
          mapping_pair_index: pair_index,
          key_raw_digest: metadata.raw_digest,
        };
        const key_id = visit_node(pair.key, {
          document: context.document,
          parent_id: id,
          relationship: "mapping_key",
          mapping_pair_index: pair_index,
          mapping_key,
          key_raw_digest: metadata.raw_digest,
          path: context.path.concat({ ...pair_step, node: "key" }),
          depth: context.depth + 1,
        });
        const value_id = visit_node(pair.value, {
          document: context.document,
          parent_id: id,
          relationship: "mapping_value",
          mapping_pair_index: pair_index,
          mapping_key,
          key_raw_digest: metadata.raw_digest,
          path: context.path.concat(pair_step),
          depth: context.depth + 1,
        });
        if (key_id !== null) entry.child_ids.push(key_id);
        if (value_id !== null) entry.child_ids.push(value_id);
      });
    } else if (YAML.isSeq(node)) {
      node.items.forEach((item, sequence_index) => {
        const child_id = visit_node(item, {
          document: context.document,
          parent_id: id,
          relationship: "sequence_item",
          sequence_index,
          path: context.path.concat({ sequence_index }),
          depth: context.depth + 1,
        });
        if (child_id !== null) entry.child_ids.push(child_id);
      });
    }

    return id;
  }

  const document_root_ids = parsed.documents.map((document, document_index) =>
    visit_node(document.contents, {
      document: document_index,
      path: [],
      relationship: "document_value",
      depth: 0,
    }),
  );

  for (const entry of entries) entry.locator = encode_locator(entry);

  return {
    source,
    parser_result: parsed,
    entries,
    document_root_ids,
    _internal: { entry_by_id, node_by_id, node_to_id },
  };
}

function get_index_entry(index, node) {
  const id = index._internal.node_to_id.get(node);
  return id === undefined ? null : index._internal.entry_by_id.get(id) || null;
}

function get_index_node(index, entry) {
  return index._internal.node_by_id.get(entry.id) || null;
}

module.exports = {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_NODE_COUNT,
  build_node_index,
  encode_locator,
  get_index_entry,
  get_index_node,
  get_node_type,
  key_metadata,
  node_raw_text,
  node_source_buffer,
};
