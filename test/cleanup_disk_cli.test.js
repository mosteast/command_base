import fs from "fs/promises";
import { execFile } from "node:child_process";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

const cli_entry = path.resolve(__dirname, "../bin/cleanup_disk");

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

async function write_defaults(root, yaml_body) {
  const defaults_path = path.join(root, "defaults.yaml");
  await fs.writeFile(defaults_path, yaml_body, "utf8");
  return defaults_path;
}

describe("cleanup_disk CLI", () => {
  it("prints version only", async () => {
    const result = await run_cli(["-v"]);
    expect(result.stdout.trim()).toBe("1.0.0");
  });

  it("fails on unknown options", async () => {
    await expect(run_cli(["report", "--nope"])).rejects.toMatchObject({
      exit_code: 1,
    });
  });

  it("reports rules from a temp config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-disk-cli-"));
    const home = path.join(root, "home");
    const cache_dir = path.join(home, "Library", "Caches", "JetBrains");
    await fs.mkdir(cache_dir, { recursive: true });
    await fs.writeFile(path.join(cache_dir, "a.bin"), "abc", "utf8");

    const defaults_path = await write_defaults(
      root,
      [
        "version: 1",
        "rule:",
        "  - id: jetbrains_cache",
        '    path: "~/Library/Caches/JetBrains"',
        "    kind: cache",
        "    risk: low",
        "    action: trash",
        "    enabled: true",
      ].join("\n"),
    );

    try {
      const result = await run_cli(["report", "--rule", "jetbrains_cache"], {
        env: {
          HOME: home,
          COMMAND_BASE_CLEANUP_DISK_HOME: home,
          COMMAND_BASE_CLEANUP_DISK_DEFAULTS: defaults_path,
        },
      });
      expect(result.stdout).toContain("jetbrains_cache");
      expect(result.stdout).toContain(cache_dir);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not mutate without --yes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-disk-cli-"));
    const home = path.join(root, "home");
    const cache_dir = path.join(home, "cache");
    await fs.mkdir(cache_dir, { recursive: true });
    await fs.writeFile(path.join(cache_dir, "a.bin"), "abc", "utf8");

    const defaults_path = await write_defaults(
      root,
      [
        "version: 1",
        "rule:",
        "  - id: cache",
        '    path: "~/cache"',
        "    kind: cache",
        "    risk: low",
        "    action: trash",
        "    enabled: true",
      ].join("\n"),
    );

    try {
      const result = await run_cli(
        ["clean", "--risk", "low", "--kind", "cache"],
        {
          env: {
            HOME: home,
            COMMAND_BASE_CLEANUP_DISK_HOME: home,
            COMMAND_BASE_CLEANUP_DISK_DEFAULTS: defaults_path,
          },
        },
      );
      expect(result.stdout).toMatch(/plan|planned/i);
      expect(await path_exists(cache_dir)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("trashes with --yes into COMMAND_BASE_TRASH_DIR", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-disk-cli-"));
    const home = path.join(root, "home");
    const trash_root = path.join(root, "trash");
    const cache_dir = path.join(home, "cache");
    await fs.mkdir(cache_dir, { recursive: true });
    await fs.writeFile(path.join(cache_dir, "a.bin"), "abc", "utf8");

    const defaults_path = await write_defaults(
      root,
      [
        "version: 1",
        "rule:",
        "  - id: cache",
        '    path: "~/cache"',
        "    kind: cache",
        "    risk: low",
        "    action: trash",
        "    enabled: true",
      ].join("\n"),
    );

    try {
      const result = await run_cli(
        ["clean", "--risk", "low", "--kind", "cache", "--yes"],
        {
          env: {
            HOME: home,
            COMMAND_BASE_CLEANUP_DISK_HOME: home,
            COMMAND_BASE_CLEANUP_DISK_DEFAULTS: defaults_path,
            COMMAND_BASE_TRASH_DIR: trash_root,
          },
        },
      );
      expect(result.stdout).toMatch(/trashed/i);
      expect(await path_exists(cache_dir)).toBe(false);
      expect(await path_exists(trash_root)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
