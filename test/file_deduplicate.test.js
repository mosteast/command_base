import { execFile } from "node:child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it, expect } from "vitest";

const cli_entry = path.resolve(__dirname, "../bin/file_deduplicate");

function run_cli(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli_entry, ...args],
      {
        env: { ...process.env, FORCE_COLOR: "0", ...env },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && error.code !== 0) {
          const exec_error = new Error(stderr || error.message);
          exec_error.stdout = stdout;
          exec_error.stderr = stderr;
          exec_error.exit_code = error.code || 1;
          reject(exec_error);
          return;
        }

        resolve({
          stdout,
          stderr,
          exit_code: error ? error.code || 0 : 0,
        });
      },
    );
  });
}

async function create_temp_dir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "file-deduplicate-test-"));
}

async function create_fake_fclones_bin(temp_root, report_text) {
  const bin_dir = path.join(temp_root, "fake_bin");
  const script_path = path.join(bin_dir, "fclones");
  await fs.mkdir(bin_dir, { recursive: true });
  await fs.writeFile(
    script_path,
    `#!/bin/sh
printf '%s' "$FCLONES_REPORT"
`,
    "utf8",
  );
  await fs.chmod(script_path, 0o755);

  return {
    bin_dir,
    report_text,
  };
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

describe("file_deduplicate CLI", () => {
  it("keeps the oldest file and moves newer duplicates to Trash by default", async () => {
    const temp_root = await create_temp_dir();
    const scan_dir = path.join(temp_root, "scan");
    const trash_dir = path.join(temp_root, "trash");
    await fs.mkdir(scan_dir, { recursive: true });
    await fs.mkdir(trash_dir, { recursive: true });

    const oldest_file = path.join(scan_dir, "alpha.txt");
    const newest_file = path.join(scan_dir, "beta.txt");
    await fs.writeFile(oldest_file, "same-content", "utf8");
    await fs.writeFile(newest_file, "same-content", "utf8");
    await fs.utimes(oldest_file, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
    await fs.utimes(newest_file, new Date("2024-01-01T00:00:00.000Z"), new Date("2024-01-01T00:00:00.000Z"));

    const report_text = [
      "# Report by fclones 0.35.0",
      "duplicate-group, 12 B (12 B) * 2:",
      `    ${oldest_file}`,
      `    ${newest_file}`,
      "",
    ].join("\n");

    try {
      const fake_fclones = await create_fake_fclones_bin(temp_root, report_text);
      const result = await run_cli([scan_dir, "--trash-dir", trash_dir], {
        env: {
          PATH: `${fake_fclones.bin_dir}:${process.env.PATH || ""}`,
          FCLONES_REPORT: fake_fclones.report_text,
        },
      });

      expect(result.exit_code).toBe(0);
      expect(await path_exists(oldest_file)).toBe(true);
      expect(await path_exists(newest_file)).toBe(false);
      expect(await path_exists(path.join(trash_dir, "beta.txt"))).toBe(true);
      expect(result.stdout).toContain("Found 1 duplicate group");
      expect(result.stdout).toContain("moved to Trash: 1");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("respects dry-run mode and leaves duplicate files untouched", async () => {
    const temp_root = await create_temp_dir();
    const scan_dir = path.join(temp_root, "scan");
    const trash_dir = path.join(temp_root, "trash");
    await fs.mkdir(scan_dir, { recursive: true });
    await fs.mkdir(trash_dir, { recursive: true });

    const first_file = path.join(scan_dir, "one.txt");
    const second_file = path.join(scan_dir, "two.txt");
    await fs.writeFile(first_file, "same-content", "utf8");
    await fs.writeFile(second_file, "same-content", "utf8");
    await fs.utimes(first_file, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
    await fs.utimes(second_file, new Date("2024-01-01T00:00:00.000Z"), new Date("2024-01-01T00:00:00.000Z"));

    const report_text = [
      "# Report by fclones 0.35.0",
      "duplicate-group, 12 B (12 B) * 2:",
      `    ${first_file}`,
      `    ${second_file}`,
      "",
    ].join("\n");

    try {
      const fake_fclones = await create_fake_fclones_bin(temp_root, report_text);
      const result = await run_cli(
        [scan_dir, "--trash-dir", trash_dir, "--dry-run"],
        {
          env: {
            PATH: `${fake_fclones.bin_dir}:${process.env.PATH || ""}`,
            FCLONES_REPORT: fake_fclones.report_text,
          },
        },
      );

      expect(result.exit_code).toBe(0);
      expect(await path_exists(first_file)).toBe(true);
      expect(await path_exists(second_file)).toBe(true);
      expect(await fs.readdir(trash_dir)).toEqual([]);
      expect(result.stdout).toContain("Dry run: move to Trash");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("prints a helpful error when fclones is unavailable", async () => {
    const temp_root = await create_temp_dir();

    try {
      await expect(
        run_cli([temp_root], {
          env: {
            PATH: temp_root,
          },
        }),
      ).rejects.toThrow(/Install fclones first/);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
