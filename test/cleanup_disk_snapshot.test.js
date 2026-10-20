import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  build_snapshot,
  write_snapshot,
  read_snapshot,
  list_snapshot_files,
  load_baseline,
  diff_snapshots,
  prune_snapshots,
  parse_since,
  format_delta,
} from "../lib/cleanup_disk/snapshot.js";

function resolved(id, target_path, size_bytes, action = "report") {
  return {
    rule: { id, action, risk: "low" },
    paths: [target_path],
    status: "ok",
    size_bytes,
  };
}

describe("cleanup_disk snapshot", () => {
  it("aggregates resolved rules into one item per path", () => {
    const snapshot = build_snapshot({
      resolved_list: [
        resolved("a", "/data/a", 100),
        resolved("b", "/data/b", 250),
        resolved("c", "/data/a", 50),
      ],
      now: Date.parse("2026-10-20T00:00:00Z"),
    });

    expect(snapshot.version).toBe(1);
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.total_bytes).toBe(400);
    expect(snapshot.items[0]).toEqual({
      path: "/data/a",
      rule_id: "a",
      size_bytes: 150,
    });
  });

  it("writes, reads, and prunes snapshot files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-disk-snap-"));
    try {
      for (const day of ["2026-10-01", "2026-10-02", "2026-10-03"]) {
        const snapshot = build_snapshot({
          resolved_list: [resolved("a", "/data/a", 100)],
          now: Date.parse(`${day}T00:00:00Z`),
        });
        await write_snapshot(root, snapshot);
      }

      const files = await list_snapshot_files(root);
      expect(files).toHaveLength(3);

      const loaded = await read_snapshot(files[0]);
      expect(loaded.items[0].path).toBe("/data/a");

      const pruned = await prune_snapshots(root, 2);
      expect(pruned).toHaveLength(1);
      expect(await list_snapshot_files(root)).toHaveLength(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("diffs growth, shrink, and removed paths", () => {
    const previous = {
      version: 1,
      created_at: "2026-09-01T00:00:00Z",
      total_bytes: 1000,
      items: [
        { path: "/data/grow", rule_id: "grow", size_bytes: 100 },
        { path: "/data/shrink", rule_id: "shrink", size_bytes: 400 },
        { path: "/data/gone", rule_id: "gone", size_bytes: 500 },
      ],
    };
    const current = {
      version: 1,
      created_at: "2026-10-01T00:00:00Z",
      total_bytes: 1300,
      items: [
        { path: "/data/grow", rule_id: "grow", size_bytes: 900 },
        { path: "/data/shrink", rule_id: "shrink", size_bytes: 300 },
        { path: "/data/new", rule_id: "new", size_bytes: 100 },
      ],
    };

    const rows = diff_snapshots(previous, current);
    expect(rows[0]).toMatchObject({ path: "/data/grow", delta_bytes: 800 });
    expect(rows.map((row) => row.path)).toContain("/data/new");
    expect(rows.find((row) => row.path === "/data/new").delta_bytes).toBe(100);
    expect(rows.find((row) => row.path === "/data/gone").delta_bytes).toBe(-500);
    expect(rows.find((row) => row.path === "/data/shrink").delta_bytes).toBe(-100);
  });

  it("picks the oldest baseline by default and the newest at or before --since", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-disk-snap-"));
    try {
      for (const day of ["2026-09-01", "2026-09-20", "2026-10-10"]) {
        await write_snapshot(
          root,
          build_snapshot({
            resolved_list: [resolved("a", "/data/a", 100)],
            now: Date.parse(`${day}T00:00:00Z`),
          }),
        );
      }

      const oldest = await load_baseline(root, {});
      expect(oldest.snapshot.created_at).toBe("2026-09-01T00:00:00.000Z");

      const cutoff = Date.parse("2026-10-01T00:00:00Z");
      const cutoff_baseline = await load_baseline(root, { since_ms: cutoff });
      expect(cutoff_baseline.snapshot.created_at).toBe("2026-09-20T00:00:00.000Z");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns null when no snapshot exists yet", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-disk-snap-"));
    try {
      expect(await load_baseline(path.join(root, "missing"), {})).toBe(null);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("parses relative and absolute --since values", () => {
    const now = Date.parse("2026-10-20T00:00:00Z");
    expect(parse_since("30d", now)).toBe(now - 30 * 24 * 60 * 60 * 1000);
    expect(parse_since("2026-09-20", now)).toBe(
      Date.parse("2026-09-20T00:00:00Z"),
    );
    expect(parse_since("", now)).toBe(null);
    expect(() => parse_since("nope", now)).toThrow();
  });

  it("formats signed deltas", () => {
    expect(format_delta(0)).toBe("0B");
    expect(format_delta(-(2 * 1024 ** 3))).toBe("-2.0G");
    expect(format_delta(1536 * 1024 ** 2)).toBe("+1.5G");
  });
});
