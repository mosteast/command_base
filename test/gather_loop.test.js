import { execFile } from "node:child_process";
import path from "path";
import { describe, expect, it } from "vitest";

const cli_entry = path.resolve(__dirname, "../bin/gather_loop");

function run_cli(args) {
  return new Promise((resolve, reject) => {
    execFile(
      cli_entry,
      args,
      {
        env: { ...process.env, FORCE_COLOR: "0" },
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

describe("gather_loop CLI", () => {
  it("forwards gather options without requiring --", async () => {
    const result = await run_cli(["--dry-run", "--skip", "comment"]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("Dry run");
    expect(result.stdout).toContain("gather --skip comment");
  });

  it("forwards shared quiet and debug flags to gather", async () => {
    const result = await run_cli(["--dry-run", "--debug", "--quiet"]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("gather --debug --quiet");
  });
});
