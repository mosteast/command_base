"use strict";

const { Yaml_patch_error } = require("./error");
const { sha256_digest } = require("./source");

function ensure_buffer(value, name) {
  if (!Buffer.isBuffer(value)) {
    throw new TypeError(`${name} must be a Buffer`);
  }
}

function create_byte_proof(original_buffer, candidate_buffer, range) {
  ensure_buffer(original_buffer, "original_buffer");
  ensure_buffer(candidate_buffer, "candidate_buffer");
  ensure_buffer(range.replacement_buffer, "replacement_buffer");
  const { start_byte, end_byte, replacement_buffer } = range;
  if (
    !Number.isInteger(start_byte) ||
    !Number.isInteger(end_byte) ||
    start_byte < 0 ||
    end_byte < start_byte ||
    end_byte > original_buffer.length
  ) {
    throw new Yaml_patch_error(
      "BYTE_GUARANTEE_FAILED",
      "Declared byte range is outside the original source",
      { details: { start_byte, end_byte, size_bytes: original_buffer.length } },
    );
  }

  const expected_candidate = Buffer.concat([
    original_buffer.subarray(0, start_byte),
    replacement_buffer,
    original_buffer.subarray(end_byte),
  ]);
  if (!expected_candidate.equals(candidate_buffer)) {
    throw new Yaml_patch_error(
      "BYTE_GUARANTEE_FAILED",
      "Candidate contains changes outside the declared byte range",
      {
        details: {
          expected_digest: sha256_digest(expected_candidate),
          actual_digest: sha256_digest(candidate_buffer),
        },
      },
    );
  }

  const original_target = original_buffer.subarray(start_byte, end_byte);
  const no_op = original_target.equals(replacement_buffer);
  const candidate_end_byte = start_byte + replacement_buffer.length;
  const unchanged_regions = [
    {
      position: "before",
      original_start_byte: 0,
      original_end_byte: start_byte,
      candidate_start_byte: 0,
      candidate_end_byte: start_byte,
      digest: sha256_digest(original_buffer.subarray(0, start_byte)),
    },
    {
      position: "after",
      original_start_byte: end_byte,
      original_end_byte: original_buffer.length,
      candidate_start_byte: candidate_end_byte,
      candidate_end_byte: candidate_buffer.length,
      digest: sha256_digest(original_buffer.subarray(end_byte)),
    },
  ];

  return {
    format: "yaml_patch-byte-proof",
    version: 1,
    verified: true,
    no_op,
    original_digest: sha256_digest(original_buffer),
    candidate_digest: sha256_digest(candidate_buffer),
    ranges: [
      {
        original_start_byte: start_byte,
        original_end_byte: end_byte,
        candidate_start_byte: start_byte,
        candidate_end_byte,
        original_digest: sha256_digest(original_target),
        replacement_digest: sha256_digest(replacement_buffer),
      },
    ],
    unchanged_regions,
    summary: no_op
      ? {
          deleted_bytes: 0,
          inserted_bytes: 0,
          touched_bytes: 0,
          size_delta: 0,
        }
      : {
          deleted_bytes: end_byte - start_byte,
          inserted_bytes: replacement_buffer.length,
          touched_bytes: end_byte - start_byte + replacement_buffer.length,
          size_delta: replacement_buffer.length - (end_byte - start_byte),
        },
  };
}

function format_text_diff(original_buffer, replacement_buffer, range, label) {
  const original_text = original_buffer
    .subarray(range.start_byte, range.end_byte)
    .toString("utf8");
  const replacement_text = replacement_buffer.toString("utf8");
  if (original_text === replacement_text) return "";
  const diff_lines = [
    `--- ${label || "source"}`,
    `+++ ${label || "candidate"}`,
    `@@ bytes ${range.start_byte},${range.end_byte} @@`,
  ];
  for (const line of original_text.split("\n")) {
    if (line !== "") diff_lines.push(`-${line}`);
  }
  for (const line of replacement_text.split("\n")) {
    if (line !== "") diff_lines.push(`+${line}`);
  }
  return `${diff_lines.join("\n")}\n`;
}

module.exports = {
  create_byte_proof,
  format_text_diff,
};
