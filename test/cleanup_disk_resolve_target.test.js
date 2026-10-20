import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { resolve_rule } from "../lib/cleanup_disk/resolve_target.js";

describe("cleanup_disk resolve_target", () => {
  it("resolves a path under home and reports size", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-disk-home-"));
    const cache_dir = path.join(home, "Library", "Caches", "JetBrains");
    await fs.mkdir(cache_dir, { recursive: true });
    await fs.writeFile(path.join(cache_dir, "blob.bin"), "x".repeat(2048), "utf8");

    const result = await resolve_rule(
      {
        id: "jetbrains_cache",
        path: "~/Library/Caches/JetBrains",
        kind: "cache",
        risk: "low",
        action: "trash",
        enabled: true,
      },
      { home },
    );

    expect(result.status).toBe("ok");
    expect(result.paths).toEqual([cache_dir]);
    expect(result.size_bytes).toBeGreaterThan(0);
  });

  it("marks missing paths", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-disk-home-"));
    const result = await resolve_rule(
      {
        id: "missing",
        path: "~/nope",
        kind: "cache",
        risk: "low",
        action: "trash",
        enabled: true,
      },
      { home },
    );
    expect(result.status).toBe("missing");
    expect(result.paths).toEqual([]);
  });

  it("skips targets below min_size", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-disk-home-"));
    const cache_dir = path.join(home, "small");
    await fs.mkdir(cache_dir, { recursive: true });
    await fs.writeFile(path.join(cache_dir, "a.txt"), "hi", "utf8");

    const result = await resolve_rule(
      {
        id: "small",
        path: "~/small",
        kind: "cache",
        risk: "low",
        action: "trash",
        min_size: "1G",
        enabled: true,
      },
      { home },
    );

    expect(result.status).toBe("skipped_threshold");
  });

  it("marks delegate rules without path resolution", async () => {
    const result = await resolve_rule(
      {
        id: "dev_cache_bundle",
        kind: "delegate",
        risk: "low",
        action: "delegate",
        delegate_to: "cleanup_dev_cache",
        delegate_args: ["report"],
        enabled: true,
      },
      { home: os.tmpdir() },
    );
    expect(result.status).toBe("delegate");
    expect(result.paths).toEqual([]);
  });

  it("rejects dangerous resolved paths", async () => {
    await expect(
      resolve_rule(
        {
          id: "home",
          path: "~",
          kind: "cache",
          risk: "low",
          action: "trash",
          enabled: true,
        },
        { home: "/Users/hailang" },
      ),
    ).rejects.toThrow(/dangerous path/i);
  });

  it("marks a rule unreadable instead of throwing when measurement fails", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-disk-home-"));
    const locked_dir = path.join(home, "locked");
    await fs.mkdir(locked_dir, { recursive: true });

    try {
      const resolved = await resolve_rule(
        {
          id: "locked",
          path: "~/locked",
          kind: "cache",
          risk: "low",
          action: "delete",
          enabled: true,
        },
        {
          home,
          get_size_bytes: async () => {
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          },
        },
      );

      expect(resolved.status).toBe("unreadable");
      expect(resolved.size_bytes).toBe(0);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
