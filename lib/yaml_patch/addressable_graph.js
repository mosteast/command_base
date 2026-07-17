"use strict";

const YAML = require("yaml");

const {
  assert_character_range,
  create_addressable_range_context,
} = require("./addressable_range");
const { Yaml_patch_error } = require("./error");
const { encode_locator_v2 } = require("./locator_v2");
const { validate_node_index_integrity } = require("./node_index");
const { typed_scalar_metadata } = require("./scalar_metadata");
const { sha256_digest, utf16_offset_to_byte } = require("./source");

const DEFAULT_MAX_ADDRESSABLE_COUNT = 1_000_000;
const DEFAULT_MAX_TOTAL_PATH_STEPS = 1_000_000;
const DEFAULT_MAX_LOCATOR_BYTES = 128 * 1024 * 1024;
const addressable_provenance = new WeakMap();

function precondition_error(message, details = {}) {
  return new Yaml_patch_error("PRECONDITION_FAILED", message, {
    details,
    next_action: "rebuild the node and addressable indexes from one source",
  });
}

function validation_error(message, details = {}) {
  return new Yaml_patch_error("VALIDATION_FAILED", message, {
    details,
    next_action: "reparse the unchanged source with the supported YAML parser",
  });
}

function change_limit_error(limit_name, limit, actual) {
  return new Yaml_patch_error(
    "CHANGE_LIMIT_EXCEEDED",
    `YAML addressable metadata exceeds ${limit_name}`,
    {
      details: { limit_name, limit, actual },
      next_action: "increase the limit only after reviewing the source",
    },
  );
}

function bounded_limit(options, name, default_value) {
  const value = options[name] === undefined ? default_value : options[name];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw validation_error(`${name} must be a non-negative safe integer`, {
      [name]: value,
    });
  }
  return value;
}

function clone_path(path) {
  return Array.isArray(path) ? path.map((step) => ({ ...step })) : [];
}

function paths_equal(left, right) {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    left.length !== right.length
  ) {
    return false;
  }
  return left.every((left_step, index) => {
    const right_step = right[index];
    const left_keys = Object.keys(left_step);
    const right_keys = right_step && Object.keys(right_step);
    return (
      right_keys &&
      left_keys.length === right_keys.length &&
      left_keys.every(
        (key) =>
          Object.hasOwn(right_step, key) && left_step[key] === right_step[key],
      )
    );
  });
}

