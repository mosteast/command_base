import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import source_module from "../lib/yaml_patch/source";
import parser_module from "../lib/yaml_patch/parser";
import node_index_module from "../lib/yaml_patch/node_index";
import query_module from "../lib/yaml_patch/query";
import fragment_module from "../lib/yaml_patch/fragment";
import patch_module from "../lib/yaml_patch/patch";
import proof_module from "../lib/yaml_patch/proof";

const { create_source_record, sha256_digest } = source_module;
const { parse_yaml_source } = parser_module;
const { build_node_index } = node_index_module;
const { select_unique_node } = query_module;
const {
  break_stale_edit_package_lock,
  build_edit_package,
  edit_package_lock_path_for,
  inspect_edit_package_lock,
  load_edit_package,
  write_edit_package,
} = fragment_module;
const { compile_fragment_patch, compile_operation_patch } = patch_module;
const { create_byte_proof } = proof_module;

const temp_directories = [];

afterEach(async () => {
  await Promise.all(
    temp_directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function create_index(text, file_path = "/tmp/source.yaml") {
  const source = create_source_record(Buffer.from(text, "utf8"), { file_path });
  return build_node_index(source, parse_yaml_source(source));
}

function package_for(text, query, edit_unit = "node-value", options = {}) {
  const index = create_index(text);
  const entry = select_unique_node(index, query);
  return {
    index,
    entry,
    edit_package: build_edit_package(index, entry, {
      edit_unit,
      ...options,
    }),
  };
}

describe("YAML edit package", () => {
  it("keeps the editable fragment separate from read-only context", () => {
    const text = "service:\n  name: api\n  timeout: 30 # keep\nnext: value\n";
    const { edit_package } = package_for(text, {
      path: [{ mapping_key: "service" }],
    });

    expect(edit_package.fragment_buffer.toString("utf8")).toBe(
      "name: api\n  timeout: 30 # keep\n",
    );
    expect(edit_package.manifest).toMatchObject({
      format: "yaml_patch-edit",
      version: 1,
      source: {
        path: "/tmp/source.yaml",
        encoding: "utf-8",
        digest: sha256_digest(Buffer.from(text)),
      },
      target: {
        document: 0,
        node_type: "mapping",
        edit_unit: "node-value",
      },
      dependencies: { cross_boundary_anchor_alias: false },
    });
    expect(edit_package.context.target.path).toEqual(
      edit_package.manifest.target.path,
    );
    expect(JSON.stringify(edit_package.context)).not.toContain("timeout: 30");
  });

  it("summarizes ancestors, siblings, and descendants within exact budgets", () => {
    const text =
      "before: one\nservice:\n  name: api\n  timeout: 30\nafter: two\n";
    const index = create_index(text);
    const service = select_unique_node(index, {
      path: [{ mapping_key: "service" }],
    });
    const edit_package = build_edit_package(index, service, {
      edit_unit: "node-value",
      ancestors: 1,
      siblings: 1,
      descendants_depth: 1,
      max_bytes: 4096,
      max_characters: 4096,
    });

    expect(edit_package.context.ancestors).toHaveLength(1);
    expect(edit_package.context.siblings.before).toHaveLength(1);
    expect(edit_package.context.siblings.after).toHaveLength(1);
    expect(edit_package.context.descendants).toHaveLength(2);
    expect(edit_package.context.omitted).toEqual({
      ancestors: [],
      siblings: [],
      descendants: [],
    });
    expect(JSON.stringify(edit_package.context)).not.toContain("name: api");
    const included_summaries = [
      ...edit_package.context.ancestors,
      ...edit_package.context.siblings.before,
      ...edit_package.context.siblings.after,
      ...edit_package.context.descendants,
    ];
    expect(edit_package.context.budget.used_bytes).toBe(
      service.size_bytes +
        included_summaries.reduce(
          (total, summary) =>
            total + Buffer.byteLength(JSON.stringify(summary), "utf8"),
          0,
        ),
    );
    expect(edit_package.context.budget.used_characters).toBe(
      service.size_characters +
        included_summaries.reduce(
          (total, summary) => total + JSON.stringify(summary).length,
          0,
        ),
    );

    const constrained = build_edit_package(index, service, {
      edit_unit: "node-value",
      ancestors: 1,
      siblings: 1,
      descendants_depth: 1,
      max_bytes: service.size_bytes,
      max_characters: service.size_characters,
    });
    expect(constrained.context.ancestors).toEqual([]);
    expect(constrained.context.siblings).toEqual({ before: [], after: [] });
    expect(constrained.context.descendants).toEqual([]);
    expect(constrained.context.omitted.ancestors).toHaveLength(1);
    expect(constrained.context.omitted.siblings).toHaveLength(2);
    expect(constrained.context.omitted.descendants).toHaveLength(2);
  });

  it("writes and reloads versioned package files with refresh protection", async () => {
    const temp_directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "yaml-patch-fragment-"),
    );
    temp_directories.push(temp_directory);
    const output_directory = path.join(temp_directory, "session with space");
    const { edit_package } = package_for("value: old\n", {
      path: [{ mapping_key: "value" }],
    });

    await write_edit_package(edit_package, output_directory);
    const loaded = await load_edit_package(output_directory);

    expect(loaded.fragment_buffer.equals(edit_package.fragment_buffer)).toBe(
      true,
    );
    expect(loaded.manifest).toEqual(edit_package.manifest);
    await expect(
      write_edit_package(edit_package, output_directory),
    ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    await expect(
      write_edit_package(edit_package, output_directory, { refresh: true }),
    ).resolves.toBeDefined();
    await expect(
      load_edit_package(output_directory, { max_fragment_bytes: 2 }),
    ).rejects.toMatchObject({ code: "INVALID_FRAGMENT" });
  });

  it("serializes concurrent package creation and preserves the old package on refresh failure", async () => {
    const temp_directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "yaml-patch-fragment-atomic-"),
    );
    temp_directories.push(temp_directory);
    const output_directory = path.join(temp_directory, "session");
    const first = package_for("value: first\n", {
      path: [{ mapping_key: "value" }],
    }).edit_package;
    const second = package_for("value: second\n", {
      path: [{ mapping_key: "value" }],
    }).edit_package;

    const concurrent = await Promise.allSettled([
      write_edit_package(first, output_directory),
      write_edit_package(second, output_directory),
    ]);
    expect(
      concurrent.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      concurrent.find((result) => result.status === "rejected").reason,
    ).toMatchObject({ code: "OUTPUT_EXISTS" });
    const committed = await load_edit_package(output_directory);

    await expect(
      write_edit_package(
        committed.fragment_buffer.equals(first.fragment_buffer)
          ? second
          : first,
        output_directory,
        {
          refresh: true,
          before_commit() {
            throw new Error("injected package commit failure");
          },
        },
      ),
    ).rejects.toThrow("injected package commit failure");
    const after_failure = await load_edit_package(output_directory);
    expect(after_failure.manifest).toEqual(committed.manifest);
    expect(
      after_failure.fragment_buffer.equals(committed.fragment_buffer),
    ).toBe(true);
    expect(await fs.readdir(temp_directory)).toEqual(["session"]);
  });

  it("recovers an extract lock left by a dead process after explicit inspection", async () => {
    const temp_directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "yaml-patch-fragment-stale-lock-"),
    );
    temp_directories.push(temp_directory);
    const output_directory = path.join(temp_directory, "session");
    const lock_path = edit_package_lock_path_for(output_directory);
    const stale_lock = {
      output_directory,
      pid: 999999,
      hostname: os.hostname(),
      token: "stale-extract-token",
      created_at: "2020-01-01T00:00:00.000Z",
      operation: "extract",
    };
    await fs.writeFile(lock_path, `${JSON.stringify(stale_lock)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const { edit_package } = package_for("value: old\n", {
      path: [{ mapping_key: "value" }],
    });

    await expect(
      write_edit_package(edit_package, output_directory),
    ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    await expect(
      inspect_edit_package_lock(output_directory),
    ).resolves.toMatchObject({ lock: stale_lock });
    await expect(
      break_stale_edit_package_lock(output_directory, {
        expected_token: stale_lock.token,
      }),
    ).resolves.toMatchObject({ removed: true, lock: stale_lock });
    await expect(
      write_edit_package(edit_package, output_directory),
    ).resolves.toBeDefined();
  });

  it("keeps the extract namespace occupied across concurrent stale breakers", async () => {
    const temp_directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "yaml-patch-fragment-break-race-"),
    );
    temp_directories.push(temp_directory);
    const output_directory = path.join(temp_directory, "session");
    const lock_path = edit_package_lock_path_for(output_directory);
    const stale_lock = {
      output_directory,
      pid: 999999,
      hostname: os.hostname(),
      token: "concurrent-stale-extract-token",
      created_at: "2020-01-01T00:00:00.000Z",
      operation: "extract",
    };
    await fs.writeFile(lock_path, `${JSON.stringify(stale_lock)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const { edit_package } = package_for("value: old\n", {
      path: [{ mapping_key: "value" }],
    });
    let mark_inspected;
    const inspected = new Promise((resolve) => {
      mark_inspected = resolve;
    });
    let resume_breaker;
    const breaker_gate = new Promise((resolve) => {
      resume_breaker = resolve;
    });
    const delayed_breaker = break_stale_edit_package_lock(output_directory, {
      expected_token: stale_lock.token,
      async after_recovery_inspection() {
        mark_inspected();
        await breaker_gate;
      },
    });
    await inspected;

    await expect(
      break_stale_edit_package_lock(output_directory, {
        expected_token: stale_lock.token,
      }),
    ).resolves.toMatchObject({ removed: true });
    await expect(
      write_edit_package(edit_package, output_directory),
    ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    resume_breaker();
    await expect(delayed_breaker).rejects.toMatchObject({
      code: "UNSAFE_CONCURRENCY",
    });
    await expect(
      write_edit_package(edit_package, output_directory),
    ).resolves.toBeDefined();
  });

  it("rejects edit-package members read across a refresh generation", async () => {
    const temp_directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "yaml-patch-fragment-generation-"),
    );
    temp_directories.push(temp_directory);
    const output_directory = path.join(temp_directory, "session");
    const first = package_for("value: first\n", {
      path: [{ mapping_key: "value" }],
    }).edit_package;
    const second = package_for("value: second\n", {
      path: [{ mapping_key: "value" }],
    }).edit_package;
    await write_edit_package(first, output_directory);
    let mark_fragment_read;
    const fragment_read = new Promise((resolve) => {
      mark_fragment_read = resolve;
    });
    let resume_reader;
    const reader_gate = new Promise((resolve) => {
      resume_reader = resolve;
    });
    const loading = load_edit_package(output_directory, {
      async after_member_read({ member }) {
        if (member !== "fragment.yaml") return;
        mark_fragment_read();
        await reader_gate;
      },
    });
    await fragment_read;

    await write_edit_package(second, output_directory, { refresh: true });
    resume_reader();

    await expect(loading).rejects.toMatchObject({
      code: "UNSAFE_CONCURRENCY",
    });
  });

  it("refuses to extract a range with cross-boundary anchor dependencies", () => {
    const text = "shared: &item\n  value: one\nconsumer: *item\n";
    const index = create_index(text);
    const shared = select_unique_node(index, {
      path: [{ mapping_key: "shared" }],
    });

    expect(() =>
      build_edit_package(index, shared, { edit_unit: "node-value" }),
    ).toThrowError(
      expect.objectContaining({ code: "CROSS_BOUNDARY_DEPENDENCY" }),
    );
  });
});

