import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { execute_clean, plan_clean } from "../lib/cleanup_disk/clean.js";

async function path_exists(target_path) {
  try {
    await fs.access(target_path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

describe("cleanup_disk clean", () => {
  it("drops report actions from the plan", () => {
    const plan = plan_clean([
      {
        rule: { id: "a", action: "report", risk: "high" },
        paths: ["/tmp/a"],
        status: "ok",
        size_bytes: 10,
      },
      {
        rule: { id: "b", action: "trash", risk: "low" },
        paths: ["/tmp/b"],
        status: "ok",
        size_bytes: 20,
      },
    ]);
    expect(plan.map((item) => item.rule.id)).toEqual(["b"]);
  });

  it("plans without mutating when yes is false", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-disk-clean-"));
    const target = path.join(root, "cache");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "x"), "x", "utf8");

    const plan = plan_clean([
      {
        rule: { id: "cache", action: "trash", risk: "low" },
        paths: [target],
        status: "ok",
        size_bytes: 1,
      },
    ]);

    const result = await execute_clean(plan, {
      yes: false,
      dry_run: false,
      home: root,
    });

    expect(result.results.every((row) => row.status === "planned")).toBe(true);
    expect(await path_exists(target)).toBe(true);
  });

  it("moves targets to trash when yes is true", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-disk-clean-"));
    const trash_root = path.join(root, "trash");
    const target = path.join(root, "cache");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "x"), "x", "utf8");

    const plan = plan_clean([
      {
        rule: { id: "cache", action: "trash", risk: "low" },
        paths: [target],
        status: "ok",
        size_bytes: 1,
      },
    ]);

    const result = await execute_clean(plan, {
      yes: true,
      dry_run: false,
      home: root,
      trash_dir: trash_root,
    });

    expect(result.results[0].status).toBe("trashed");
    expect(await path_exists(target)).toBe(false);
    expect(await path_exists(trash_root)).toBe(true);
  });
});
