import { describe, expect, it } from "vitest";

import migration_module from "../lib/yaml_patch/migration";
import source_module from "../lib/yaml_patch/source";

const {
  execute_migration_batch,
  partition_migration_batches,
  plan_migration,
  resume_migration,
} = migration_module;
const { sha256_digest } = source_module;

function file(id, path, text) {
  return {
    id,
    path,
    digest: sha256_digest(Buffer.from(text)),
    document_count: 1,
    text,
  };
}

describe("YAML migration planning", () => {
  it("compiles key alias and typed conversion rules to query v2 plus operations", () => {
    const source = file(
      "main",
      "config.yaml",
      "record:\n  old_key: 1\n  keep: true\n",
    );
    const plan = plan_migration(
      {
        version: 1,
        files: [source],
        mode: "scan",
        rules: [
          {
            id: "alias-old-key",
            type: "normalize_key_alias",
            from_key: "old_key",
            to_key: "new_key",
            query: {
              version: 2,
              where: {
                all: [
                  { predicate: "addressable_type", equals: "scalar" },
                  { predicate: "raw_equals", equals: "old_key" },
                ],
              },
              select: { kind: "self" },
            },
          },
          {
            id: "convert-flag",
            type: "convert_typed_value",
            replacement_raw: '"yes"',
            query: {
              version: 2,
              where: {
                all: [
                  { predicate: "addressable_type", equals: "scalar" },
                  { predicate: "raw_equals", equals: "true" },
                ],
              },
              select: { kind: "self" },
            },
          },
        ],
      },
      {
        sources: { main: Buffer.from(source.text) },
      },
    );

    expect(plan.mode).toBe("scan");
    expect(plan.written).toBe(false);
    expect(plan.report.match_count).toBeGreaterThan(0);
    expect(plan.operations.some((op) => op.type === "rename_mapping_key")).toBe(
      true,
    );
    expect(plan.operations.some((op) => op.type === "replace_scalar_raw")).toBe(
      true,
    );
    expect(plan.batches.length).toBeGreaterThan(0);
  });

  it("partitions batches by stable file/node/byte limits", () => {
    const operations = Array.from({ length: 5 }, (_, index) => ({
      id: `op-${index}`,
      type: "replace_scalar_raw",
      file: index < 3 ? "a" : "b",
      target: {
        selector: { version: 1, path: [{ mapping_key: "value" }] },
      },
      raw: `v${index}`,
    }));
    const batches = partition_migration_batches(
      { operations },
      {
        max_file_per_batch: 1,
        max_node_per_batch: 2,
        max_byte_per_batch: 10_000,
      },
    );
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.file_ids.length).toBeLessThanOrEqual(1);
      expect(batch.operations.length).toBeLessThanOrEqual(2);
    }
  });

  it("executes a scan/dry-run batch as an ordinary transaction plan", async () => {
    const source = file("main", "config.yaml", "value: old\n");
    const plan = plan_migration(
      {
        version: 1,
        files: [source],
        rules: [
          {
            id: "rewrite-value",
            type: "convert_typed_value",
            replacement_raw: "new",
            query: {
              version: 2,
              where: {
                all: [
                  { predicate: "addressable_type", equals: "scalar" },
                  { predicate: "raw_equals", equals: "old" },
                ],
              },
              select: { kind: "self" },
            },
          },
        ],
      },
      { sources: { main: Buffer.from(source.text) } },
    );

    const batch_result = await execute_migration_batch(plan, plan.batches[0], {
      files: [source],
      sources: { main: Buffer.from(source.text) },
      capability_digest: "c".repeat(64),
      tool_version: "1.0.1",
      write: false,
    });
    expect(batch_result.no_op).toBe(false);
    expect(batch_result.written).toBe(false);
    expect(batch_result.manifest.result.migration_state).toMatchObject({
      batch_id: plan.batches[0].batch_id,
      global_validation_pending: true,
    });
  });

  it("treats a repeated identical batch as a successful no-op", async () => {
    const source = file("main", "config.yaml", "value: new\n");
    const plan = plan_migration(
      {
        version: 1,
        files: [source],
        rules: [
          {
            id: "rewrite-value",
            type: "convert_typed_value",
            replacement_raw: "new",
            query: {
              version: 2,
              where: {
                all: [
                  { predicate: "addressable_type", equals: "scalar" },
                  { predicate: "raw_equals", equals: "new" },
                ],
              },
              select: { kind: "self" },
            },
          },
        ],
      },
      { sources: { main: Buffer.from(source.text) } },
    );
    // Force a no-op replace against identical content.
    plan.batches[0].operations = [
      {
        id: "noop",
        type: "replace_scalar_raw",
        file: "main",
        target: {
          selector: { version: 1, path: [{ mapping_key: "value" }] },
        },
        raw: "new",
      },
    ];
    const batch_result = await execute_migration_batch(plan, plan.batches[0], {
      files: [source],
      sources: { main: Buffer.from(source.text) },
      capability_digest: "c".repeat(64),
      tool_version: "1.0.1",
    });
    expect(batch_result.no_op).toBe(true);
  });

  it("refuses blind resume when source or profile digests change", async () => {
    const source = file("main", "config.yaml", "value: old\n");
    const plan = plan_migration(
      {
        version: 1,
        files: [source],
        rules: [
          {
            id: "rewrite-value",
            type: "convert_typed_value",
            replacement_raw: "new",
            query: {
              version: 2,
              where: { predicate: "addressable_type", equals: "scalar" },
              select: { kind: "self" },
            },
          },
        ],
      },
      { sources: { main: Buffer.from(source.text) } },
    );

    await expect(
      resume_migration(plan, {
        action: "continue",
        source_digest: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await expect(
      resume_migration(
        { ...plan, profile_digest: "a".repeat(64) },
        {
          action: "continue",
          profile_digest: "b".repeat(64),
        },
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("supports continue/retry/replan resume actions", async () => {
    const source = file("main", "config.yaml", "value: old\n");
    const plan = plan_migration(
      {
        version: 1,
        files: [source],
        rules: [
          {
            id: "rewrite-value",
            type: "convert_typed_value",
            replacement_raw: "new",
            query: {
              version: 2,
              where: {
                all: [
                  { predicate: "addressable_type", equals: "scalar" },
                  { predicate: "raw_equals", equals: "old" },
                ],
              },
              select: { kind: "self" },
            },
          },
        ],
      },
      { sources: { main: Buffer.from(source.text) } },
    );

    const continued = await resume_migration(plan, {
      action: "continue",
      files: [source],
      sources: { main: Buffer.from(source.text) },
      capability_digest: "c".repeat(64),
      tool_version: "1.0.1",
    });
    expect(continued.batches.length).toBe(plan.batches.length);

    const retried = await resume_migration(plan, {
      action: "retry",
      batch_id: plan.batches[0].batch_id,
      files: [source],
      sources: { main: Buffer.from(source.text) },
      capability_digest: "c".repeat(64),
      tool_version: "1.0.1",
    });
    expect(retried.batches).toHaveLength(1);

    const replanned = await resume_migration(plan, {
      action: "replan",
      request: {
        version: 1,
        files: [source],
        rules: plan.operations.length
          ? [
              {
                id: "rewrite-value",
                type: "convert_typed_value",
                replacement_raw: "new",
                query: {
                  version: 2,
                  where: {
                    all: [
                      { predicate: "addressable_type", equals: "scalar" },
                      { predicate: "raw_equals", equals: "old" },
                    ],
                  },
                  select: { kind: "self" },
                },
              },
            ]
          : [],
      },
      sources: { main: Buffer.from(source.text) },
    });
    expect(replanned.report).toBeTruthy();
  });
});
