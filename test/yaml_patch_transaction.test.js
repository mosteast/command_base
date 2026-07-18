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

function per_operation_profile(per_operation_rule) {
  return {
    version: 1,
    node_sets: {
      record: {
        query: {
          version: 2,
          where: {
            all: [
              { predicate: "node_type", equals: "mapping" },
              {
                predicate: "relation",
                relation: "parent",
                where: {
                  predicate: "addressable_type",
                  equals: "sequence_item",
                },
              },
            ],
          },
          select: { kind: "self", missing: "error" },
          projection: { fields: ["path"], missing: "error" },
        },
        fields: {
          allowed: ["key", "other"],
          required: ["key"],
          optional: ["other"],
          rules: { key: { types: ["string"] } },
        },
        field_order: ["key", "other"],
        diagnostic_projection: ["key"],
      },
    },
    identity: [],
    protected: [],
    field_aliases: [],
    per_operation_rule,
  };
}

describe("YAML transaction planning", () => {
  it("keeps a target handle on the exact duplicate node after a generic edit", async () => {
    const scalar_input = file(
      "main",
      "config.yaml",
      "first: duplicate\nsecond: duplicate\n",
    );
    const scalar_result = await plan_transaction(
      request(
        [scalar_input],
        [
          {
            id: "bind-first",
            type: "bind",
            file: "main",
            selector: { version: 1, path: [{ mapping_key: "first" }] },
            handle: "first",
          },
          {
            id: "edit-first-once",
            type: "replace_scalar_raw",
            target: { handle: "first" },
            raw: "changed",
          },
          {
            id: "edit-first-twice",
            type: "replace_scalar_raw",
            target: { handle: "first" },
            raw: "final",
          },
        ],
      ),
      options([scalar_input]),
    );

    expect(scalar_result.candidates.main.buffer.toString()).toBe(
      "first: final\nsecond: duplicate\n",
    );
  });

  it("keeps a target handle on the exact duplicate node after a deletion edit", async () => {
    const sequence_input = file(
      "main",
      "config.yaml",
      "groups:\n  - items:\n      - duplicate\n      - keep\n  - items:\n      - duplicate\n      - keep\n",
    );
    const sequence_result = await plan_transaction(
      request(
        [sequence_input],
        [
          {
            id: "bind-first-group",
            type: "bind",
            file: "main",
            selector: {
              version: 1,
              path: [
                { mapping_key: "groups" },
                { sequence_index: 0 },
                { mapping_key: "items" },
              ],
            },
            handle: "first_group",
          },
          {
            id: "delete-from-first-group",
            type: "delete_sequence_item",
            target: { handle: "first_group" },
            index: 0,
          },
          {
            id: "append-to-first-group",
            type: "append_sequence_item",
            target: { handle: "first_group" },
            value: "tracked",
          },
        ],
      ),
      options([sequence_input]),
    );

    expect(sequence_result.candidates.main.buffer.toString()).toBe(
      "groups:\n  - items:\n      - keep\n      - tracked\n  - items:\n      - duplicate\n      - keep\n",
    );
  });

  it("invalidates a descendant handle when its sequence item is deleted", async () => {
    const sequence_input = file(
      "main",
      "config.yaml",
      "items:\n  - name: deleted\n  - name: surviving\n",
    );

    await expect(
      plan_transaction(
        request(
          [sequence_input],
          [
            {
              id: "bind-deleted-name",
              type: "bind",
              file: "main",
              selector: {
                version: 1,
                path: [
                  { mapping_key: "items" },
                  { sequence_index: 0 },
                  { mapping_key: "name" },
                ],
              },
              handle: "deleted_name",
            },
            {
              id: "delete-first-item",
              type: "delete_sequence_item",
              file: "main",
              target: {
                selector: { version: 1, path: [{ mapping_key: "items" }] },
              },
              index: 0,
            },
            {
              id: "edit-deleted-name",
              type: "replace_scalar_raw",
              target: { handle: "deleted_name" },
              raw: "must-not-apply",
            },
          ],
        ),
        options([sequence_input]),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("shifts a descendant handle when an identical sequence item is prepended", async () => {
    const sequence_input = file(
      "main",
      "config.yaml",
      "items:\n  - name: duplicate\n",
    );
    const result = await plan_transaction(
      request(
        [sequence_input],
        [
          {
            id: "bind-original-name",
            type: "bind",
            file: "main",
            selector: {
              version: 1,
              path: [
                { mapping_key: "items" },
                { sequence_index: 0 },
                { mapping_key: "name" },
              ],
            },
            handle: "original_name",
          },
          {
            id: "prepend-identical-item",
            type: "prepend_sequence_item",
            file: "main",
            target: {
              selector: { version: 1, path: [{ mapping_key: "items" }] },
            },
            value: { name: "duplicate" },
          },
          {
            id: "edit-original-name",
            type: "replace_scalar_raw",
            target: { handle: "original_name" },
            raw: "tracked",
          },
        ],
      ),
      options([sequence_input]),
    );

    expect(result.candidates.main.buffer.toString()).toBe(
      "items:\n  - name: duplicate\n  - name: tracked\n",
    );
  });

  it("invalidates a descendant handle when its mapping pair is deleted", async () => {
    const mapping_input = file(
      "main",
      "config.yaml",
      "record:\n  first:\n    name: duplicate\n  second:\n    name: duplicate\n",
    );

    await expect(
      plan_transaction(
        request(
          [mapping_input],
          [
            {
              id: "bind-deleted-mapping-name",
              type: "bind",
              file: "main",
              selector: {
                version: 1,
                path: [
                  { mapping_key: "record" },
                  { mapping_key: "first" },
                  { mapping_key: "name" },
                ],
              },
              handle: "deleted_mapping_name",
            },
            {
              id: "delete-first-pair",
              type: "delete_mapping_pair",
              file: "main",
              target: {
                selector: { version: 1, path: [{ mapping_key: "record" }] },
              },
              pair: { index: 0 },
            },
            {
              id: "edit-deleted-mapping-name",
              type: "replace_scalar_raw",
              target: { handle: "deleted_mapping_name" },
              raw: "must-not-apply",
            },
          ],
        ),
        options([mapping_input]),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("shifts a descendant handle when an identical mapping pair is prepended", async () => {
    const mapping_input = file(
      "main",
      "config.yaml",
      "record:\n  original:\n    name: duplicate\n",
    );
    const result = await plan_transaction(
      request(
        [mapping_input],
        [
          {
            id: "bind-original-mapping-name",
            type: "bind",
            file: "main",
            selector: {
              version: 1,
              path: [
                { mapping_key: "record" },
                { mapping_key: "original" },
                { mapping_key: "name" },
              ],
            },
            handle: "original_mapping_name",
          },
          {
            id: "prepend-identical-pair",
            type: "add_mapping_pair",
            file: "main",
            target: {
              selector: { version: 1, path: [{ mapping_key: "record" }] },
            },
            key: "inserted",
            value: { name: "duplicate" },
            position: { kind: "prepend" },
          },
          {
            id: "edit-original-mapping-name",
            type: "replace_scalar_raw",
            target: { handle: "original_mapping_name" },
            raw: "tracked",
          },
        ],
      ),
      options([mapping_input]),
    );

    expect(result.candidates.main.buffer.toString()).toBe(
      "record:\n  inserted:\n    name: duplicate\n  original:\n    name: tracked\n",
    );
  });

  it("moves a mapping descendant handle by pair identity", async () => {
    const mapping_input = file(
      "main",
      "config.yaml",
      "record:\n  first:\n    name: duplicate\n  second:\n    name: duplicate\n",
    );
    const result = await plan_transaction(
      request(
        [mapping_input],
        [
          {
            id: "bind-first-mapping-name",
            type: "bind",
            file: "main",
            selector: {
              version: 1,
              path: [
                { mapping_key: "record" },
                { mapping_key: "first" },
                { mapping_key: "name" },
              ],
            },
            handle: "first_mapping_name",
          },
          {
            id: "move-first-pair",
            type: "move_mapping_pair",
            file: "main",
            target: {
              selector: { version: 1, path: [{ mapping_key: "record" }] },
            },
            pair: { index: 0 },
            position: { kind: "append" },
          },
          {
            id: "edit-moved-mapping-name",
            type: "replace_scalar_raw",
            target: { handle: "first_mapping_name" },
            raw: "tracked",
          },
        ],
      ),
      options([mapping_input]),
    );

    expect(result.candidates.main.buffer.toString()).toBe(
      "record:\n  second:\n    name: duplicate\n  first:\n    name: tracked\n",
    );
  });

  it("reorders a mapping descendant handle by pair identity", async () => {
    const mapping_input = file(
      "main",
      "config.yaml",
      "record:\n  first:\n    name: duplicate\n  second:\n    name: duplicate\n",
    );
    const result = await plan_transaction(
      request(
        [mapping_input],
        [
          {
            id: "bind-first-reordered-name",
            type: "bind",
            file: "main",
            selector: {
              version: 1,
              path: [
                { mapping_key: "record" },
                { mapping_key: "first" },
                { mapping_key: "name" },
              ],
            },
            handle: "first_reordered_name",
          },
          {
            id: "reorder-mapping-pairs",
            type: "reorder_mapping_pairs",
            file: "main",
            target: {
              selector: { version: 1, path: [{ mapping_key: "record" }] },
            },
            pairs: [{ index: 1 }, { index: 0 }],
          },
          {
            id: "edit-reordered-mapping-name",
            type: "replace_scalar_raw",
            target: { handle: "first_reordered_name" },
            raw: "tracked",
          },
        ],
      ),
      options([mapping_input]),
    );

    expect(result.candidates.main.buffer.toString()).toBe(
      "record:\n  second:\n    name: duplicate\n  first:\n    name: tracked\n",
    );
  });

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

  it("retains an existing destination handle when add_subtree prepends an identical item", async () => {
    const input = file(
      "main",
      "config.yaml",
      "items:\n  - name: duplicate # existing bytes\n    raw: 'keep'\n",
    );
    const result = await plan_transaction(
      request(
        [input],
        [
          {
            id: "bind-existing",
            type: "bind",
            file: "main",
            selector: {
              version: 1,
              path: [{ mapping_key: "items" }, { sequence_index: 0 }],
            },
            handle: "existing",
          },
          {
            id: "prepend-duplicate",
            type: "add_subtree",
            destination: {
              file: "main",
              selector: { version: 1, path: [{ mapping_key: "items" }] },
              position: { kind: "prepend" },
            },
            raw: "name: duplicate # added bytes\nraw: 'keep'\n",
          },
          {
            id: "edit-existing",
            type: "replace_scalar_raw",
            target: { handle: "existing", path: [{ mapping_key: "name" }] },
            raw: "tracked",
          },
        ],
      ),
      options([input]),
    );

    expect(result.candidates.main.buffer.toString()).toBe(
      "items:\n  - name: duplicate # added bytes\n    raw: 'keep'\n  - name: tracked # existing bytes\n    raw: 'keep'\n",
    );
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

  it("keeps an identical sibling handle attached during a same-collection subtree move", async () => {
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
            id: "bind-staying-sibling",
            type: "bind",
            file: "main",
            selector: {
              version: 1,
              path: [{ mapping_key: "items" }, { sequence_index: 1 }],
            },
            handle: "staying",
          },
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
          },
          {
            id: "edit-staying-sibling",
            type: "replace_scalar_raw",
            target: { handle: "staying", path: [{ mapping_key: "name" }] },
            raw: "tracked",
          },
        ],
      ),
      options([input]),
    );

    expect(result.candidates.main.buffer.toString()).toBe(
      "items:\n  - name: tracked\n  - name: duplicate\n",
    );
  });

  it("keeps an identical destination sibling handle attached during a cross-file move", async () => {
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
            id: "bind-existing-destination",
            type: "bind",
            file: "destination",
            selector: {
              version: 1,
              path: [{ mapping_key: "items" }, { sequence_index: 0 }],
            },
            handle: "existing",
          },
          {
            id: "move-duplicate-before-existing",
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
              position: { kind: "prepend" },
            },
          },
          {
            id: "edit-existing-destination",
            type: "replace_scalar_raw",
            target: { handle: "existing", path: [{ mapping_key: "name" }] },
            raw: "tracked",
          },
        ],
      ),
      options([source, destination]),
    );

    expect(result.candidates.destination.buffer.toString()).toBe(
      "items:\n  - name: duplicate\n  - name: tracked\n",
    );
  });

  it("moves a nested subtree to an ancestor collection without overlapping splices", async () => {
    const input = file(
      "main",
      "config.yaml",
      `items:
  - name: parent
    children:
      # owned by moved
      - name: move
      - name: stay
  - name: existing
`,
    );
    const result = await plan_transaction(
      request(
        [input],
        [
          {
            id: "move-child-to-root",
            type: "move_subtree",
            source: {
              file: "main",
              selector: {
                version: 1,
                path: [
                  { mapping_key: "items" },
                  { sequence_index: 0 },
                  { mapping_key: "children" },
                  { sequence_index: 0 },
                ],
              },
            },
            destination: {
              file: "main",
              selector: { version: 1, path: [{ mapping_key: "items" }] },
              position: { kind: "append" },
            },
          },
        ],
      ),
      options([input]),
    );

    expect(result.candidates.main.buffer.toString()).toBe(`items:
  - name: parent
    children:
      - name: stay
  - name: existing
  # owned by moved
  - name: move
`);
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

  it("retains an existing destination handle when copy_subtree prepends an identical item", async () => {
    const source = file(
      "source",
      "source.yaml",
      "items:\n  - name: duplicate # copied bytes\n    raw: 'keep'\n",
    );
    const destination = file(
      "destination",
      "destination.yaml",
      "items:\n  - name: duplicate # existing bytes\n    raw: 'keep'\n",
    );
    const result = await plan_transaction(
      request(
        [source, destination],
        [
          {
            id: "bind-existing",
            type: "bind",
            file: "destination",
            selector: {
              version: 1,
              path: [{ mapping_key: "items" }, { sequence_index: 0 }],
            },
            handle: "existing",
          },
          {
            id: "copy-before-existing",
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
              position: { kind: "prepend" },
            },
          },
          {
            id: "edit-existing",
            type: "replace_scalar_raw",
            target: { handle: "existing", path: [{ mapping_key: "name" }] },
            raw: "tracked",
          },
        ],
      ),
      options([source, destination]),
    );

    expect(result.candidates.destination.buffer.toString()).toBe(
      "items:\n  - name: duplicate # copied bytes\n    raw: 'keep'\n  - name: tracked # existing bytes\n    raw: 'keep'\n",
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

  it("rejects malformed public participant digest entries with request errors", () => {
    for (const malformed of [
      [null],
      [42],
      [[]],
      [{}],
      [{ id: "" }],
      [{ id: "main", digest: null }],
      [{ id: "main", digest: "not-a-digest" }],
      [{ id: "main" }, { id: "main" }],
    ]) {
      expect(() => participant_digest_for(malformed)).toThrowError(
        expect.objectContaining({ code: "REQUEST_ERROR" }),
      );
    }
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

  it("bounds raw bind evidence in diffs and manifests", async () => {
    const raw = "x".repeat(1024 * 1024);
    const input = file("main", "large.yaml", `value: ${raw}\n`);
    const result = await plan_transaction(
      request(
        [input],
        [
          {
            id: "bind-large",
            type: "bind",
            file: "main",
            selector: { version: 1, path: [{ mapping_key: "value" }] },
            handle: "large",
          },
        ],
      ),
      options([input]),
    );
    const evidence = result.diffs[0].structured.operations[0];

    for (const value of [evidence.before, evidence.after]) {
      expect(value).toMatchObject({
        raw_digest: sha256_digest(Buffer.from(raw)),
        size_bytes: Buffer.byteLength(raw),
        truncated: true,
        raw: expect.any(String),
        typed: null,
      });
      expect(Buffer.byteLength(value.raw)).toBeLessThanOrEqual(4 * 1024);
    }
    expect(Buffer.byteLength(JSON.stringify(result.manifest))).toBeLessThan(
      32 * 1024,
    );
  });

  it("bounds raw operation precondition error details", async () => {
    const raw = "x".repeat(1024 * 1024);
    const input = file("main", "large.yaml", `value: ${raw}\n`);
    let failure;
    try {
      await plan_transaction(
        request(
          [input],
          [
            {
              id: "bind-large",
              type: "bind",
              file: "main",
              selector: { version: 1, path: [{ mapping_key: "value" }] },
              handle: "large",
              preconditions: { raw: "different" },
            },
          ],
        ),
        options([input]),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "PRECONDITION_FAILED",
      details: {
        scope: "operation",
        expected: {
          raw: "different",
          raw_digest: sha256_digest(Buffer.from("different")),
          size_bytes: Buffer.byteLength("different"),
          truncated: false,
        },
        actual: {
          raw: expect.any(String),
          raw_digest: sha256_digest(Buffer.from(raw)),
          size_bytes: Buffer.byteLength(raw),
          truncated: true,
        },
        operation_id: "bind-large",
        field: "raw",
      },
    });
    expect(Buffer.byteLength(JSON.stringify(failure.details))).toBeLessThan(
      16 * 1024,
    );
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

  it("tracks an identical sibling handle across subtree deletion", async () => {
    const input = file(
      "main",
      "config.yaml",
      "items:\n  - name: duplicate\n  - name: duplicate\n  - name: duplicate\n",
    );
    const result = await plan_transaction(
      request(
        [input],
        [
          {
            id: "bind-second",
            type: "bind",
            file: "main",
            selector: {
              version: 1,
              path: [{ mapping_key: "items" }, { sequence_index: 1 }],
            },
            handle: "second",
          },
          {
            id: "delete-first",
            type: "delete_subtree",
            source: {
              file: "main",
              selector: {
                version: 1,
                path: [{ mapping_key: "items" }, { sequence_index: 0 }],
              },
            },
          },
          {
            id: "edit-second",
            type: "replace_scalar_raw",
            target: { handle: "second", path: [{ mapping_key: "name" }] },
            raw: "tracked",
          },
        ],
      ),
      options([input]),
    );

    expect(result.candidates.main.buffer.toString()).toBe(
      "items:\n  - name: tracked\n  - name: duplicate\n",
    );
  });

  it("tracks an identical handle through a sequence swap", async () => {
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
            id: "swap-identical",
            type: "swap_sequence_items",
            file: "main",
            target: {
              selector: { version: 1, path: [{ mapping_key: "items" }] },
            },
            left_index: 0,
            right_index: 1,
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

  it("tracks an identical handle through a sequence move", async () => {
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
            id: "move-identical",
            type: "move_sequence_item",
            file: "main",
            target: {
              selector: { version: 1, path: [{ mapping_key: "items" }] },
            },
            index: 0,
            position: { kind: "append" },
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

  it("enforces selected profile rules before the next operation", async () => {
    const input = file(
      "main",
      "config.yaml",
      "records:\n  - key: one\n    other: keep\n",
    );
    const profile = per_operation_profile(["record.fields.key.required"]);

    await expect(
      plan_transaction(
        request(
          [input],
          [
            {
              id: "remove-key",
              type: "delete_mapping_pair",
              file: "main",
              target: {
                selector: {
                  version: 1,
                  path: [{ mapping_key: "records" }, { sequence_index: 0 }],
                },
              },
              pair: { index: 0 },
            },
            {
              id: "restore-key",
              type: "add_mapping_pair",
              file: "main",
              target: {
                selector: {
                  version: 1,
                  path: [{ mapping_key: "records" }, { sequence_index: 0 }],
                },
              },
              key: "key",
              value: "one",
            },
          ],
        ),
        options([input], { profile }),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: expect.objectContaining({
        operation_id: "restore-key",
        operation_index: 1,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ rule_id: "record.fields.key.required" }),
        ]),
      }),
    });
  });

  it("allows an unselected profile violation to be restored before final validation", async () => {
    const input = file(
      "main",
      "config.yaml",
      "records:\n  - key: one\n    other: keep\n",
    );
    const profile = per_operation_profile(["record.fields.key.type"]);
    const result = await plan_transaction(
      request(
        [input],
        [
          {
            id: "remove-key",
            type: "delete_mapping_pair",
            file: "main",
            target: {
              selector: {
                version: 1,
                path: [{ mapping_key: "records" }, { sequence_index: 0 }],
              },
            },
            pair: { index: 0 },
          },
          {
            id: "restore-key",
            type: "add_mapping_pair",
            file: "main",
            target: {
              selector: {
                version: 1,
                path: [{ mapping_key: "records" }, { sequence_index: 0 }],
              },
            },
            key: "key",
            value: "one",
          },
        ],
      ),
      options([input], { profile }),
    );

    expect(result.validation.diagnostics).toEqual([]);
    expect(result.candidates.main.buffer.toString()).toContain("key: one");
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

  it("binds profile preconditions to the supplied profile object before source I/O", async () => {
    const input = file("main", "config.yaml", "records:\n  - key: one\n");
    const profile = per_operation_profile([]);
    const fake_digest = "f".repeat(64);
    const load_source = vi.fn(async () => input.source);

    await expect(
      plan_transaction(
        request([input], [], {
          preconditions: { profile_digest: fake_digest },
        }),
        options([], {
          profile,
          profile_digest: fake_digest,
          load_source,
        }),
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      details: expect.objectContaining({ field: "profile_digest" }),
    });
    expect(load_source).not.toHaveBeenCalled();

    const digest_only = "d".repeat(64);
    const digest_only_result = await plan_transaction(
      request([input], [], {
        preconditions: { profile_digest: digest_only },
      }),
      options([input], { profile_digest: digest_only }),
    );
    expect(digest_only_result.validation.profile_digest).toBe(digest_only);
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
