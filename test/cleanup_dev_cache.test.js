import { execFile } from "node:child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

const cli_entry = path.resolve(__dirname, "../bin/cleanup_dev_cache");

function run_cli(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cli_entry,
      args,
      {
        env: { ...process.env, FORCE_COLOR: "0", ...env },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const exec_error = new Error(stderr || stdout || error.message);
          exec_error.stdout = stdout;
          exec_error.stderr = stderr;
          exec_error.exit_code = error.code ?? 1;
          reject(exec_error);
          return;
        }

        resolve({
          stdout,
          stderr,
          exit_code: 0,
        });
      },
    );
  });
}

async function path_exists(target_path) {
  try {
    await fs.access(target_path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

describe("cleanup_dev_cache CLI", () => {
  it("reports explicit path targets with resolved sizes", async () => {
    const temp_root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cleanup-dev-cache-"),
    );
    const path_target = path.join(temp_root, "DerivedData");
    await fs.mkdir(path_target, { recursive: true });
    await fs.writeFile(path.join(path_target, "artifact.txt"), "artifact", "utf8");

    try {
      const result = await run_cli(["report", "--path", path_target]);

      expect(result.stdout).toContain("Resolved targets:");
      expect(result.stdout).toContain(path_target);
      expect(result.stdout).toContain("source=path");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("uses dry-run cleanup without mutating the target directory", async () => {
    const temp_root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cleanup-dev-cache-"),
    );
    const trash_root = path.join(temp_root, "trash");
    const cache_dir = path.join(temp_root, "metro-cache");
    await fs.mkdir(cache_dir, { recursive: true });
    await fs.writeFile(path.join(cache_dir, "bundle.js"), "cache", "utf8");

    try {
      const result = await run_cli(
        ["clean", "--path", cache_dir, "--dry-run", "--yes"],
        { env: { COMMAND_BASE_TRASH_DIR: trash_root } },
      );

      expect(result.stdout).toContain("Dry run:");
      expect(await path_exists(cache_dir)).toBe(true);
      expect(await path_exists(trash_root)).toBe(false);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("moves a custom path target to Trash by default", async () => {
    const temp_root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cleanup-dev-cache-"),
    );
    const trash_root = path.join(temp_root, "trash");
    const cache_dir = path.join(temp_root, "jest_dx");
    await fs.mkdir(cache_dir, { recursive: true });
    await fs.writeFile(path.join(cache_dir, "state.json"), "state", "utf8");

    try {
      const result = await run_cli(["clean", "--path", cache_dir, "--yes"], {
        env: { COMMAND_BASE_TRASH_DIR: trash_root },
      });

      expect(result.stdout).toContain("trashed:");
      expect(await path_exists(cache_dir)).toBe(false);
      expect(await path_exists(path.join(trash_root, "jest_dx"))).toBe(true);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("rejects dangerous paths before mutation", async () => {
    await expect(
      run_cli(["clean", "--path", os.homedir(), "--yes"]),
    ).rejects.toMatchObject({ exit_code: 1 });
  });

  it("fails on unknown profile names", async () => {
    await expect(
      run_cli(["report", "--profile", "unknown_profile"]),
    ).rejects.toMatchObject({ exit_code: 1 });
  });
});
