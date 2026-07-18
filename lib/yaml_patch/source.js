"use strict";

const crypto = require("node:crypto");
const fs_sync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const { Yaml_patch_error } = require("./error");

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;

function sha256_digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function decode_utf8(buffer, file_path) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new Yaml_patch_error(
      "UNSUPPORTED_ENCODING",
      `Source is not valid UTF-8: ${file_path || "<buffer>"}`,
      {
        cause: error,
        recoverable: false,
        next_action: "convert the source to valid UTF-8 without data loss",
      },
    );
  }
}

function build_utf16_byte_map(text, byte_offset = 0) {
  const byte_map = new Array(text.length + 1);
  let character_offset = 0;
  let current_byte = byte_offset;

  while (character_offset < text.length) {
    const code_point = text.codePointAt(character_offset);
    const character = String.fromCodePoint(code_point);
    const code_unit_length = character.length;
    byte_map[character_offset] = current_byte;

    if (code_unit_length === 2) {
      byte_map[character_offset + 1] = null;
    }

    character_offset += code_unit_length;
    current_byte += Buffer.byteLength(character, "utf8");
  }

  byte_map[text.length] = current_byte;
  return byte_map;
}

function detect_line_break_mode(text) {
  const crlf_count = (text.match(/\r\n/g) || []).length;
  const without_crlf = text.replace(/\r\n/g, "");
  const lf_count = (without_crlf.match(/\n/g) || []).length;
  const cr_count = (without_crlf.match(/\r/g) || []).length;
  const used_modes = [crlf_count, lf_count, cr_count].filter(
    (count) => count > 0,
  ).length;

  if (used_modes > 1) return "mixed";
  if (crlf_count > 0) return "crlf";
  if (lf_count > 0) return "lf";
  if (cr_count > 0) return "cr";
  return "none";
}

function source_snapshot_id(options = {}) {
  const source_path = options.file_path || options.requested_path || "";
  if (!source_path && options.source_id !== undefined) {
    if (
      typeof options.source_id !== "string" ||
      options.source_id.length === 0
    ) {
      throw new TypeError("source_id must be a non-empty string");
    }
    return JSON.stringify({ kind: "source_id", id: options.source_id });
  }
  if (!source_path) {
    return JSON.stringify({ kind: "instance", id: crypto.randomUUID() });
  }
  return JSON.stringify({
    kind: "file",
    path: source_path ? path.resolve(source_path) : "",
    device: Number.isSafeInteger(options.device) ? options.device : null,
    inode: Number.isSafeInteger(options.inode) ? options.inode : null,
  });
}

function create_source_record(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("create_source_record requires a Buffer");
  }

  const bom = buffer.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
  const content_start_byte = bom ? UTF8_BOM.length : 0;
  const text = decode_utf8(
    buffer.subarray(content_start_byte),
    options.file_path,
  );

  const source_identity = source_snapshot_id(options);
  return {
    buffer,
    text,
    file_path: options.file_path || "",
    requested_path: options.requested_path || options.file_path || "",
    encoding: "utf-8",
    bom,
    content_start_byte,
    line_break_mode: detect_line_break_mode(text),
    size_bytes: buffer.length,
    size_characters: text.length,
    digest: sha256_digest(buffer),
    source_identity,
    snapshot_id: source_identity,
    utf16_byte_map: build_utf16_byte_map(text, content_start_byte),
    file_type: options.file_type || "buffer",
    mode: options.mode,
    uid: options.uid,
    gid: options.gid,
    hard_link_count: options.hard_link_count,
    device: options.device,
    inode: options.inode,
  };
}

function utf16_offset_to_byte(source, character_offset) {
  if (
    !Number.isInteger(character_offset) ||
    character_offset < 0 ||
    character_offset >= source.utf16_byte_map.length
  ) {
    throw new Yaml_patch_error(
      "UNSUPPORTED_EDIT_SHAPE",
      `Parser offset is outside the source: ${character_offset}`,
      { details: { character_offset } },
    );
  }

  const byte_offset = source.utf16_byte_map[character_offset];
  if (byte_offset === null || byte_offset === undefined) {
    throw new Yaml_patch_error(
      "UNSUPPORTED_EDIT_SHAPE",
      `Parser offset splits a UTF-16 surrogate pair: ${character_offset}`,
      { details: { character_offset } },
    );
  }
  return byte_offset;
}

async function read_source_file(file_path, options = {}) {
  const file = await read_bounded_file(file_path, {
    ...options,
    allow_symbolic_link: true,
  });

  return create_source_record(file.buffer, {
    file_path: file.real_path,
    requested_path: file.absolute_path,
    file_type: file.file_type,
    mode: file.stats.mode,
    uid: file.stats.uid,
    gid: file.stats.gid,
    hard_link_count: file.stats.nlink,
    device: file.stats.dev,
    inode: file.stats.ino,
  });
}

