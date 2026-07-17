"use strict";

const { canonical_json } = require("./artifact_version");
const { Yaml_patch_error } = require("./error");
const { sha256_digest } = require("./source");

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_CURSOR_BYTES = 16 * 1024;
const DEFAULT_MAX_CURSOR_CHARACTERS = Math.ceil(
  (DEFAULT_MAX_CURSOR_BYTES * 4) / 3,
);

function cursor_error(message, details = {}) {
  return new Yaml_patch_error("REQUEST_ERROR", message, { details });
}

function cursor_payload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw cursor_error("Query cursor payload must be an object");
  }
  for (const field of Object.keys(input)) {
    if (
      !["purpose", "input_digest", "query_digest", "offset"].includes(field)
    ) {
      throw cursor_error(`Unknown query cursor field: ${field}`, { field });
    }
  }
  const purpose = input.purpose === undefined ? "page" : input.purpose;
  if (!["page", "candidate"].includes(purpose)) {
    throw cursor_error("Query cursor purpose must be page or candidate");
  }
  if (!SHA256_PATTERN.test(input.input_digest || "")) {
    throw cursor_error("Query cursor input_digest must be a SHA-256 digest");
  }
  if (!SHA256_PATTERN.test(input.query_digest || "")) {
    throw cursor_error("Query cursor query_digest must be a SHA-256 digest");
  }
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
    throw cursor_error("Query cursor offset must be a non-negative integer");
  }
  return {
    version: 1,
    purpose,
    input_digest: input.input_digest,
    query_digest: input.query_digest,
    offset: input.offset,
  };
}

function decoded_cursor_size(encoded_character_count) {
  return Math.floor((encoded_character_count * 3) / 4);
}

function assert_cursor_character_size(character_count) {
  if (character_count > DEFAULT_MAX_CURSOR_CHARACTERS) {
    throw cursor_error("Query cursor exceeds its encoded size limit", {
      limit_name: "max_cursor_characters",
      limit: DEFAULT_MAX_CURSOR_CHARACTERS,
      actual: character_count,
    });
  }
}

function assert_cursor_byte_size(byte_count) {
  if (byte_count > DEFAULT_MAX_CURSOR_BYTES) {
    throw cursor_error("Query cursor exceeds its decoded size limit", {
      limit_name: "max_cursor_bytes",
      limit: DEFAULT_MAX_CURSOR_BYTES,
      actual: byte_count,
    });
  }
}

function create_query_cursor(input) {
  const payload = cursor_payload(input);
  const payload_text = canonical_json(payload);
  assert_cursor_byte_size(Buffer.byteLength(payload_text, "utf8"));
  const checksum = sha256_digest(payload_text);
  const cursor_text = canonical_json({ ...payload, checksum });
  const cursor_bytes = Buffer.byteLength(cursor_text, "utf8");
  assert_cursor_byte_size(cursor_bytes);
  assert_cursor_character_size(Math.ceil((cursor_bytes * 4) / 3));
  return Buffer.from(cursor_text, "utf8").toString("base64url");
}

function decode_query_cursor(cursor) {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw cursor_error("Query cursor must be a non-empty string");
  }
  assert_cursor_character_size(cursor.length);
  assert_cursor_byte_size(decoded_cursor_size(cursor.length));
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw cursor_error("Query cursor must be a non-empty string");
  }
  let decoded;
  let decoded_text;
  try {
    const decoded_buffer = Buffer.from(cursor, "base64url");
    assert_cursor_byte_size(decoded_buffer.length);
    if (decoded_buffer.toString("base64url") !== cursor) {
      throw new Error("non-canonical base64url");
    }
    decoded_text = decoded_buffer.toString("utf8");
    decoded = JSON.parse(decoded_text);
  } catch {
    throw cursor_error("Query cursor is not valid base64url JSON");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw cursor_error("Query cursor document must be an object");
  }
  const fields = Object.keys(decoded);
  if (
    fields.length !== 6 ||
    !fields.every((field) =>
      [
        "version",
        "purpose",
        "input_digest",
        "query_digest",
        "offset",
        "checksum",
      ].includes(field),
    )
  ) {
    throw cursor_error("Query cursor has an invalid shape");
  }
  if (canonical_json(decoded) !== decoded_text) {
    throw cursor_error("Query cursor JSON is not canonical");
  }
  const payload = cursor_payload({
    purpose: decoded.purpose,
    input_digest: decoded.input_digest,
    query_digest: decoded.query_digest,
    offset: decoded.offset,
  });
  const expected_checksum = sha256_digest(
    Buffer.from(
      canonical_json({ ...payload, version: decoded.version }),
      "utf8",
    ),
  );
  if (
    !SHA256_PATTERN.test(decoded.checksum || "") ||
    decoded.checksum !== expected_checksum
  ) {
    throw cursor_error("Query cursor checksum is invalid");
  }
  if (decoded.version !== 1) {
    throw new Yaml_patch_error(
      "PROTOCOL_VERSION_UNSUPPORTED",
      `Unsupported query cursor version: ${decoded.version}`,
      { details: { kind: "query_cursor", version: decoded.version } },
    );
  }
  return payload;
}

module.exports = {
  DEFAULT_MAX_CURSOR_BYTES,
  create_query_cursor,
  decode_query_cursor,
};
