"use strict";

const YAML = require("yaml");

const { Yaml_patch_error } = require("./error");

function validation_error(message, details = {}) {
  return new Yaml_patch_error("VALIDATION_FAILED", message, {
    details,
    next_action: "reparse the unchanged source with the supported YAML parser",
  });
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

function create_token_range_verifier(source) {
  const range_cache = new WeakMap();
  const visiting = new WeakSet();
  const stats = {
    token_scan_count: 0,
    token_cache_hit_count: 0,
  };

  function token_character_range(token, kind) {
    if (!token || typeof token !== "object") return null;
    if (range_cache.has(token)) {
      stats.token_cache_hit_count += 1;
      return range_cache.get(token);
    }
    if (visiting.has(token)) {
      throw validation_error(`Cannot prove cyclic ${kind} CST tokens`, {
        kind,
      });
    }
    visiting.add(token);
    stats.token_scan_count += 1;

    let start_character = Number.POSITIVE_INFINITY;
    let end_character = Number.NEGATIVE_INFINITY;
    function include(range) {
      if (!range) return;
      if (range.start_character < start_character) {
        start_character = range.start_character;
      }
      if (range.end_character > end_character) {
        end_character = range.end_character;
      }
    }

    try {
      if (
        token.type === "block-scalar" &&
        Number.isInteger(token.offset) &&
        typeof token.source === "string"
      ) {
        const property_range = token_character_range(token.props, kind);
        if (!property_range) {
          throw validation_error(`Cannot prove ${kind} block scalar header`, {
            kind,
            start_character: token.offset,
          });
        }
        const content_start_character = property_range.end_character;
        const content_end_character =
          content_start_character + token.source.length;
        assert_character_range(
          source,
          token.offset,
          content_end_character,
          kind,
        );
        const actual_source = source.text.slice(
          content_start_character,
          content_end_character,
        );
        if (actual_source !== token.source) {
          throw validation_error(
            `Cannot match ${kind} block scalar content to source`,
            {
              kind,
              start_character: content_start_character,
              expected_source: token.source,
              actual_source,
            },
          );
        }
        include({
          start_character: token.offset,
          end_character: content_end_character,
        });
        include(property_range);
        include(token_character_range(token.end, kind));
      } else {
        if (
          Number.isInteger(token.offset) &&
          typeof token.source === "string"
        ) {
          const token_end_character = token.offset + token.source.length;
          assert_character_range(
            source,
            token.offset,
            token_end_character,
            kind,
          );
          const actual_source = source.text.slice(
            token.offset,
            token_end_character,
          );
          if (actual_source !== token.source) {
            throw validation_error(`Cannot match ${kind} CST token to source`, {
              kind,
              token_type: token.type,
              start_character: token.offset,
              expected_source: token.source,
              actual_source,
            });
          }
          include({
            start_character: token.offset,
            end_character: token_end_character,
          });
        }
        for (const [property, child] of Object.entries(token)) {
          if (property !== "source") {
            include(token_character_range(child, kind));
          }
        }
      }
      if (
        start_character === Number.POSITIVE_INFINITY &&
        Number.isInteger(token.offset)
      ) {
        start_character = token.offset;
        end_character = token.offset;
      }
      const range =
        start_character === Number.POSITIVE_INFINITY
          ? null
          : { start_character, end_character };
      range_cache.set(token, range);
      return range;
    } finally {
      visiting.delete(token);
    }
  }

  return { stats, token_character_range };
}

function combined_character_range(source, ranges, kind) {
  let start_character = Number.POSITIVE_INFINITY;
  let end_character = Number.NEGATIVE_INFINITY;
  for (const range of ranges) {
    if (!range) continue;
    if (range.start_character < start_character) {
      start_character = range.start_character;
    }
    if (range.end_character > end_character) {
      end_character = range.end_character;
    }
  }
  if (start_character === Number.POSITIVE_INFINITY) {
    throw validation_error(`Cannot derive ${kind} range from CST`, { kind });
  }
  assert_character_range(source, start_character, end_character, kind);
  return { start_character, end_character };
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

function create_addressable_range_context(index) {
  const { source, parser_result } = index;
  const verifier = create_token_range_verifier(source);
  const { token_character_range } = verifier;

  function first_meaningful_token_range(tokens, kind) {
    const ignored_types = new Set(["comma", "comment", "newline", "space"]);
    for (let index = 0; index < (tokens || []).length; index += 1) {
      if (!ignored_types.has(tokens[index].type)) {
        return token_character_range(tokens.slice(index), kind);
      }
    }
    return null;
  }

  function document_character_ranges() {
    if (parser_result.errors.length > 0) {
      throw validation_error(
        "Cannot build an addressable index for invalid YAML",
        { errors: parser_result.errors },
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

    let cursor = 0;
    for (const token of tokens) {
      const range = token_character_range(token, "document stream");
      if (!range || range.start_character !== cursor) {
        throw validation_error(
          "YAML CST tokens do not cover the source stream",
          {
            expected_character: cursor,
            actual_character: range && range.start_character,
            token_type: token.type,
          },
        );
      }
      cursor = range.end_character;
    }
    if (cursor !== source.text.length) {
      throw validation_error("YAML CST tokens do not reach the source end", {
        token_end_character: cursor,
        source_size_characters: source.text.length,
      });
    }

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
        document_token,
        "document",
      );
      const document_end_token =
        tokens[token_index + 1] && tokens[token_index + 1].type === "doc-end"
          ? tokens[token_index + 1]
          : null;
      const effective_end_range = document_end_token
        ? token_character_range(document_end_token, "document end")
        : document_token_range;
      const start_character = previous_end_character;
      const end_character = effective_end_range.end_character;
      assert_character_range(
        source,
        start_character,
        end_character,
        "document",
      );
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
        throw validation_error(
          "Explicit document end range disagrees with CST",
          {
            document: document_index,
            document_end_character: range[2],
            cst_end_character: end_character,
          },
        );
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

  function mapping_pair_character_range(
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
      throw validation_error(
        "Mapping pair is not backed by its collection CST",
        { pair_index },
      );
    }
    token_character_range(pair.srcToken, "mapping pair");
    const pair_range = combined_character_range(
      source,
      [
        first_meaningful_token_range(pair.srcToken.start, "mapping pair start"),
        pair.srcToken.key
          ? token_character_range(pair.srcToken.key, "mapping pair key")
          : null,
        Array.isArray(pair.srcToken.sep) && pair.srcToken.sep.length > 0
          ? token_character_range(pair.srcToken.sep, "mapping pair separator")
          : null,
        pair.srcToken.value
          ? token_character_range(pair.srcToken.value, "mapping pair value")
          : null,
        pair.key
          ? yaml_node_character_range(source, pair.key, "mapping key")
          : null,
        pair.value
          ? yaml_node_character_range(source, pair.value, "mapping value")
          : null,
      ],
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
    token_character_range(item_token, "sequence item");
    const item_range = combined_character_range(
      source,
      [
        first_meaningful_token_range(item_token.start, "sequence item start"),
        item_token.key
          ? token_character_range(item_token.key, "sequence item key")
          : null,
        Array.isArray(item_token.sep) && item_token.sep.length > 0
          ? token_character_range(item_token.sep, "sequence item separator")
          : null,
        item_token.value
          ? token_character_range(item_token.value, "sequence item value")
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

  return {
    document_ranges: document_character_ranges(),
    mapping_pair_character_range,
    sequence_item_character_range,
    stats: verifier.stats,
  };
}

module.exports = {
  assert_character_range,
  create_addressable_range_context,
};