function file_identity_matches(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function source_changed_error(
  file_path,
  initial_stats,
  final_stats,
  read_size,
  error_code = "SOURCE_CHANGED",
) {
  return new Yaml_patch_error(
    error_code,
    "Source changed while it was being read",
    {
      recoverable: true,
      next_action: "retry after concurrent writes have completed",
      details: {
        path: file_path,
        stat_size: initial_stats && initial_stats.size,
        final_size: final_stats && final_stats.size,
        read_size,
        initial_inode: initial_stats && initial_stats.ino,
        final_inode: final_stats && final_stats.ino,
      },
    },
  );
}

function bounded_read_error(code, message, details) {
  return new Yaml_patch_error(code, message, {
    recoverable: true,
    next_action:
      "verify the file type and retry after concurrent writes complete",
    details,
  });
}

async function read_bounded_file(file_path, options = {}) {
  const absolute_path = path.resolve(file_path);
  const allow_symbolic_link = options.allow_symbolic_link !== false;
  const file_type_error_code =
    options.file_type_error_code || "UNSUPPORTED_FILE_TYPE";
  const limit_error_code = options.limit_error_code || "CHANGE_LIMIT_EXCEEDED";
  const changed_error_code = options.changed_error_code || "SOURCE_CHANGED";
  let link_stats;
  try {
    link_stats = await fs.lstat(absolute_path);
  } catch (error) {
    throw new Yaml_patch_error(file_type_error_code, `Cannot stat source`, {
      cause: error,
      details: { path: absolute_path },
      recoverable: true,
      next_action: "verify that the source path exists and is readable",
    });
  }

  const file_type = link_stats.isFile()
    ? "regular"
    : link_stats.isSymbolicLink()
      ? "symbolic-link"
      : "other";
  if (
    file_type === "other" ||
    (file_type === "symbolic-link" && !allow_symbolic_link)
  ) {
    throw bounded_read_error(
      file_type_error_code,
      `Source must be a ${allow_symbolic_link ? "regular file or symbolic link" : "regular file"}: ${absolute_path}`,
      { path: absolute_path, file_type },
    );
  }
  let real_path;
  try {
    real_path = await fs.realpath(absolute_path);
  } catch (error) {
    throw new Yaml_patch_error(
      file_type_error_code,
      `Cannot resolve source: ${absolute_path}`,
      {
        cause: error,
        recoverable: true,
        next_action:
          "verify that the source path target exists and is readable",
        details: { path: absolute_path, file_type },
      },
    );
  }
  const max_file_bytes =
    options.max_file_bytes === undefined
      ? DEFAULT_MAX_FILE_BYTES
      : Number(options.max_file_bytes);
  if (!Number.isFinite(max_file_bytes) || max_file_bytes < 0) {
    throw bounded_read_error(
      limit_error_code,
      `Maximum source size must be a non-negative finite number: ${max_file_bytes}`,
      { path: absolute_path, max_file_bytes },
    );
  }

  const no_follow_flag = fs_sync.constants.O_NOFOLLOW || 0;
  let handle;
  try {
    handle = await fs.open(
      real_path,
      fs_sync.constants.O_RDONLY | no_follow_flag,
    );
    const initial_stats = await handle.stat();
    if (!initial_stats.isFile()) {
      throw bounded_read_error(
        file_type_error_code,
        `Source must resolve to a regular file: ${absolute_path}`,
        { path: absolute_path, file_type },
      );
    }
    if (
      file_type === "regular" &&
      !file_identity_matches(link_stats, initial_stats)
    ) {
      throw source_changed_error(
        absolute_path,
        link_stats,
        initial_stats,
        0,
        changed_error_code,
      );
    }
    if (initial_stats.size > max_file_bytes) {
      throw bounded_read_error(
        limit_error_code,
        `Source size ${initial_stats.size} exceeds limit ${max_file_bytes}`,
        {
          path: absolute_path,
          size_bytes: initial_stats.size,
          max_file_bytes,
        },
      );
    }
    if (typeof options.before_read === "function") {
      await options.before_read({
        absolute_path,
        real_path,
        stats: initial_stats,
      });
    }
    const ready_stats = await handle.stat();
    if (!file_identity_matches(initial_stats, ready_stats)) {
      throw source_changed_error(
        absolute_path,
        initial_stats,
        ready_stats,
        0,
        changed_error_code,
      );
    }

    const buffer = Buffer.allocUnsafe(initial_stats.size);
    let read_size = 0;
    while (read_size < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        read_size,
        buffer.length - read_size,
        read_size,
      );
      if (bytesRead === 0) {
        throw source_changed_error(
          absolute_path,
          initial_stats,
          null,
          read_size,
          changed_error_code,
        );
      }
      read_size += bytesRead;
    }
    const final_stats = await handle.stat();
    if (
      read_size !== initial_stats.size ||
      !file_identity_matches(initial_stats, final_stats)
    ) {
      throw source_changed_error(
        absolute_path,
        initial_stats,
        final_stats,
        read_size,
        changed_error_code,
      );
    }
    return {
      absolute_path,
      real_path,
      file_type,
      buffer,
      stats: initial_stats,
    };
  } catch (error) {
    if (error instanceof Yaml_patch_error) throw error;
    throw new Yaml_patch_error(
      file_type_error_code,
      `Cannot read source: ${absolute_path}`,
      {
        cause: error,
        recoverable: true,
        next_action: "verify that the source file is readable and retry",
        details: { path: absolute_path, file_type },
      },
    );
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

module.exports = {
  DEFAULT_MAX_FILE_BYTES,
  build_utf16_byte_map,
  create_source_record,
  detect_line_break_mode,
  read_bounded_file,
  read_source_file,
  sha256_digest,
  source_snapshot_id,
  utf16_offset_to_byte,
};