describe("fragment patch compiler", () => {
  it("makes an unedited fragment a byte-identical no-op", () => {
    const text = "\ufeffservice:\r\n  name: 中文😀\r\nnext: 'same'\r\n";
    const { index, edit_package } = package_for(text, {
      path: [{ mapping_key: "service" }],
    });

    const result = compile_fragment_patch(
      index,
      edit_package.manifest,
      edit_package.fragment_buffer,
    );

    expect(result.no_op).toBe(true);
    expect(result.candidate_buffer.equals(index.source.buffer)).toBe(true);
    expect(result.proof.verified).toBe(true);
    expect(result.summary.touched_bytes).toBe(0);
  });

  it("changes only one scalar token and returns a byte proof and text diff", () => {
    const text = "before: untouched\nvalue: old # tail\nafter: untouched\n";
    const { index, edit_package } = package_for(
      text,
      { path: [{ mapping_key: "value" }] },
      "scalar-token",
    );

    const result = compile_fragment_patch(
      index,
      edit_package.manifest,
      Buffer.from("'new value'"),
    );

    expect(result.no_op).toBe(false);
    expect(result.candidate_buffer.toString("utf8")).toBe(
      "before: untouched\nvalue: 'new value' # tail\nafter: untouched\n",
    );
    expect(result.proof).toMatchObject({
      format: "yaml_patch-byte-proof",
      version: 1,
      verified: true,
    });
    expect(result.proof.unchanged_regions).toHaveLength(2);
    expect(result.text_diff).toContain("-old");
    expect(result.text_diff).toContain("+'new value'");
  });

  it("rejects strict source and target digest conflicts", () => {
    const { edit_package } = package_for(
      "value: old\nother: same\n",
      { path: [{ mapping_key: "value" }] },
      "scalar-token",
    );
    const changed_index = create_index("value: changed\nother: same\n");

    expect(() =>
      compile_fragment_patch(
        changed_index,
        edit_package.manifest,
        Buffer.from("new"),
      ),
    ).toThrowError(expect.objectContaining({ code: "SOURCE_CHANGED" }));

    const rebased_manifest = structuredClone(edit_package.manifest);
    rebased_manifest.source.digest = changed_index.source.digest;
    expect(() =>
      compile_fragment_patch(
        changed_index,
        rebased_manifest,
        Buffer.from("new"),
      ),
    ).toThrowError(expect.objectContaining({ code: "TARGET_CHANGED" }));
  });

  it("binds the manifest locator and rejects unknown protocol fields", () => {
    const packaged = package_for(
      "value: old\n",
      { path: [{ mapping_key: "value" }] },
      "scalar-token",
    );
    const changed_locator = structuredClone(packaged.edit_package.manifest);
    changed_locator.target.locator = "not-the-extracted-locator";
    expect(() =>
      compile_fragment_patch(
        packaged.index,
        changed_locator,
        Buffer.from("new"),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAGMENT" }));

    const unknown_field = structuredClone(packaged.edit_package.manifest);
    unknown_field.required_future_field = true;
    expect(() =>
      compile_fragment_patch(packaged.index, unknown_field, Buffer.from("new")),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAGMENT" }));

    for (const mutate_manifest of [
      (manifest) => {
        manifest.source.path = null;
      },
      (manifest) => {
        manifest.target.document = "0";
      },
      (manifest) => {
        manifest.target.end_byte = manifest.target.start_byte - 1;
      },
      (manifest) => {
        manifest.limits.expect_matches = 2;
      },
      (manifest) => {
        delete manifest.limits;
      },
      (manifest) => {
        manifest.source.path = "bad\0path.yaml";
      },
    ]) {
      const invalid_manifest = structuredClone(packaged.edit_package.manifest);
      mutate_manifest(invalid_manifest);
      expect(() =>
        compile_fragment_patch(
          packaged.index,
          invalid_manifest,
          Buffer.from("new"),
        ),
      ).toThrowError(expect.objectContaining({ code: "INVALID_FRAGMENT" }));
    }
  });

  it("rejects invalid candidates and node-class changes", () => {
    const scalar_package = package_for(
      "value: old\n",
      { path: [{ mapping_key: "value" }] },
      "node-value",
    );
    expect(() =>
      compile_fragment_patch(
        scalar_package.index,
        scalar_package.edit_package.manifest,
        Buffer.from("[unterminated"),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RESULT" }));

    const mapping_package = package_for("service:\n  name: api\n", {
      path: [{ mapping_key: "service" }],
    });
    expect(() =>
      compile_fragment_patch(
        mapping_package.index,
        mapping_package.edit_package.manifest,
        Buffer.from("plain"),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAGMENT" }));
  });

  it("accepts unchanged opaque-tag warnings but rejects new warnings", () => {
    const existing = package_for(
      "tagged: !custom old\nvalue: one\n",
      { path: [{ mapping_key: "value" }] },
      "scalar-token",
    );
    expect(() =>
      compile_fragment_patch(
        existing.index,
        existing.edit_package.manifest,
        Buffer.from("two"),
      ),
    ).not.toThrow();

    const clean = package_for(
      "value: old\n",
      { path: [{ mapping_key: "value" }] },
      "node-value",
    );
    expect(() =>
      compile_fragment_patch(
        clean.index,
        clean.edit_package.manifest,
        Buffer.from("!custom new"),
      ),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("enforces deleted, inserted, and touched byte limits", () => {
    const limited = package_for(
      "value: old\n",
      { path: [{ mapping_key: "value" }] },
      "scalar-token",
      {
        limits: {
          max_deleted_bytes: 3,
          max_inserted_bytes: 3,
          max_touched_bytes: 6,
        },
      },
    );

    expect(() =>
      compile_fragment_patch(
        limited.index,
        limited.edit_package.manifest,
        Buffer.from("long"),
      ),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
  });

  it("supports one declarative mapping-value operation and rejects lists", () => {
    const index = create_index("service:\n  timeout: 30\n  enabled: true\n");
    const service = select_unique_node(index, {
      path: [{ mapping_key: "service" }],
    });

    const result = compile_operation_patch(index, {
      version: 1,
      operations: [
        {
          target: {
            locator: service.locator,
            expected_digest: service.raw_digest,
          },
          operation: { type: "set_mapping_value", key: "timeout", value: 45 },
        },
      ],
    });

    expect(result.candidate_buffer.toString("utf8")).toContain("timeout: 45\n");
    expect(() =>
      compile_operation_patch(index, {
        version: 1,
        operations: [
          { target: {}, operation: { type: "replace_node_value" } },
          { target: {}, operation: { type: "replace_node_value" } },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_EDIT_UNIT" }));

    expect(() =>
      compile_operation_patch(index, {
        version: 1,
        operations: [
          {
            target: {
              locator: service.locator,
              expected_digest: service.raw_digest,
            },
            operation: {
              type: "set_mapping_value",
              key: "timeout",
              value: 45,
              required_future_field: true,
            },
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_ERROR" }));

    const timeout = select_unique_node(index, {
      path: [{ mapping_key: "service" }, { mapping_key: "timeout" }],
    });
    expect(() =>
      compile_operation_patch(index, {
        version: 1,
        operations: [
          {
            target: {
              locator: timeout.locator,
              expected_digest: timeout.raw_digest,
            },
            operation: {
              type: "replace_scalar_token",
              value: [1, 2],
            },
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_ERROR" }));
  });
});

describe("byte proof", () => {
  it("detects a candidate change outside the declared range", () => {
    const original = Buffer.from("before-old-after");
    const candidate = Buffer.from("BEFORE-new-after");

    expect(() =>
      create_byte_proof(original, candidate, {
        start_byte: 7,
        end_byte: 10,
        replacement_buffer: Buffer.from("new"),
      }),
    ).toThrowError(expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }));
  });
});
