"use strict";

const { Yaml_patch_error } = require("./error");

const SAFE_FLAGS_PATTERN = /^(?:i?u?|u?i?)$/;
const SAFE_SIMPLE_ESCAPES = new Set([
  "0",
  "d",
  "D",
  "f",
  "n",
  "r",
  "s",
  "S",
  "t",
  "v",
  "w",
  "W",
]);
const SAFE_ESCAPED_LITERALS = new Set(
  Array.from("^$.*+?()[]{}|/\\-").map((character) => character),
);

function request_error(message, details = {}) {
  throw new Yaml_patch_error("REQUEST_ERROR", message, { details });
}

function safe_escape_end(pattern, offset) {
  const escaped = pattern[offset + 1];
  if (escaped === undefined) {
    request_error("raw_regex pattern ends with an incomplete escape");
  }
  if (/^[1-9]$/.test(escaped)) {
    request_error("raw_regex backreferences are not supported");
  }
  if (SAFE_SIMPLE_ESCAPES.has(escaped) || SAFE_ESCAPED_LITERALS.has(escaped)) {
    return offset + 2;
  }
  const hex_length = escaped === "x" ? 2 : escaped === "u" ? 4 : 0;
  if (hex_length > 0) {
    const end = offset + 2 + hex_length;
    if (
      !new RegExp(`^[a-fA-F0-9]{${hex_length}}$`).test(
        pattern.slice(offset + 2, end),
      )
    ) {
      request_error("raw_regex hexadecimal escape is invalid");
    }
    return end;
  }
  request_error("raw_regex escape is not supported", { escaped });
}

function safe_character_class_end(pattern, offset) {
  let index = offset + 1;
  if (pattern[index] === "^") index += 1;
  let item_count = 0;
  while (index < pattern.length && pattern[index] !== "]") {
    if (pattern[index] === "[") {
      request_error("raw_regex nested character classes are not supported");
    }
    if (pattern[index] === "\\") {
      index = safe_escape_end(pattern, index);
    } else {
      index += 1;
    }
    item_count += 1;
  }
  if (index >= pattern.length || item_count === 0) {
    request_error("raw_regex character class is invalid");
  }
  return index + 1;
}

function validate_safe_regex(pattern, flags) {
  if (typeof pattern !== "string" || typeof flags !== "string") {
    request_error("raw_regex pattern and flags must be strings");
  }
  if (!SAFE_FLAGS_PATTERN.test(flags) || new Set(flags).size !== flags.length) {
    request_error("raw_regex flags may contain i and u once each");
  }

  let index = 0;
  let can_quantify = false;
  let quantifier_count = 0;
  while (index < pattern.length) {
    const character = pattern[index];
    if (character === "^") {
      if (index !== 0) request_error("raw_regex ^ anchor must be first");
      can_quantify = false;
      index += 1;
      continue;
    }
    if (character === "$") {
      if (index !== pattern.length - 1) {
        request_error("raw_regex $ anchor must be last");
      }
      can_quantify = false;
      index += 1;
      continue;
    }
    if (["(", ")", "|", "{", "}"].includes(character)) {
      request_error(
        "raw_regex groups, alternation, and braces are not supported",
      );
    }
    if (character === "]") {
      request_error("raw_regex has an unmatched character class terminator");
    }
    if (["*", "+", "?"].includes(character)) {
      if (!can_quantify) request_error("raw_regex quantifier has no safe atom");
      quantifier_count += 1;
      if (quantifier_count > 1) {
        request_error("raw_regex supports at most one quantifier");
      }
      can_quantify = false;
      index += 1;
      continue;
    }
    if (character === "\\") {
      index = safe_escape_end(pattern, index);
      can_quantify = true;
      continue;
    }
    if (character === "[") {
      index = safe_character_class_end(pattern, index);
      can_quantify = true;
      continue;
    }
    index += 1;
    can_quantify = true;
  }

  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    request_error("raw_regex pattern is invalid", { reason: error.message });
  }
}

module.exports = { validate_safe_regex };
