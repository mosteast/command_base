"use strict";

const YAML = require("yaml");
const { types } = require("node:util");

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

function precondition_error(message, details = {}, cause) {
  return new Yaml_patch_error("PRECONDITION_FAILED", message, {
    cause,
    details,
    next_action: "rebuild the node index from the current parser result",
  });
}

function arrays_equal(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function paths_equal(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((left_step, index) => {
      const right_step = right[index];
      const left_data = path_step_data(left_step);
      const right_data = path_step_data(right_step);
      return (
        left_data &&
        right_data &&
        left_data.keys.length === right_data.keys.length &&
        left_data.keys.every(
          (key) =>
            Object.hasOwn(right_data.descriptors, key) &&
            left_data.descriptors[key].value ===
              right_data.descriptors[key].value,
        )
      );
    })
  );
}

function path_step_data(step) {
  if (
    !step ||
    typeof step !== "object" ||
    Array.isArray(step) ||
    types.isProxy(step)
  ) {
    return null;
  }
  const prototype = Object.getPrototypeOf(step);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(step);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !Object.hasOwn(descriptors[key], "value") ||
        !descriptors[key].enumerable,
    )
  ) {
    return null;
  }
  return { descriptors, keys };
}

function expected_node_records(index) {
  const records = [];
  const node_to_expected_id = new WeakMap();
  const seen_nodes = new WeakSet();
  const stack = [];
  for (
    let document = index.parser_result.documents.length - 1;
    document >= 0;
    document -= 1
  ) {
    stack.push({
      node: index.parser_result.documents[document].contents,
      context: {
        document,
        path: [],
        parent_id: null,
        relationship: "document_value",
      },
    });
  }

  while (stack.length > 0) {
    const { node, context } = stack.pop();
    if (!node) continue;
    if (seen_nodes.has(node)) {
      throw precondition_error(
        "Parser node graph reuses one YAML node identity",
      );
    }
    if (records.length >= index.entries.length + 1) {
      throw precondition_error("Parser node graph exceeds node-index entries");
    }
    seen_nodes.add(node);
    const expected_id = records.length + 1;
    node_to_expected_id.set(node, expected_id);
    const record = {
      node,
      expected_id,
      context,
      child_nodes: [],
      child_key_digests: [],
    };
    records.push(record);

    const children = [];
    if (YAML.isMap(node)) {
      const metadata_list = node.items.map((pair, pair_index) =>
        key_metadata(index.source, pair, pair_index),
      );
      const shortcut_counts = new Map();
      for (const metadata of metadata_list) {
        if (metadata.shortcut_eligible) {
          shortcut_counts.set(
            metadata.string_value,
            (shortcut_counts.get(metadata.string_value) || 0) + 1,
          );
        }
      }
      record.child_key_digests = metadata_list.map(
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
        for (const [child, relationship, path] of [
          [
            pair.key,
            "mapping_key",
            context.path.concat({ ...pair_step, node: "key" }),
          ],
          [pair.value, "mapping_value", context.path.concat(pair_step)],
        ]) {
          if (!child) continue;
          record.child_nodes.push(child);
          children.push({
            node: child,
            context: {
              document: context.document,
              path,
              parent_id: expected_id,
              relationship,
              mapping_pair_index: pair_index,
              mapping_key,
              key_raw_digest: metadata.raw_digest,
            },
          });
        }
      });
    } else if (YAML.isSeq(node)) {
      node.items.forEach((child, sequence_index) => {
        if (!child) return;
        record.child_nodes.push(child);
        children.push({
          node: child,
          context: {
            document: context.document,
            path: context.path.concat({ sequence_index }),
            parent_id: expected_id,
            relationship: "sequence_item",
            sequence_index,
          },
        });
      });
    }
    for (
      let child_index = children.length - 1;
      child_index >= 0;
      child_index -= 1
    ) {
      stack.push(children[child_index]);
    }
  }
  return { node_to_expected_id, records };
}

