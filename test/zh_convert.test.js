import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const cli_entry = path.resolve(__dirname, "../bin/zh_convert");
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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zh-convert-"));
  temporary_directories.push(directory);
  return directory;
}

async function path_exists(file_path) {
  try {
    await fs.access(file_path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    temporary_directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("zh_convert CLI", () => {
  it("prints the version number only", async () => {
    const result = await run_cli(["--version"]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("1.0.1\n");
    expect(result.stderr).toBe("");
  });

  it("documents direction and refresh options in help output", async () => {
    const result = await run_cli(["--help"]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("--to-hans");
    expect(result.stdout).toContain("--to-hant");
    expect(result.stdout).toContain("--refresh");
  });

  it("fails on unknown options", async () => {
    await expect(run_cli(["--bad-option"])).rejects.toMatchObject({
      exit_code: 1,
      stderr: expect.stringContaining("Unknown arguments: bad-option"),
    });
  });

  it("converts traditional text into a sibling simplified file by default", async () => {
    const directory = await create_temp_directory();
    const input_file = path.join(directory, "note.txt");
    const output_file = path.join(directory, "note.zh-Hans.txt");

    await fs.writeFile(input_file, "開發後門\n", "utf8");

    const result = await run_cli([input_file]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("Converted:");
    expect(await fs.readFile(output_file, "utf8")).toBe("开发后门\n");
  });

  it("skips generated same-direction inputs without creating doubled suffix files", async () => {
    const directory = await create_temp_directory();
    const input_file = path.join(directory, "note.zh-Hans.txt");
    const unexpected_output = path.join(directory, "note.zh-Hans.zh-Hans.txt");

    await fs.writeFile(input_file, "开发后门\n", "utf8");

    const result = await run_cli([input_file]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("Skipped:");
    expect(await path_exists(unexpected_output)).toBe(false);
  });

  it("replaces generated suffixes and overwrites existing targets only with refresh", async () => {
    const directory = await create_temp_directory();
    const input_file = path.join(directory, "note.zh-Hans.txt");
    const output_file = path.join(directory, "note.zh-Hant.txt");

    await fs.writeFile(input_file, "开发后门\n", "utf8");
    await fs.writeFile(output_file, "舊內容\n", "utf8");

    const skipped_result = await run_cli(["--to-hant", input_file]);
    expect(skipped_result.exit_code).toBe(0);
    expect(skipped_result.stdout).toContain("Skipped:");
    expect(await fs.readFile(output_file, "utf8")).toBe("舊內容\n");

    const refreshed_result = await run_cli([
      "--to-hant",
      "--refresh",
      input_file,
    ]);
    expect(refreshed_result.exit_code).toBe(0);
    expect(refreshed_result.stdout).toContain("Converted:");
    expect(await fs.readFile(output_file, "utf8")).toBe("開發後門\n");
  });
});