function validate_addressable_index_binding(index, addressable_index) {
  validate_node_index_integrity(index);
  const provenance =
    addressable_index && addressable_provenance.get(addressable_index);
  if (
    !addressable_index ||
    !provenance ||
    provenance.index !== index ||
    provenance.entries !== addressable_index.entries ||
    provenance.by_id !== addressable_index.by_id ||
    provenance.node_entry_by_id !== addressable_index.node_entry_by_id ||
    !Array.isArray(addressable_index.entries) ||
    !(addressable_index.by_id instanceof Map) ||
    !(addressable_index.node_entry_by_id instanceof Map) ||
    addressable_index.by_id.size !== addressable_index.entries.length
  ) {
    throw precondition_error("Addressable-index containers are inconsistent");
  }
  addressable_index.entries.forEach((entry, ordinal) => {
    const raw_buffer =
      entry && entry.source
        ? index.source.buffer.subarray(
            entry.source.start_byte,
            entry.source.end_byte,
          )
        : null;
    const line_position =
      entry && entry.source
        ? index.parser_result.line_counter.linePos(entry.source.start_character)
        : null;
    if (
      !entry ||
      provenance.canonical_entries[ordinal] !== entry ||
      entry.ordinal !== ordinal ||
      addressable_index.by_id.get(entry.id) !== entry ||
      entry.source_digest !== index.source.digest ||
      !entry.source ||
      !Number.isInteger(entry.source.start_byte) ||
      !Number.isInteger(entry.source.end_byte) ||
      entry.source.start_byte < 0 ||
      entry.source.end_byte < entry.source.start_byte ||
      entry.source.end_byte > index.source.buffer.length ||
      entry.source.line !== line_position.line ||
      entry.source.column !== line_position.col ||
      entry.raw !== raw_buffer.toString("utf8") ||
      entry.raw_digest !== sha256_digest(raw_buffer) ||
      typeof entry.locator !== "string" ||
      entry.locator !== encode_locator_v2(entry, index.source.digest)
    ) {
      throw precondition_error("Addressable entry identity is inconsistent", {
        ordinal,
        addressable_id: entry && entry.id,
      });
    }
  });
  if (addressable_index.node_entry_by_id.size !== index.entries.length) {
    throw precondition_error("Addressable node map and v1 entries disagree");
  }
  for (const v1_entry of index.entries) {
    const entry = addressable_index.node_entry_by_id.get(v1_entry.id);
    if (
      !entry ||
      entry.node_id !== v1_entry.id ||
      addressable_index.by_id.get(entry.id) !== entry
    ) {
      throw precondition_error(
        "Addressable YAML node identity is inconsistent",
        {
          node_id: v1_entry.id,
        },
      );
    }
  }
  const stream_entries = addressable_index.entries.filter(
    (entry) => entry.addressable_type === "stream",
  );
  const document_entries = addressable_index.entries.filter(
    (entry) => entry.addressable_type === "document",
  );
  if (
    stream_entries.length !== 1 ||
    document_entries.length !== index.parser_result.documents.length
  ) {
    throw precondition_error("Addressable stream and documents disagree");
  }
  for (const document_entry of document_entries) {
    const root_v1_id = index.document_root_ids[document_entry.document];
    const root_entry = addressable_index.node_entry_by_id.get(root_v1_id);
    if (
      document_entry.parent_id !== stream_entries[0].id ||
      !root_entry ||
      root_entry.parent_id !== document_entry.id
    ) {
      throw precondition_error("Addressable document root is inconsistent", {
        document: document_entry.document,
      });
    }
  }
  return addressable_index;
}

function validate_addressable_entry_binding(index, addressable_index, entry) {
  validate_addressable_index_binding(index, addressable_index);
  if (!entry || addressable_index.by_id.get(entry.id) !== entry) {
    throw precondition_error(
      "Addressable entry does not belong to this index",
      {
        addressable_id: entry && entry.id,
      },
    );
  }
  if (entry.source_digest !== index.source.digest) {
    throw new Yaml_patch_error(
      "SOURCE_CHANGED",
      "Addressable entry belongs to a different source snapshot",
    );
  }
  const v1_entry = Number.isInteger(entry.node_id)
    ? index._internal.entry_by_id.get(entry.node_id)
    : null;
  if (
    !v1_entry ||
    entry.document !== v1_entry.document ||
    entry.source.start_byte !== v1_entry.source.start_byte ||
    entry.source.end_byte !== v1_entry.source.end_byte ||
    !paths_equal(entry.path, v1_entry.path)
  ) {
    throw precondition_error(
      "Addressable YAML node location disagrees with its v1 entry",
      { addressable_id: entry.id, node_id: entry.node_id },
    );
  }
  if (encode_locator_v2(entry, index.source.digest) !== entry.locator) {
    throw precondition_error("Addressable entry locator is inconsistent", {
      addressable_id: entry.id,
    });
  }
  return entry;
}

