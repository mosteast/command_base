import { describe, expect, it, vi } from "vitest";

import artifact_version_module from "../lib/yaml_patch/artifact_version";
import source_module from "../lib/yaml_patch/source";
import transaction_module from "../lib/yaml_patch/transaction";

const { canonical_digest } = artifact_version_module;
const { sha256_digest } = source_module;
const { participant_digest_for, plan_transaction } = transaction_module;

function file(id, path, text, overrides = {}) {
  return {
    declaration: {
      id,
      path,
      digest: sha256_digest(Buffer.from(text)),
      document_count: 1,
      ...overrides,
    },
    source: Buffer.from(text),
  };
}

function request(files, operations, overrides = {}) {
  return {
    version: 1,
    files: files.map((item) => item.declaration),
    operations,
    ...overrides,
  };
}

function options(files, overrides = {}) {
  return {
    sources: Object.fromEntries(
      files.map((item) => [item.declaration.id, item.source]),
    ),
    capability_digest: "c".repeat(64),
    tool_version: "1.0.1",
    ...overrides,
  };
}

describe("YAML transaction planning", () => {
  it("binds an added subtree result for a following relative edit", async () => {
    const input = file("main", "config.yaml", "items:\n  - name: existing\n");
    const result = await plan_transaction(
      request(
        [input],
        [
          {
            id: "create",
            type: "add_subtree",
            destination: {
              file: "main",
              selector: { version: 1, path: [{ mapping_key: "items" }] },
              position: { kind: "append" },
            },
            raw: "name: draft\nunknown: keep\n",
            result_handle: "created",
          },
          {
            id: "rename-created",
            type: "replace_scalar_raw",
            target: { handle: "created", path: [{ mapping_key: "name" }] },
            raw: "ready",
          },
        ],
      ),
      options([input]),
    );

    expect(result.candidates.main.buffer.toString()).toBe(
      "items:\n  - name: existing\n  - name: ready\n    unknown: keep\n",
    );
    expect(result.operations[0]).toMatchObject({ result_handle: "created" });
  });

  it("moves a subtree between collections in one file snapshot", async () => {
    const input = file(
      "main",
      "config.yaml",
      "source:\n  - name: move\ndestination:\n  - name: keep\n",
    );
    const result = await plan_transaction(
      request(
        [input],
        [
          {
            id: "move-within-file",
            type: "move_subtree",
            source: {
              file: "main",
              selector: {
                version: 1,
                path: [{ mapping_key: "source" }, { sequence_index: 0 }],
              },
            },
            destination: {
              file: "main",
              selector: { version: 1, path: [{ mapping_key: "destination" }] },
              position: { kind: "append" },
            },
            result_handle: "moved",
          },
        ],
      ),
      options([input]),
    );

    expect(result.candidates.main.buffer.toString()).toBe(
      "source:\n  []\ndestination:\n  - name: keep\n  - name: move\n",
    );
  });

  it("moves a subtree within its current sequence collection", async () => {
    const input = file(
      "main",
      "config.yaml",
      "items:\n  - name: first\n  - name: second\n",
    );
    const result = await plan_transaction(
      request(
        [input],
        [
          {
            id: "move-first-to-end",
            type: "move_subtree",
            source: {
              file: "main",
              selector: {
                version: 1,
                path: [{ mapping_key: "items" }, { sequence_index: 0 }],
              },
            },
            destination: {
              file: "main",
              selector: { version: 1, path: [{ mapping_key: "items" }] },
              position: { kind: "append" },
            },
            result_handle: "moved",
          },
        ],
      ),
      options([input]),
    );

    expect(result.candidates.main.buffer.toString()).toBe(
      "items:\n  - name: second\n  - name: first\n",
    );
    expect(result.operations[0]).toMatchObject({ result_handle: "moved" });
  });

  it("rejects moving a subtree into its own descendant collection", async () => {
    const input = file(
      "main",
      "config.yaml",
      "items:\n  - name: parent\n    children:\n      - name: child\n",
    );

    await expect(
      plan_transaction(
        request(
          [input],
          [
            {
              id: "move-into-self",
              type: "move_subtree",
              source: {
                file: "main",
                selector: {
                  version: 1,
                  path: [{ mapping_key: "items" }, { sequence_index: 0 }],
                },
              },
              destination: {
                file: "main",
                selector: {
                  version: 1,
                  path: [
                    { mapping_key: "items" },
                    { sequence_index: 0 },
                    { mapping_key: "children" },
                  ],
                },
                position: { kind: "append" },
              },
            },
          ],
        ),
        options([input]),
      ),
    ).rejects.toMatchObject({ code: "CROSS_BOUNDARY_DEPENDENCY" });
  });

  it("accepts a matching typed operation precondition", async () => {
    const input = file("main", "config.yaml", "value: old\n");
    const result = await plan_transaction(
      request(
        [input],
        [
          {
            id: "typed-precondition",
            type: "replace_scalar_raw",
            file: "main",
            target: {
              selector: { version: 1, path: [{ mapping_key: "value" }] },
            },
            raw: "new",
            preconditions: { typed: { type: "string", value: "old" } },
          },
        ],
      ),
      options([input]),
    );

    expect(result.candidates.main.buffer.toString()).toBe("value: new\n");
  });

  it("applies selectors to the current snapshot in declaration order", async () => {
    const input = file("main", "config.yaml", "items:\n  - one\n");
    const result = await plan_transaction(
      request(
        [input],
        [
          {
            id: "prepend",
            type: "prepend_sequence_item",
            file: "main",
            target: {
              selector: { version: 1, path: [{ mapping_key: "items" }] },
            },
            value: "zero",
          },
          {
            id: "delete-current-one",
            type: "delete_sequence_item",
            file: "main",
            target: {
              selector: { version: 1, path: [{ mapping_key: "items" }] },
            },
            index: 1,
          },
        ],
      ),
      options([input]),
    );

    expect(result.candidates.main.buffer.toString()).toBe("items:\n  - zero\n");
    expect(result.operation_order).toEqual(["prepend", "delete-current-one"]);
  });

  it("keeps bound and result handles attached through reorder and cross-file move", async () => {
    const source = file(
      "source",
      "source.yaml",
      "items:\n  - name: first\n  - name: second\n",
    );
    const destination = file(
      "destination",
      "destination.yaml",
      "items:\n  - name: existing\n",
    );
    const result = await plan_transaction(
      request(
        [source, destination],
        [
          {
            id: "bind-first",
            type: "bind",
            file: "source",
            selector: {
              version: 1,
              path: [{ mapping_key: "items" }, { sequence_index: 0 }],
            },
            handle: "first",
          },
          {
            id: "reorder",
            type: "reorder_sequence_items",
            file: "source",
            target: {
              selector: { version: 1, path: [{ mapping_key: "items" }] },
            },
            indices: [1, 0],
          },
          {
            id: "move-bound",
            type: "move_subtree",
            source: { handle: "first" },
            destination: {
              file: "destination",
              selector: { version: 1, path: [{ mapping_key: "items" }] },
              position: { kind: "append" },
            },
            result_handle: "moved",
          },
          {
            id: "rename-moved",
            type: "replace_scalar_raw",
            target: { handle: "moved", path: [{ mapping_key: "name" }] },
            raw: "renamed",
          },
        ],
      ),
      options([source, destination]),
    );

    expect(result.candidates.source.buffer.toString()).toBe(
      "items:\n  - name: second\n",
    );
    expect(result.candidates.destination.buffer.toString()).toBe(
      "items:\n  - name: existing\n  - name: renamed\n",
    );
    expect(
      result.operations.find((operation) => operation.id === "move-bound"),
    ).toMatchObject({ result_handle: "moved", no_op: false });
    const source_move = result.diffs
      .find((diff) => diff.structured.file_id === "source")
      .structured.operations.find((operation) => operation.id === "move-bound");
    expect(source_move.before.raw).toContain("name: first");
  });

  it("moves descendant handle bindings with a cross-file parent subtree", async () => {
    const source = file(
      "source",
      "source.yaml",
      "items:\n  - name: parent\n    child:\n      name: nested\n",
    );
    const destination = file(
      "destination",
      "destination.yaml",
      "items:\n  - name: existing\n",
    );
    const result = await plan_transaction(
      request(
        [source, destination],
        [
          {
            id: "bind-descendant",
            type: "bind",
            file: "source",
            selector: {
              version: 1,
              path: [
                { mapping_key: "items" },
                { sequence_index: 0 },
                { mapping_key: "child" },
                { mapping_key: "name" },
              ],
            },
            handle: "nested_name",
          },
          {
            id: "move-parent",
            type: "move_subtree",
            source: {
              file: "source",
              selector: {
                version: 1,
                path: [{ mapping_key: "items" }, { sequence_index: 0 }],
              },
            },
            destination: {
              file: "destination",
              selector: { version: 1, path: [{ mapping_key: "items" }] },
              position: { kind: "append" },
            },
          },
          {
            id: "edit-descendant",
            type: "replace_scalar_raw",
            target: { handle: "nested_name" },
            raw: "renamed",
          },
        ],
      ),
      options([source, destination]),
    );

    expect(result.candidates.source.buffer.toString()).toBe("items:\n  []\n");
    expect(result.candidates.destination.buffer.toString()).toContain(
      "      name: renamed\n",
    );
  });

  it("binds the exact copied result when an identical node already exists", async () => {
    const source = file(
      "source",
      "source.yaml",
      "items:\n  - name: duplicate\n",
    );
    const destination = file(
      "destination",
      "destination.yaml",
      "items:\n  - name: duplicate\n",
    );
    const result = await plan_transaction(
      request(
        [source, destination],
        [
          {
            id: "copy-duplicate",
            type: "copy_subtree",
            source: {
              file: "source",
              selector: {
                version: 1,
                path: [{ mapping_key: "items" }, { sequence_index: 0 }],
              },
            },
            destination: {
              file: "destination",
              selector: { version: 1, path: [{ mapping_key: "items" }] },
              position: { kind: "append" },
            },
            result_handle: "copied",
          },
          {
            id: "edit-copy",
            type: "replace_scalar_raw",
            target: { handle: "copied", path: [{ mapping_key: "name" }] },
            raw: "renamed",
          },
        ],
      ),
      options([source, destination]),
    );

    expect(result.candidates.destination.buffer.toString()).toBe(
      "items:\n  - name: duplicate\n  - name: renamed\n",
    );
  });

  it("tracks an exact handle through a byte-identical sequence reorder", async () => {
    const input = file(
      "main",
      "config.yaml",
      "items:\n  - name: duplicate\n  - name: duplicate\n",
    );
    const result = await plan_transaction(
      request(
        [input],
        [
          {
            id: "bind-first",
            type: "bind",
            file: "main",
            selector: {
              version: 1,
              path: [{ mapping_key: "items" }, { sequence_index: 0 }],
            },
            handle: "first",
          },
          {
            id: "reorder-identical",
            type: "reorder_sequence_items",
            file: "main",
            target: {
              selector: { version: 1, path: [{ mapping_key: "items" }] },
            },
            indices: [1, 0],
          },
          {
            id: "edit-first",
            type: "replace_scalar_raw",
            target: { handle: "first", path: [{ mapping_key: "name" }] },
            raw: "tracked",
          },
        ],
      ),
      options([input]),
    );

    expect(result.candidates.main.buffer.toString()).toBe(
      "items:\n  - name: duplicate\n  - name: tracked\n",
    );
  });

  it("resolves a subtree destination through a transaction handle", async () => {
    const source = file("source", "source.yaml", "items:\n  - name: copied\n");
    const destination = file(
      "destination",
      "destination.yaml",
      "items:\n  - name: existing\n",
    );
    const result = await plan_transaction(
      request(
        [source, destination],
        [
          {
            id: "bind-destination",
            type: "bind",
            file: "destination",
            selector: { version: 1, path: [{ mapping_key: "items" }] },
            handle: "destination_items",
          },
          {
            id: "copy-through-handle",
            type: "copy_subtree",
            source: {
              file: "source",
              selector: {
                version: 1,
                path: [{ mapping_key: "items" }, { sequence_index: 0 }],
              },
            },
            destination: {
              handle: "destination_items",
              position: { kind: "append" },
            },
          },
        ],
      ),
      options([source, destination]),
    );

    expect(result.candidates.destination.buffer.toString()).toBe(
      "items:\n  - name: existing\n  - name: copied\n",
    );
  });

  it("previews the complete owned-comment move range and relocation evidence", async () => {
    const source = file(
      "source",
      "source.yaml",
      "items:\n  # owned by moved\n  - name: moved\n  - name: remain\n",
    );
    const destination = file(
      "destination",
      "destination.yaml",
      "items:\n  - name: existing\n",
    );
    const result = await plan_transaction(
      request(
        [source, destination],
        [
          {
            id: "move-with-comment",
            type: "move_subtree",
            source: {
              file: "source",
              selector: {
                version: 1,
                path: [{ mapping_key: "items" }, { sequence_index: 0 }],
              },
            },
            destination: {
              file: "destination",
              selector: { version: 1, path: [{ mapping_key: "items" }] },
              position: { kind: "append" },
            },
          },
        ],
      ),
      options([source, destination]),
    );
    const source_diff = result.diffs.find(
      (diff) => diff.structured.file_id === "source",
    );
    const structured_move = source_diff.structured.operations.find(
      (operation) => operation.id === "move-with-comment",
    );
    const semantic_move = source_diff.semantic.operations.find(
      (operation) => operation.id === "move-with-comment",
    );

    expect(structured_move.moved_range).toMatchObject({
      owner: "source",
      includes_owned_comment: true,
    });
    expect(structured_move.moved_range.start_byte).toBeLessThan(
      structured_move.original_range.start_byte,
    );
    expect(semantic_move).toMatchObject({
      source: {
        file_id: "source",
        parent: expect.objectContaining({
          path: [expect.objectContaining({ mapping_pair_index: 0 })],
        }),
      },
      destination: {
        file_id: "destination",
        parent: expect.objectContaining({
          path: [expect.objectContaining({ mapping_pair_index: 0 })],
        }),
        position: { kind: "append" },
      },
    });
  });

  it("validates all declared participants before loading any source", async () => {
    const load_source = vi.fn();
    await expect(
      plan_transaction(
        {
          version: 1,
          files: [
            { id: "declared", path: "declared.yaml", digest: "a".repeat(64) },
          ],
          operations: [
            {
              id: "undeclared-read",
              type: "bind",
              file: "missing",
              selector: { version: 1, path: [] },
              handle: "root",
            },
          ],
        },
        { load_source },
      ),
    ).rejects.toMatchObject({ code: "CROSS_BOUNDARY_DEPENDENCY" });
    expect(load_source).not.toHaveBeenCalled();
  });

  it("digests participants whose optional file digest was omitted", () => {
    expect(participant_digest_for([{ id: "main", path: "config.yaml" }])).toBe(
      canonical_digest([{ id: "main", digest: null }]),
    );
  });

  it("rejects unknown subtree reference fields before loading sources", async () => {
    const load_source = vi.fn();

    await expect(
      plan_transaction(
        {
          version: 1,
          files: [{ id: "main", path: "config.yaml" }],
          operations: [
            {
              id: "malformed-source",
              type: "delete_subtree",
              source: {
                file: "main",
                selector: {
                  version: 1,
                  path: [{ mapping_key: "items" }, { sequence_index: 0 }],
                },
                unexpected: true,
              },
            },
          ],
        },
        { load_source },
      ),
    ).rejects.toMatchObject({ code: "REQUEST_ERROR" });
    expect(load_source).not.toHaveBeenCalled();
  });

  it("rejects stale transaction, file, and operation preconditions with bounded details", async () => {
    const input = file("main", "config.yaml", "value: old\n");
    const base_operation = {
      id: "replace",
      type: "replace_scalar_raw",
      file: "main",
      target: { selector: { version: 1, path: [{ mapping_key: "value" }] } },
      raw: "new",
    };
    const cases = [
      request([input], [base_operation], {
        preconditions: { participant_digest: "f".repeat(64) },
      }),
      request(
        [
          {
            ...input,
            declaration: { ...input.declaration, digest: "e".repeat(64) },
          },
        ],
        [base_operation],
      ),
      request(
        [input],
        [
          {
            ...base_operation,
            preconditions: { raw: "different", match_count: 1 },
          },
        ],
      ),
    ];

    for (const stale of cases) {
      await expect(
        plan_transaction(stale, options([input])),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        details: expect.objectContaining({ scope: expect.any(String) }),
      });
    }
  });

  it("checks delete_subtree preconditions against its current source", async () => {
    const input = file(
      "main",
      "config.yaml",
      "items:\n  - name: selected\n  - name: remain\n",
    );

    await expect(
      plan_transaction(
        request(
          [input],
          [
            {
              id: "delete-selected",
              type: "delete_subtree",
              source: {
                file: "main",
                selector: {
                  version: 1,
                  path: [{ mapping_key: "items" }, { sequence_index: 0 }],
                },
              },
              preconditions: { raw: "name: stale" },
            },
          ],
        ),
        options([input]),
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      details: expect.objectContaining({
        scope: "operation",
        field: "raw",
      }),
    });
  });

  it("checks add_subtree preconditions against its current destination", async () => {
    const input = file("main", "config.yaml", "items:\n  - existing\n");

    await expect(
      plan_transaction(
        request(
          [input],
          [
            {
              id: "add-selected",
              type: "add_subtree",
              destination: {
                file: "main",
                selector: { version: 1, path: [{ mapping_key: "items" }] },
                position: { kind: "append" },
              },
              raw: "name: created",
              preconditions: { target_digest: "f".repeat(64) },
            },
          ],
        ),
        options([input]),
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      details: expect.objectContaining({
        scope: "operation",
        field: "target_digest",
      }),
    });
  });

  it("invalidates descendant handles when their parent subtree is deleted", async () => {
    const input = file(
      "main",
      "config.yaml",
      "items:\n  - name: parent\n    child: nested\n",
    );
    const result = await plan_transaction(
      request(
        [input],
        [
          {
            id: "bind-descendant",
            type: "bind",
            file: "main",
            selector: {
              version: 1,
              path: [
                { mapping_key: "items" },
                { sequence_index: 0 },
                { mapping_key: "child" },
              ],
            },
            handle: "child",
          },
          {
            id: "delete-parent",
            type: "delete_subtree",
            source: {
              file: "main",
              selector: {
                version: 1,
                path: [{ mapping_key: "items" }, { sequence_index: 0 }],
              },
            },
          },
        ],
      ),
      options([input]),
    );

    expect(result.candidates.main.buffer.toString()).toBe("items:\n  []\n");
  });

  it("rejects a dangling alias in an intermediate candidate", async () => {
    const input = file("main", "config.yaml", "items:\n  - existing\n");

    await expect(
      plan_transaction(
        request(
          [input],
          [
            {
              id: "introduce-alias",
              type: "add_subtree",
              destination: {
                file: "main",
                selector: { version: 1, path: [{ mapping_key: "items" }] },
                position: { kind: "append" },
              },
              raw: "*missing",
            },
          ],
        ),
        options([input]),
      ),
    ).rejects.toMatchObject({ code: "ANCHOR_CONFLICT" });
  });

  it("enforces structural and byte limits with one algorithm for dry-run and write planning", async () => {
    const input = file(
      "main",
      "config.yaml",
      "items:\n  - one\n  - existing\n",
    );
    const operation = {
      id: "append",
      type: "append_sequence_item",
      file: "main",
      target: { selector: { version: 1, path: [{ mapping_key: "items" }] } },
      value: "two",
    };
    const limit_cases = [
      { max_file: 0 },
      { max_operation: 0 },
      { max_match: 0 },
      { max_range: 0 },
      { max_added_node: 0 },
      {
        max_deleted_node: 0,
        operation: {
          id: "delete",
          type: "delete_sequence_item",
          file: operation.file,
          target: operation.target,
          index: 0,
        },
      },
      {
        max_moved_node: 0,
        operation: {
          id: "move",
          type: "move_sequence_item",
          file: operation.file,
          target: operation.target,
          index: 0,
          position: { kind: "append" },
        },
      },
      { max_touched_byte_per_file: 0 },
      { max_touched_byte_total: 0 },
    ];

    for (const test_case of limit_cases) {
      const selected_operation = test_case.operation || operation;
      const limits = Object.fromEntries(
        Object.entries(test_case).filter(([field]) => field !== "operation"),
      );
      for (const write of [false, true]) {
        await expect(
          plan_transaction(
            request([input], [selected_operation], { limits }),
            options([input], { write }),
          ),
        ).rejects.toMatchObject({ code: "CHANGE_LIMIT_EXCEEDED" });
      }
    }
  });

  it("passes identity limits to final profile validation", async () => {
    const input = file("main", "config.yaml", "records:\n  - key: one\n");
    const used_profile = {
      version: 1,
      node_sets: {
        record: {
          query: {
            version: 2,
            where: { predicate: "addressable_type", equals: "mapping" },
            select: { kind: "self", missing: "error" },
            projection: { fields: ["path"], missing: "error" },
            page: { limit: 100 },
          },
          fields: {
            allowed: ["key"],
            required: ["key"],
            optional: [],
            rules: { key: { types: ["string"] } },
          },
          field_order: ["key"],
          diagnostic_projection: ["key"],
        },
      },
      identity: [
        {
          rule_id: "record-key",
          node_set: "record",
          fields: ["key"],
          unique_scope: "input",
          missing_policy: "error",
          null_policy: "error",
          types: ["string"],
          immutable_existing: false,
        },
      ],
      protected: [],
      field_aliases: [],
    };
    await expect(
      plan_transaction(
        request(
          [input],
          [
            {
              id: "append-record",
              type: "append_sequence_item",
              file: "main",
              target: {
                selector: { version: 1, path: [{ mapping_key: "records" }] },
              },
              value: { key: "two" },
            },
          ],
          { limits: { max_added_identity: 0 } },
        ),
        options([input], {
          profile: used_profile,
          profile_digest: canonical_digest(used_profile),
        }),
      ),
    ).rejects.toMatchObject({ code: "CHANGE_LIMIT_EXCEEDED" });
  });

  it("normalizes a byte-identical final transaction to a deterministic success no-op", async () => {
    const input = file("main", "config.yaml", "value: old\n");
    const planned_request = request(
      [input],
      [
        {
          id: "change",
          type: "replace_scalar_raw",
          file: "main",
          target: {
            selector: { version: 1, path: [{ mapping_key: "value" }] },
          },
          raw: "new",
        },
        {
          id: "restore",
          type: "replace_scalar_raw",
          file: "main",
          target: {
            selector: { version: 1, path: [{ mapping_key: "value" }] },
          },
          raw: "old",
        },
      ],
    );
    const first = await plan_transaction(planned_request, options([input]));
    const second = await plan_transaction(planned_request, options([input]));

    expect(first.no_op).toBe(true);
    expect(first.candidates.main.buffer.equals(input.source)).toBe(true);
    expect(first.files[0].proof).toMatchObject({ no_op: true, ranges: [] });
    expect(first.transaction_proof).toEqual(second.transaction_proof);
    expect(first.diffs).toEqual(second.diffs);
    expect(first.manifest.reproducible_digest).toBe(
      second.manifest.reproducible_digest,
    );
    expect(participant_digest_for(planned_request.files)).toBeTypeOf("string");
  });

  it("rejects invalid handle syntax, vanished ranges, and cross-transaction handles", async () => {
    const input = file("main", "config.yaml", "items:\n  - one\n");
    const invalid_operations = [
      {
        id: "missing-handle",
        type: "delete_subtree",
        source: { handle: "prior" },
      },
      {
        id: "bad-handle",
        type: "bind",
        file: "main",
        selector: { version: 1, path: [] },
        handle: "not allowed",
      },
      {
        id: "bad-range",
        type: "bind",
        file: "main",
        selector: { version: 1, source: { start_byte: 999 } },
        handle: "outside",
      },
    ];

    for (const operation of invalid_operations) {
      await expect(
        plan_transaction(request([input], [operation]), options([input])),
      ).rejects.toMatchObject({
        code: expect.stringMatching(
          /^(REQUEST_ERROR|NO_MATCH|PRECONDITION_FAILED)$/,
        ),
      });
    }
  });
});
