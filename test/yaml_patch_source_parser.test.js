import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import source_module from "../lib/yaml_patch/source";
import parser_module from "../lib/yaml_patch/parser";
import node_index_module from "../lib/yaml_patch/node_index";

const {
  create_source_record,
  read_source_file,
  sha256_digest,
  utf16_offset_to_byte,
} = source_module;
const { SUPPORTED_YAML_VERSION, get_yaml_parser_version, parse_yaml_source } =
  parser_module;
const { build_node_index } = node_index_module;

const temp_directories = [];

afterEach(async () => {
  await Promise.all(
    temp_directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("YAML patch source reader", () => {
  it("preserves the original buffer while mapping UTF-16 offsets to UTF-8 bytes", () => {
    const original_buffer = Buffer.from("\ufeffa: 中文😀\r\n", "utf8");
    const source = create_source_record(original_buffer, {
      file_path: "/tmp/example.yaml",
    });

    expect(source.buffer).toBe(original_buffer);
    expect(source.text).toBe("a: 中文😀\r\n");
    expect(source.bom).toBe(true);
    expect(source.encoding).toBe("utf-8");
    expect(source.line_break_mode).toBe("crlf");
    expect(source.size_bytes).toBe(original_buffer.length);
    expect(source.digest).toBe(sha256_digest(original_buffer));

    expect(utf16_offset_to_byte(source, 0)).toBe(3);
    expect(utf16_offset_to_byte(source, 3)).toBe(6);
    expect(utf16_offset_to_byte(source, 5)).toBe(12);
    expect(utf16_offset_to_byte(source, 7)).toBe(16);
    expect(() => utf16_offset_to_byte(source, 6)).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_EDIT_SHAPE" }),
    );
  });

  it("rejects invalid UTF-8 without replacement characters", () => {
    expect(() =>
      create_source_record(Buffer.from([0xc3, 0x28]), {
        file_path: "/tmp/invalid.yaml",
      }),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_ENCODING" }));
  });

  it("checks file size before reading and records safe file metadata", async () => {
    const temp_directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "yaml-patch-source-"),
    );
    temp_directories.push(temp_directory);
    const file_path = path.join(temp_directory, "source with space.yaml");
    await fs.writeFile(file_path, "enabled: true\n", { mode: 0o640 });

    const source = await read_source_file(file_path, { max_file_bytes: 1024 });

    expect(source.file_path).toBe(await fs.realpath(file_path));
    expect(source.file_type).toBe("regular");
    expect(source.mode & 0o777).toBe(0o640);
    expect(source.hard_link_count).toBe(1);

    await expect(
      read_source_file(file_path, { max_file_bytes: 4 }),
    ).rejects.toMatchObject({ code: "CHANGE_LIMIT_EXCEEDED" });
  });

  it("checks a symbolic link target size before reading its bytes", async () => {
    const temp_directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "yaml-patch-symlink-source-"),
    );
    temp_directories.push(temp_directory);
    const target_path = path.join(temp_directory, "large-target.yaml");
    const symbolic_path = path.join(temp_directory, "source-link.yaml");
    await fs.writeFile(target_path, Buffer.alloc(1024, 0x61));
    await fs.symlink(target_path, symbolic_path);

    await expect(
      read_source_file(symbolic_path, { max_file_bytes: 100 }),
    ).rejects.toMatchObject({ code: "CHANGE_LIMIT_EXCEEDED" });
  });

  it("reads through a bounded descriptor and detects post-stat growth", async () => {
    const temp_directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "yaml-patch-bounded-source-"),
    );
    temp_directories.push(temp_directory);
    const file_path = path.join(temp_directory, "source.yaml");
    await fs.writeFile(file_path, "value: old\n");

    await expect(
      read_source_file(file_path, {
        max_file_bytes: 1024,
        async before_read() {
          await fs.appendFile(file_path, "later: changed\n");
        },
      }),
    ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });
});

describe("yaml@2.8.0 parser adapter", () => {
  it("enforces the exact supported parser version", () => {
    expect(SUPPORTED_YAML_VERSION).toBe("2.8.0");
    expect(get_yaml_parser_version()).toBe("2.8.0");
  });

  it("parses every document with source tokens and stable source locations", () => {
    const source = create_source_record(
      Buffer.from("---\nname: first\n---\nname: 第二😀\n", "utf8"),
    );

    const parsed = parse_yaml_source(source);

    expect(parsed.documents).toHaveLength(2);
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.documents[0].contents.srcToken).toBeDefined();
    expect(parsed.documents[1].contents.range).toEqual([20, 31, 31]);
    expect(parsed.line_counter.linePos(20)).toEqual({ line: 4, col: 1 });
  });

  it("parses CR-only YAML without changing source byte offsets", () => {
    const source = create_source_record(
      Buffer.from("map:\r  alpha: one\r", "utf8"),
    );
    const parsed = parse_yaml_source(source);
    const index = build_node_index(source, parsed);

    expect(source.line_break_mode).toBe("cr");
    expect(parsed.errors).toEqual([]);
    expect(parsed.documents[0].toJSON()).toEqual({ map: { alpha: "one" } });
    expect(
      index.entries.find((entry) => entry.raw === "one").source,
    ).toMatchObject({
      start_byte: 14,
      end_byte: 17,
    });
  });

  it("normalizes syntax errors instead of relying on thrown parse calls", () => {
    const source = create_source_record(Buffer.from("items: [one,\n", "utf8"));

    const parsed = parse_yaml_source(source);

    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toMatchObject({
      kind: "error",
      code: "BAD_INDENT",
      document: 0,
      start_byte: 13,
    });
    expect(parsed.errors[0].message).toContain("Flow sequence");
  });

  it("classifies only stack-exhaustion RangeErrors as structural limits", () => {
    const source = create_source_record(Buffer.from("value: old\n", "utf8"));

    expect(() =>
      parse_yaml_source(source, {
        parse_all_documents() {
          throw new RangeError("Maximum call stack size exceeded");
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
    expect(() =>
      parse_yaml_source(source, {
        parse_all_documents() {
          throw new RangeError("numeric range is invalid");
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "INTERNAL_ERROR" }));
  });
});