function build_addressable_graph(index, options = {}) {
  validate_node_index_integrity(index);
  const max_addressable_count = bounded_limit(
    options,
    "max_addressable_count",
    DEFAULT_MAX_ADDRESSABLE_COUNT,
  );
  const max_total_path_steps = bounded_limit(
    options,
    "max_total_path_steps",
    DEFAULT_MAX_TOTAL_PATH_STEPS,
  );
  const max_locator_bytes = bounded_limit(
    options,
    "max_locator_bytes",
    DEFAULT_MAX_LOCATOR_BYTES,
  );
  const source = index.source;
  const source_digest = source.digest;
  const entries = [];
  const by_id = new Map();
  const node_entry_by_id = new Map();
  const range_context = create_addressable_range_context(index);
  let total_path_steps = 0;

  function add_entry(addressable_type, context, range, metadata = {}) {
    if (entries.length >= max_addressable_count) {
      throw change_limit_error(
        "max_addressable_count",
        max_addressable_count,
        entries.length + 1,
      );
    }
    const path_step_count = Array.isArray(context.path)
      ? context.path.length
      : 0;
    if (total_path_steps + path_step_count > max_total_path_steps) {
      throw change_limit_error(
        "max_total_path_steps",
        max_total_path_steps,
        total_path_steps + path_step_count,
      );
    }
    total_path_steps += path_step_count;
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
          if (final_step && final_step.node === "key") delete final_step.node;
        } else {
          pair_path = clone_path(v1_entry.path).concat({
            mapping_pair_index: pair_index,
            key_raw_digest,
          });
        }
        const pair_range = range_context.mapping_pair_character_range(
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
        const item_range = range_context.sequence_item_character_range(
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
  index.parser_result.documents.forEach((_document, document_index) => {
    const document_entry = add_entry(
      "document",
      {
        document: document_index,
        path: [],
        relationship: "document",
        parent_id: stream_entry.id,
      },
      range_context.document_ranges[document_index],
    );
    const root_id = index.document_root_ids[document_index];
    add_node(index._internal.entry_by_id.get(root_id), document_entry.id);
  });

  for (
    let entry_index = entries.length - 1;
    entry_index >= 0;
    entry_index -= 1
  ) {
    const entry = entries[entry_index];
    entry.direct_child_count = entry.child_ids.length;
    entry.descendant_count = entry.child_ids.reduce((count, child_id) => {
      const child = by_id.get(child_id);
      return count + child.descendant_count + 1;
    }, 0);
  }
  let locator_bytes = 0;
  for (const entry of entries) {
    const locator = encode_locator_v2(entry, source_digest);
    const next_locator_bytes =
      locator_bytes + Buffer.byteLength(locator, "utf8");
    if (next_locator_bytes > max_locator_bytes) {
      throw change_limit_error(
        "max_locator_bytes",
        max_locator_bytes,
        next_locator_bytes,
      );
    }
    locator_bytes = next_locator_bytes;
    entry.locator = locator;
  }
  if (node_entry_by_id.size !== index.entries.length) {
    throw precondition_error("Addressable index omitted a v1 YAML node");
  }
  const addressable_index = { entries, by_id, node_entry_by_id };
  addressable_provenance.set(addressable_index, {
    index,
    entries,
    by_id,
    node_entry_by_id,
    canonical_entries: entries.slice(),
  });
  if (options.resolve_alias_target !== true) {
    finalize_addressable_index(addressable_index);
  }
  return addressable_index;
}

function freeze_path(path) {
  for (const step of path || []) Object.freeze(step);
  return Object.freeze(path);
}

function finalize_addressable_index(addressable_index) {
  for (const entry of addressable_index.entries) {
    freeze_path(entry.path);
    if (entry.parent_path) freeze_path(entry.parent_path);
    Object.freeze(entry.source);
    Object.freeze(entry.child_ids);
    if (entry.alias_target) {
      freeze_path(entry.alias_target.alias_location.path);
      freeze_path(entry.alias_target.target_location.path);
      Object.freeze(entry.alias_target.alias_location.source);
      Object.freeze(entry.alias_target.target_location.source);
      Object.freeze(entry.alias_target.alias_location);
      Object.freeze(entry.alias_target.target_location);
      Object.freeze(entry.alias_target);
    }
    Object.freeze(entry);
  }
  Object.freeze(addressable_index.entries);
  return addressable_index;
}

module.exports = {
  DEFAULT_MAX_ADDRESSABLE_COUNT,
  DEFAULT_MAX_LOCATOR_BYTES,
  DEFAULT_MAX_TOTAL_PATH_STEPS,
  build_addressable_graph,
  finalize_addressable_index,
  validate_addressable_entry_binding,
  validate_addressable_index_binding,
  validate_node_index_integrity,
};
