import { execFile } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const cli_entry = path.resolve(__dirname, "../bin/git_init");
const { parse_args } = require("../lib/git_init/cli");

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

describe("git_init CLI", () => {
  it("prints version only", async () => {
    const result = await run_cli(["-v"]);
    expect(result.stdout.trim()).toBe("1.0.1");
  });

  it("prints help with usage and examples", async () => {
    const result = await run_cli(["-h"]);
    expect(result.stdout).toMatch(/Usage/);
    expect(result.stdout).toMatch(/--force/);
    expect(result.stdout).toMatch(/# Initialize the current directory/);
  });

  it("fails on unknown options", async () => {
    await expect(run_cli(["--nope"])).rejects.toMatchObject({
      exit_code: 1,
    });
  });

  it("parses force, dry-run, and an optional directory", () => {
    expect(parse_args(["--force", "-d", "docs"])).toMatchObject({
      force: true,
      dry_run: true,
      directory: "docs",
      help: false,
      version: false,
    });
  });
});