function validate_node_index_integrity(index) {
  if (
    !index ||
    !index.source ||
    !index.parser_result ||
    !Array.isArray(index.entries) ||
    !Array.isArray(index.document_root_ids) ||
    !index._internal ||
    !(index._internal.entry_by_id instanceof Map) ||
    !(index._internal.node_by_id instanceof Map) ||
    !(index._internal.node_to_id instanceof WeakMap)
  ) {
    throw precondition_error("Node index containers are incomplete");
  }
  if (sha256_digest(index.source.buffer) !== index.source.digest) {
    throw new Yaml_patch_error(
      "VALIDATION_FAILED",
      "Source bytes changed after node indexing",
    );
  }
  let expected;
  try {
    expected = expected_node_records(index);
  } catch (error) {
    if (error instanceof Yaml_patch_error) throw error;
    throw precondition_error(
      "Cannot reconstruct parser node provenance",
      {},
      error,
    );
  }
  if (
    expected.records.length !== index.entries.length ||
    index._internal.entry_by_id.size !== index.entries.length ||
    index._internal.node_by_id.size !== index.entries.length
  ) {
    throw precondition_error("Node index cardinality is inconsistent");
  }

  for (let ordinal = 0; ordinal < expected.records.length; ordinal += 1) {
    const record = expected.records[ordinal];
    const entry = index.entries[ordinal];
    const node = record.node;
    const context = record.context;
    const [start_character, end_character, node_end_character] =
      node_character_range(node);
    let start_byte;
    let end_byte;
    let node_end_byte;
    try {
      start_byte = utf16_offset_to_byte(index.source, start_character);
      end_byte = utf16_offset_to_byte(index.source, end_character);
      node_end_byte = utf16_offset_to_byte(index.source, node_end_character);
    } catch (error) {
      throw precondition_error(
        "Parser node range is inconsistent with source bytes",
        { expected_id: record.expected_id },
        error,
      );
    }
    const line_position =
      index.parser_result.line_counter.linePos(start_character);
    const raw = node_raw_text(index.source, node);
    const raw_buffer = index.source.buffer.subarray(start_byte, end_byte);
    const child_ids = record.child_nodes.map((child) =>
      expected.node_to_expected_id.get(child),
    );
    const expected_source = {
      line: line_position.line,
      column: line_position.col,
      start_character,
      end_character,
      node_end_character,
      start_byte,
      end_byte,
      node_end_byte,
    };
    const source_matches =
      entry &&
      entry.source &&
      Object.keys(expected_source).every(
        (field) => entry.source[field] === expected_source[field],
      );
    const expected_raw_digest = sha256_digest(raw_buffer);
    const locator = encode_locator({
      document: context.document,
      path: context.path,
      ordinal,
      raw_digest: expected_raw_digest,
      source: expected_source,
    });
    if (
      !entry ||
      entry.id !== record.expected_id ||
      entry.ordinal !== ordinal ||
      entry.document !== context.document ||
      entry.node_type !== get_node_type(node) ||
      !paths_equal(entry.path, context.path) ||
      entry.parent_id !== context.parent_id ||
      entry.relationship !== context.relationship ||
      entry.mapping_pair_index !== context.mapping_pair_index ||
      entry.mapping_key !== context.mapping_key ||
      entry.key_raw_digest !== context.key_raw_digest ||
      entry.sequence_index !== context.sequence_index ||
      entry.raw !== raw ||
      entry.raw_digest !== expected_raw_digest ||
      entry.tag !== (node.tag || null) ||
      entry.anchor !== (node.anchor || null) ||
      entry.alias !== (YAML.isAlias(node) ? node.source : null) ||
      !source_matches ||
      entry.size_bytes !== end_byte - start_byte ||
      entry.size_characters !== end_character - start_character ||
      !arrays_equal(entry.child_ids, child_ids) ||
      !arrays_equal(entry.child_key_digests, record.child_key_digests) ||
      entry.locator !== locator ||
      index._internal.entry_by_id.get(entry.id) !== entry ||
      index._internal.node_by_id.get(entry.id) !== node ||
      index._internal.node_to_id.get(node) !== entry.id
    ) {
      throw precondition_error("Node entry provenance is inconsistent", {
        ordinal,
        entry_id: entry && entry.id,
      });
    }
  }
  const expected_root_ids = index.parser_result.documents.map((document) =>
    expected.node_to_expected_id.get(document.contents),
  );
  if (!arrays_equal(index.document_root_ids, expected_root_ids)) {
    throw precondition_error("Document root provenance is inconsistent");
  }
  return index;
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
  validate_node_index_integrity,
};

for (const export_name of [
  "build_addressable_index",
  "encode_locator_v2",
  "resolve_alias_target",
  "typed_scalar_metadata",
]) {
  Object.defineProperty(module.exports, export_name, {
    enumerable: true,
    get() {
      return require("./addressable")[export_name];
    },
  });
}
