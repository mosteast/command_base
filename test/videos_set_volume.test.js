import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const cli_entry = path.resolve(__dirname, "../bin/videos_set_volume");
const temporary_directories = [];

function run_cli(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli_entry, ...args],
      {
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          ...env,
        },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && error.code !== 0) {
          const exec_error = new Error(stderr || stdout || error.message);
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

async function create_temp_directory() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "videos-set-volume-"),
  );
  temporary_directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporary_directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("videos_set_volume cli", () => {
  it("prints the version number only", async () => {
    const result = await run_cli(["--version"]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("1.0.1\n");
    expect(result.stderr).toBe("");
  });

  it("documents volume, refresh, and dry-run options in help output", async () => {
    const result = await run_cli(["--help"]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("--volume VALUE");
    expect(result.stdout).toContain("--refresh");
    expect(result.stdout).toContain("--dry-run");
  });

  it("fails on unknown options", async () => {
    await expect(run_cli(["--bad-option"])).rejects.toMatchObject({
      exit_code: 1,
      stderr: expect.stringContaining("Unknown arguments: bad-option"),
    });
  });

  it("expands glob patterns case-insensitively and skips generated outputs during dry-run", async () => {
    const directory = await create_temp_directory();
    const input_directory = path.join(directory, "folder with spaces");
    await fs.mkdir(input_directory, { recursive: true });
    await fs.writeFile(path.join(input_directory, "alpha clip.mp4"), "");
    await fs.writeFile(path.join(input_directory, "beta clip.MP4"), "");
    await fs.writeFile(
      path.join(input_directory, "alpha clip.volume_150pct.mp4"),
      "",
    );

    const result = await run_cli([
      "--dry-run",
      "--volume",
      "150%",
      path.join(input_directory, "*.mp4"),
    ]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("PLAN beta clip.MP4");
    expect(result.stdout).toContain("SKIP alpha clip.volume_150pct.mp4");
    expect(result.stdout).toContain("SKIP alpha clip.mp4");
    expect(result.stdout).toContain("volume=1.5");
  });
});
