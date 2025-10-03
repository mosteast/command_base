import { execFile } from "node:child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it, expect } from "vitest";

const cli_entry = path.resolve(__dirname, "../bin/json2yaml");

function run_cli(args, { stdin_text = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
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

        resolve({
          stdout,
          stderr,
          exit_code: error ? error.code || 0 : 0,
        });
      },
    );

    if (stdin_text) {
      child.stdin.end(stdin_text);
    } else {
      child.stdin.end();
    }
  });
}

async function create_temp_dir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "json2yaml-test-"));
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

describe("json2yaml CLI", () => {
  it("converts JSON from stdin to YAML output", async () => {
    const payload = JSON.stringify({ user: { name: "alice", age: 33 } });
    const result = await run_cli([], { stdin_text: payload });

    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toContain("user:");
    expect(result.stdout).toContain("name: alice");
    expect(result.stdout).toContain("age: 33");
  });

  it("writes converted files to the requested directory", async () => {
    const temp_root = await create_temp_dir();
    const input_dir = path.join(temp_root, "input");
    const output_dir = path.join(temp_root, "output");
    await fs.mkdir(input_dir, { recursive: true });

    const input_file = path.join(input_dir, "config.json");
    await fs.writeFile(
      input_file,
      JSON.stringify({ service: { replicas: 3, debug: false } }),
      "utf8",
    );

    try {
      const result = await run_cli([input_file, "--out", output_dir]);

      expect(result.exit_code).toBe(0);

      const output_file = path.join(output_dir, "config.yaml");
      const output_content = await fs.readFile(output_file, "utf8");
      expect(output_content).toContain("service:");
      expect(output_content).toContain("replicas: 3");
      expect(output_content).toContain("debug: false");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("respects dry-run mode by not writing files", async () => {
    const temp_root = await create_temp_dir();
    const input_file = path.join(temp_root, "metrics.json");
    const output_dir = path.join(temp_root, "artifacts");

    await fs.writeFile(input_file, JSON.stringify({ status: "ok" }), "utf8");

    try {
      const result = await run_cli([
        input_file,
        "--out",
        output_dir,
        "--dry-run",
      ]);

      expect(result.exit_code).toBe(0);

      const output_file = path.join(output_dir, "metrics.yaml");
      const exists = await path_exists(output_file);
      expect(exists).toBe(false);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
