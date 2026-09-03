import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { remove_empty_files } = require("../lib/file/remove_empty_file");

async function create_temp_dir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "remove-empty-file-"));
}

describe("remove_empty_files", () => {
  it("removes zero-byte files and keeps non-empty files", async () => {
    const temp_root = await create_temp_dir();
    const nested_dir = path.join(temp_root, "author");
    const empty_path = path.join(nested_dir, "empty.mp4");
    const keep_path = path.join(nested_dir, "keep.mp4");
    const logs = [];
    try {
      await fs.mkdir(nested_dir, { recursive: true });
      await fs.writeFile(empty_path, "");
      await fs.writeFile(keep_path, "video");
      const removed_count = await remove_empty_files(temp_root, {
        debug: (text) => logs.push(text),
      });
      expect(removed_count).toBe(1);
      await expect(fs.stat(empty_path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(keep_path, "utf8")).toBe("video");
      expect(logs.some((line) => line.includes("IO: remove empty file"))).toBe(
        true,
      );
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("returns 0 when the directory does not exist", async () => {
    const missing_dir = path.join(os.tmpdir(), "remove-empty-missing-dir");
    const removed_count = await remove_empty_files(missing_dir, {
      debug: () => {},
    });
    expect(removed_count).toBe(0);
  });
});
