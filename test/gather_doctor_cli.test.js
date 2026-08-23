import { execFile } from "node:child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it, expect } from "vitest";

const cli_entry = path.resolve(__dirname, "../bin/gather_doctor");

function run_cli(args, env_overrides = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli_entry, ...args],
      {
        env: { ...process.env, ...env_overrides, FORCE_COLOR: "0" },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exit_code: error ? error.code || 1 : 0,
        });
      },
    );
  });
}

function strip_ansi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

async function create_temp_dir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "gather-doctor-cli-"));
}

describe("gather_doctor CLI", () => {
  it("prints help and version", async () => {
    const help = await run_cli(["--help"]);
    expect(help.exit_code).toBe(0);
    expect(strip_ansi(help.stdout)).toContain("Usage");
    expect(strip_ansi(help.stdout)).toContain("fix");

    const version = await run_cli(["--version"]);
    expect(version.exit_code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("rejects unknown options", async () => {
    const result = await run_cli(["--not-a-real-flag"]);
    expect(result.exit_code).toBe(1);
    expect(strip_ansi(`${result.stdout}\n${result.stderr}`)).toMatch(
      /Unknown argument|not-a-real-flag/i,
    );
  });

  it("dry-run fix does not write runtime", async () => {
    const temp_root = await create_temp_dir();
    const runtime_path = path.join(temp_root, "gather.runtime.yaml");
    const result = await run_cli([
      "fix",
      "--dry-run",
      "--offline",
      "--platform",
      "youtube",
      "--runtime",
      runtime_path,
      "--chrome-profile",
      "__missing_profile__",
    ]);
    expect(result.exit_code).toBe(0);
    const combined = strip_ansi(`${result.stdout}\n${result.stderr}`);
    expect(combined).toMatch(/Dry-run|Fix plan|already ok|Nothing to fix/i);
    await expect(fs.access(runtime_path)).rejects.toBeTruthy();
  });
});
