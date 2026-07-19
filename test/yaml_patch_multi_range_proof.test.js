import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import diff_module from "../lib/yaml_patch/diff";
import proof_module from "../lib/yaml_patch/proof";
import range_set_module from "../lib/yaml_patch/range_set";
import source_module from "../lib/yaml_patch/source";

const {
  apply_range_set,
  apply_snapshot_splices,
  create_multi_range_byte_proof,
  create_piece_table,
  create_transaction_proof,
  materialize_piece_table,
  original_ranges_from_pieces,
  validate_byte_proof,
} = range_set_module;
const { sha256_digest } = source_module;
const { create_byte_proof } = proof_module;
const { create_file_diff } = diff_module;
const public_api = createRequire(import.meta.url)("../lib/yaml_patch");

function splice(
  start_byte,
  end_byte,
  replacement,
  operation_id,
  operation_order,
) {
  return {
    start_byte,
    end_byte,
    replacement_buffer: Buffer.from(replacement),
    operation_id,
    ...(operation_order === undefined ? {} : { operation_order }),
  };
}

describe("YAML multi-range splice and byte proof", () => {
  it("publishes every named range/proof API", () => {
    for (const name of [
      "apply_range_set",
      "apply_snapshot_splices",
      "create_multi_range_byte_proof",
      "create_piece_table",
      "create_transaction_proof",
      "materialize_piece_table",
      "original_ranges_from_pieces",
      "validate_byte_proof",
    ]) {
      expect(public_api[name], name).toBeTypeOf("function");
    }
  });

  it("applies disjoint replace and insert splices with three unchanged regions", () => {
    const original = Buffer.from("abcdefgh");
    const result = apply_range_set(original, [
      splice(2, 3, "X", "replace-c", 0),
      splice(7, 7, "Y", "insert-y", 1),
    ]);

    expect(result.candidate_buffer.toString()).toBe("abXdefgYh");
    expect(result.proof).toMatchObject({
      format: "yaml_patch-byte-proof",
      version: 2,
      verified: true,
      no_op: false,
      original_digest: sha256_digest(original),
      candidate_digest: sha256_digest(result.candidate_buffer),
      summary: {
        deleted_bytes: 1,
        inserted_bytes: 2,
        touched_bytes: 3,
        size_delta: 1,
      },
    });
    expect(result.proof.ranges).toHaveLength(2);
    expect(result.proof.unchanged_regions).toHaveLength(3);
    expect(result.proof.ranges[0]).toMatchObject({
      original_start_byte: 2,
      original_end_byte: 3,
      candidate_start_byte: 2,
      candidate_end_byte: 3,
      operation_ids: ["replace-c"],
    });
    expect(result.proof.ranges[1]).toMatchObject({
      original_start_byte: 7,
      original_end_byte: 7,
      candidate_start_byte: 7,
      candidate_end_byte: 8,
      operation_ids: ["insert-y"],
    });
    expect(result.proof.operations).toEqual([
      expect.objectContaining({
        operation_id: "replace-c",
        final_ranges: [expect.objectContaining({ original_start_byte: 2 })],
      }),
      expect.objectContaining({
        operation_id: "insert-y",
        final_ranges: [expect.objectContaining({ original_start_byte: 7 })],
      }),
    ]);
  });

  it("supports adjacent replacements, insertions, and deletions", () => {
    const result = apply_range_set(Buffer.from("0123456789"), [
      splice(1, 3, "A", "replace", 0),
      splice(3, 5, "", "delete", 1),
      splice(5, 5, "BC", "insert", 2),
    ]);
    expect(result.candidate_buffer.toString()).toBe("0ABC56789");
    expect(result.proof.ranges).toHaveLength(1);
    expect(result.proof.ranges[0]).toMatchObject({
      original_start_byte: 1,
      original_end_byte: 5,
      candidate_start_byte: 1,
      candidate_end_byte: 4,
      operation_ids: ["replace", "delete", "insert"],
    });
  });

  it("requires explicit unique order for insertions at the same offset", () => {
    const original = Buffer.from("ab");
    expect(() =>
      apply_range_set(original, [
        splice(1, 1, "X", "x"),
        splice(1, 1, "Y", "y"),
      ]),
    ).toThrowError(expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }));
    expect(() =>
      apply_range_set(original, [
        splice(1, 1, "X", "x", 0),
        splice(1, 1, "Y", "y", 0),
      ]),
    ).toThrowError(expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }));

    const ordered = apply_range_set(original, [
      splice(1, 1, "Y", "y", 1),
      splice(1, 1, "X", "x", 0),
    ]);
    expect(ordered.candidate_buffer.toString()).toBe("aXYb");
    expect(ordered.proof.ranges[0].operation_ids).toEqual(["x", "y"]);
  });

  it("rejects overlap, crossing, ambiguous same-start edits, and invalid bounds", () => {
    const original = Buffer.from("abcdef");
    const invalid_sets = [
      [splice(1, 4, "X", "a", 0), splice(3, 5, "Y", "b", 1)],
      [splice(2, 4, "X", "a", 0), splice(2, 3, "Y", "b", 1)],
      [splice(2, 4, "X", "a", 0), splice(2, 2, "Y", "b", 1)],
      [splice(-1, 0, "X", "a", 0)],
      [splice(3, 2, "X", "a", 0)],
      [splice(0, 7, "X", "a", 0)],
      [splice(0, 1, "X", "same", 0), splice(4, 5, "Y", "same", 1)],
    ];
    for (const splices of invalid_sets) {
      expect(() => apply_range_set(original, splices)).toThrowError(
        expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }),
      );
    }
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error("proxy trap must not execute");
        },
      },
    );
    expect(() => apply_range_set(original, [proxy])).toThrowError(
      expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }),
    );
  });

  it("resolves each call against the current snapshot without mutating prior tables", () => {
    const first = create_piece_table(Buffer.from("abcdef"));
    const second = apply_snapshot_splices(first, [
      splice(1, 3, "XYZ", "z-first"),
    ]);
    const third = apply_snapshot_splices(second, [
      splice(4, 5, "!", "a-second"),
    ]);

    expect(materialize_piece_table(first).toString()).toBe("abcdef");
    expect(materialize_piece_table(second).toString()).toBe("aXYZdef");
    expect(materialize_piece_table(third).toString()).toBe("aXYZ!ef");
    expect(original_ranges_from_pieces(third).ranges).toEqual([
      expect.objectContaining({ operation_ids: ["z-first", "a-second"] }),
    ]);
    expect(() =>
      apply_snapshot_splices(second, [splice(5, 6, "!", "z-first", 1)]),
    ).toThrowError(expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }));
  });

  it("normalizes a byte-identical final candidate to a full-file no-op proof", () => {
    const original = Buffer.from("value: old\n");
    const changed = apply_snapshot_splices(create_piece_table(original), [
      splice(7, 10, "new", "change", 0),
    ]);
    const restored = apply_snapshot_splices(changed, [
      splice(7, 10, "old", "restore", 0),
    ]);
    const candidate = materialize_piece_table(restored);
    const proof = create_multi_range_byte_proof(original, candidate, restored);

    expect(candidate.equals(original)).toBe(true);
    expect(proof.no_op).toBe(true);
    expect(proof.ranges).toEqual([]);
    expect(proof.unchanged_regions).toEqual([
      expect.objectContaining({
        original_start_byte: 0,
        original_end_byte: original.length,
        candidate_start_byte: 0,
        candidate_end_byte: original.length,
        digest: sha256_digest(original),
      }),
    ]);
    expect(proof.summary).toEqual({
      deleted_bytes: 0,
      inserted_bytes: 0,
      touched_bytes: 0,
      size_delta: 0,
    });
    expect(proof.operations.map((operation) => operation.operation_id)).toEqual(
      ["change", "restore"],
    );
    expect(
      proof.operations.every(
        (operation) => operation.present_in_final === false,
      ),
    ).toBe(true);
  });

  it("accepts a valid legacy v1 empty insertion no-op proof", () => {
    const original = Buffer.alloc(0);
    const proof = create_byte_proof(original, original, {
      start_byte: 0,
      end_byte: 0,
      replacement_buffer: Buffer.alloc(0),
    });

    expect(proof).toMatchObject({
      version: 1,
      verified: true,
      no_op: true,
      ranges: [
        expect.objectContaining({
          original_start_byte: 0,
          original_end_byte: 0,
          candidate_start_byte: 0,
          candidate_end_byte: 0,
        }),
      ],
    });
    expect(() =>
      validate_byte_proof(proof, {
        original_buffer: original,
        candidate_buffer: original,
      }),
    ).not.toThrow();
    expect(() =>
      create_file_diff({
        file_id: "empty",
        original_buffer: original,
        candidate_buffer: original,
        proof,
        operations: [],
      }),
    ).not.toThrow();
  });

  it("rejects operation provenance ranges outside their named root range", () => {
    const original = Buffer.from("value: old\n");
    const result = apply_range_set(original, [
      splice(7, 10, "new", "replace", 0),
    ]);
    const forged = structuredClone(result.proof);
    forged.operations[0].final_ranges = [
      {
        original_start_byte: 999,
        original_end_byte: 1000,
        candidate_start_byte: 999,
        candidate_end_byte: 1000,
      },
    ];

    expect(() =>
      validate_byte_proof(forged, {
        original_buffer: original,
        candidate_buffer: result.candidate_buffer,
      }),
    ).toThrowError(expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }));
  });

  it("rejects out-of-bounds and noncanonical removed original ranges", () => {
    const original = Buffer.from("value: old\n");
    const result = apply_range_set(original, [
      splice(7, 10, "new", "replace", 0),
    ]);
    const out_of_bounds = structuredClone(result.proof);
    out_of_bounds.operations[0].steps[0].removed_original_ranges = [
      { start_byte: 7, end_byte: original.length + 1 },
    ];
    const overlapping = structuredClone(result.proof);
    overlapping.operations[0].steps[0].removed_original_ranges = [
      { start_byte: 8, end_byte: 10 },
      { start_byte: 7, end_byte: 9 },
    ];

    for (const proof of [out_of_bounds, overlapping]) {
      expect(() =>
        validate_byte_proof(proof, {
          original_buffer: original,
          candidate_buffer: result.candidate_buffer,
        }),
      ).toThrowError(
        expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }),
      );
    }
  });

  it("rejects duplicate operation IDs in root range metadata", () => {
    const original = Buffer.from("value: old\n");
    const result = apply_range_set(original, [
      splice(7, 10, "new", "replace", 0),
    ]);
    const forged = structuredClone(result.proof);
    forged.ranges[0].operation_ids = ["replace", "replace"];

    expect(() =>
      validate_byte_proof(forged, {
        original_buffer: original,
        candidate_buffer: result.candidate_buffer,
      }),
    ).toThrowError(expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }));
  });

  it("rejects forged v2 step snapshot bounds", () => {
    const original = Buffer.from("value: old\n");
    const result = apply_range_set(original, [
      splice(7, 10, "new", "replace", 0),
    ]);
    const out_of_bounds = structuredClone(result.proof);
    out_of_bounds.operations[0].steps[0].snapshot_end_byte = 999;

    expect(() =>
      validate_byte_proof(out_of_bounds, {
        original_buffer: original,
        candidate_buffer: result.candidate_buffer,
      }),
    ).toThrowError(expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }));
  });

  it("rejects forged v2 step digests when final ranges are reconstructible", () => {
    const original = Buffer.from("value: old\n");
    const result = apply_range_set(original, [
      splice(7, 10, "new", "replace", 0),
    ]);
    const forged_digests = structuredClone(result.proof);
    forged_digests.operations[0].steps[0].removed_digest = "0".repeat(64);
    forged_digests.operations[0].steps[0].replacement_digest = "0".repeat(64);

    expect(() =>
      validate_byte_proof(forged_digests, {
        original_buffer: original,
        candidate_buffer: result.candidate_buffer,
      }),
    ).toThrowError(expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }));
  });

  it("rejects forged multi-operation step digests with or without buffers", () => {
    const original = Buffer.from("abcdefgh");
    const result = apply_range_set(original, [
      splice(1, 2, "X", "replace-b", 0),
      splice(6, 7, "Y", "replace-g", 1),
    ]);
    const forged_digests = structuredClone(result.proof);
    for (const operation of forged_digests.operations) {
      for (const step of operation.steps) {
        step.removed_digest = "0".repeat(64);
        step.replacement_digest = "0".repeat(64);
      }
    }

    expect(() => validate_byte_proof(forged_digests)).toThrowError(
      expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }),
    );
    expect(() =>
      validate_byte_proof(forged_digests, {
        original_buffer: original,
        candidate_buffer: result.candidate_buffer,
      }),
    ).toThrowError(expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }));
  });

  it("rejects forged shared-root multi-operation step digests with or without buffers", () => {
    const original = Buffer.from("abcdefgh");
    const result = apply_range_set(original, [
      splice(1, 2, "X", "replace-b", 0),
      splice(2, 3, "Y", "replace-c", 1),
    ]);
    expect(result.proof.ranges).toEqual([
      expect.objectContaining({
        operation_ids: ["replace-b", "replace-c"],
      }),
    ]);
    expect(() =>
      validate_byte_proof(result.proof, {
        original_buffer: original,
        candidate_buffer: result.candidate_buffer,
      }),
    ).not.toThrow();
    expect(() => validate_byte_proof(result.proof)).not.toThrow();

    const forged_digests = structuredClone(result.proof);
    for (const operation of forged_digests.operations) {
      for (const step of operation.steps) {
        step.removed_digest = "0".repeat(64);
        step.replacement_digest = "0".repeat(64);
      }
    }

    expect(() => validate_byte_proof(forged_digests)).toThrowError(
      expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }),
    );
    expect(() =>
      validate_byte_proof(forged_digests, {
        original_buffer: original,
        candidate_buffer: result.candidate_buffer,
      }),
    ).toThrowError(expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }));
  });

  it("rejects forged multi-operation snapshot bounds with or without buffers", () => {
    const original = Buffer.from("abcdefgh");
    const result = apply_range_set(original, [
      splice(1, 2, "X", "replace-b", 0),
      splice(6, 7, "Y", "replace-g", 1),
    ]);
    const forged_bounds = structuredClone(result.proof);
    for (const operation of forged_bounds.operations) {
      for (const step of operation.steps) {
        step.snapshot_end_byte = 999999;
      }
    }

    expect(() => validate_byte_proof(forged_bounds)).toThrowError(
      expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }),
    );
    expect(() =>
      validate_byte_proof(forged_bounds, {
        original_buffer: original,
        candidate_buffer: result.candidate_buffer,
      }),
    ).toThrowError(expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }));
  });

  it("accepts valid intermediate snapshots before a lower-offset deletion", () => {
    const original = Buffer.alloc(100, "a");
    let table = create_piece_table(original);
    table = apply_snapshot_splices(table, [
      splice(0, 99, "", "delete-prefix", 0),
    ]);
    table = apply_snapshot_splices(table, [
      splice(0, 1, "b", "replace-final", 1),
    ]);
    const candidate = materialize_piece_table(table);
    const proof = create_multi_range_byte_proof(original, candidate, table);

    expect(() =>
      validate_byte_proof(proof, {
        original_buffer: original,
        candidate_buffer: candidate,
      }),
    ).not.toThrow();
  });

  it("preserves BOM, Unicode, mixed newline, and untouched bytes exactly", () => {
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("中文: 😀\r\nnext: e\u0301\rother: keep\n"),
    ]);
    const target = Buffer.from("😀");
    const start = original.indexOf(target);
    const result = apply_range_set(original, [
      splice(start, start + target.length, "🙂", "emoji", 0),
    ]);
    expect(
      result.candidate_buffer
        .subarray(0, start)
        .equals(original.subarray(0, start)),
    ).toBe(true);
    expect(
      result.candidate_buffer
        .subarray(start + Buffer.byteLength("🙂"))
        .equals(original.subarray(start + target.length)),
    ).toBe(true);
    expect(result.proof.verified).toBe(true);
  });

  it("rejects candidate mutation and piece tables bound to another original", () => {
    const original = Buffer.from("abcdef");
    const table = apply_snapshot_splices(create_piece_table(original), [
      splice(2, 3, "X", "replace", 0),
    ]);
    const candidate = materialize_piece_table(table);
    const mutated = Buffer.from(candidate);
    mutated[0] = 0x7a;
    expect(() =>
      create_multi_range_byte_proof(original, mutated, table),
    ).toThrowError(expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }));
    expect(() =>
      create_multi_range_byte_proof(Buffer.from("ABCDEF"), candidate, table),
    ).toThrowError(expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }));

    const undeclared = create_piece_table(original);
    undeclared.pieces.splice(1, 0, {
      kind: "insert",
      buffer: Buffer.from("Y"),
      anchor_original_byte: original.length,
      operation_ids: [],
    });
    expect(() =>
      create_multi_range_byte_proof(
        original,
        materialize_piece_table(undeclared),
        undeclared,
      ),
    ).toThrowError(expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }));

    const undeclared_delete = create_piece_table(original);
    undeclared_delete.pieces = [
      { kind: "original", original_start_byte: 0, original_end_byte: 2 },
      {
        kind: "original",
        original_start_byte: 3,
        original_end_byte: original.length,
      },
    ];
    expect(() =>
      create_multi_range_byte_proof(
        original,
        materialize_piece_table(undeclared_delete),
        undeclared_delete,
      ),
    ).toThrowError(expect.objectContaining({ code: "BYTE_GUARANTEE_FAILED" }));
  });

  it("binds stable per-file proofs and operation order into a transaction digest", () => {
    const first = apply_range_set(Buffer.from("a: 1\n"), [
      splice(3, 4, "2", "first", 0),
    ]).proof;
    const second = apply_range_set(Buffer.from("b: 3\n"), [
      splice(3, 4, "4", "second", 0),
    ]).proof;
    const forward = create_transaction_proof(
      [
        { source_path: "/repo/b.yaml", proof: second },
        { source_path: "/repo/a.yaml", proof: first },
      ],
      ["first", "second"],
    );
    const reordered_files = create_transaction_proof(
      [
        { source_path: "/repo/a.yaml", proof: first },
        { source_path: "/repo/b.yaml", proof: second },
      ],
      ["first", "second"],
    );
    const reversed_operations = create_transaction_proof(
      [
        { source_path: "/repo/a.yaml", proof: first },
        { source_path: "/repo/b.yaml", proof: second },
      ],
      ["second", "first"],
    );

    expect(forward).toEqual(reordered_files);
    expect(forward).toMatchObject({
      format: "yaml_patch-transaction-proof",
      version: 1,
      verified: true,
      operation_order: ["first", "second"],
      files: [{ source_path: "/repo/a.yaml" }, { source_path: "/repo/b.yaml" }],
      transaction_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(reversed_operations.transaction_digest).not.toBe(
      forward.transaction_digest,
    );
  });
});
