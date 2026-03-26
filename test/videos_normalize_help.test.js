import { execFile } from "node:child_process";
import path from "path";
import { describe, expect, it } from "vitest";

const cli_entry = path.resolve(__dirname, "../bin/videos_normalize");

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

describe("videos_normalize help", () => {
  it("shows vtt as the default transcript format", async () => {
    const result = await run_cli(["--help"]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toMatch(
      /--transcript-format FORMAT\s+Transcript format\(s\), repeat or comma-separated \(default: vtt\)/,
    );
  });

  it("defaults transcript provider to whisper for the CLI", async () => {
    const result = await run_cli(["--help"], {
      env: {
        VIDEOS_NORMALIZE_TRANSCRIPT_PROVIDER: "",
        TRANSCRIPT_DEFAULT_PROVIDER: "",
      },
    });

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toMatch(
      /--transcript-provider NAME\s+Provider \(default: whisper; supported: qwen3_asr, sensevoice, whisper\)/,
    );
  });

  it("honors an explicit transcript provider override from the environment", async () => {
    const result = await run_cli(["--help"], {
      env: {
        VIDEOS_NORMALIZE_TRANSCRIPT_PROVIDER: "qwen3_asr",
      },
    });

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toMatch(
      /--transcript-provider NAME\s+Provider \(default: qwen3_asr; supported: qwen3_asr, sensevoice, whisper\)/,
    );
  });
});
