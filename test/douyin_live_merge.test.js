import { execFile } from "node:child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it, expect } from "vitest";

const cli_entry = path.resolve(__dirname, "../bin/douyin_live_merge");

function run_cli(args) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli_entry, ...args],
      {
        env: { ...process.env, FORCE_COLOR: "0" },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && error.code !== 0) {
          const exec_error = new Error(stderr || error.message);
          exec_error.stdout = stdout;
          exec_error.stderr = stderr;
          exec_error.exitCode = error.code || 1;
          reject(exec_error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function create_temp_dir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "douyin-live-merge-"));
}

async function path_exists(file_path) {
  try {
    await fs.access(file_path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

describe("douyin_live_merge CLI", () => {
  it("copies files recursively", async () => {
    const temp_root = await create_temp_dir();
    const source_dir = path.join(temp_root, "source");
    const nested_dir = path.join(source_dir, "nested");
    const destination_dir = path.join(temp_root, "dest");
    const source_file = path.join(nested_dir, "clip.txt");

    await fs.mkdir(nested_dir, { recursive: true });
    await fs.writeFile(source_file, "hello", "utf8");

    try {
      await run_cli(["--source", source_dir, "--destination", destination_dir]);
      const destination_file = path.join(
        destination_dir,
        "nested",
        "clip.txt",
      );
      const exists = await path_exists(destination_file);
      expect(exists).toBe(true);
      const content = await fs.readFile(destination_file, "utf8");
      expect(content).toBe("hello");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("skips existing files unless refresh is enabled", async () => {
    const temp_root = await create_temp_dir();
    const source_dir = path.join(temp_root, "source");
    const destination_dir = path.join(temp_root, "dest");
    const source_file = path.join(source_dir, "video.txt");
    const destination_file = path.join(destination_dir, "video.txt");

    await fs.mkdir(source_dir, { recursive: true });
    await fs.mkdir(destination_dir, { recursive: true });
    await fs.writeFile(source_file, "new", "utf8");
    await fs.writeFile(destination_file, "old", "utf8");

    try {
      await run_cli([
        "--source",
        source_file,
        "--destination",
        destination_dir,
      ]);
      const content = await fs.readFile(destination_file, "utf8");
      expect(content).toBe("old");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("overwrites existing files with --refresh", async () => {
    const temp_root = await create_temp_dir();
    const source_dir = path.join(temp_root, "source");
    const destination_dir = path.join(temp_root, "dest");
    const source_file = path.join(source_dir, "video.txt");
    const destination_file = path.join(destination_dir, "video.txt");

    await fs.mkdir(source_dir, { recursive: true });
    await fs.mkdir(destination_dir, { recursive: true });
    await fs.writeFile(source_file, "new", "utf8");
    await fs.writeFile(destination_file, "old", "utf8");

    try {
      await run_cli([
        "--source",
        source_file,
        "--destination",
        destination_dir,
        "--refresh",
      ]);
      const content = await fs.readFile(destination_file, "utf8");
      expect(content).toBe("new");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("does not copy files in dry-run mode", async () => {
    const temp_root = await create_temp_dir();
    const source_dir = path.join(temp_root, "source");
    const destination_dir = path.join(temp_root, "dest");
    const source_file = path.join(source_dir, "video.txt");
    const destination_file = path.join(destination_dir, "video.txt");

    await fs.mkdir(source_dir, { recursive: true });
    await fs.writeFile(source_file, "new", "utf8");

    try {
      await run_cli([
        "--source",
        source_file,
        "--destination",
        destination_dir,
        "--dry-run",
      ]);
      const exists = await path_exists(destination_file);
      expect(exists).toBe(false);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
