import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cli_entry = path.resolve(__dirname, "../bin/f2_compat");

function run_cli(args, env_overrides = {}) {
  return new Promise((resolve) => {
    execFile(
      cli_entry,
      args,
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

describe("f2_compat empty file cleanup", () => {
  it("removes zero-byte files in -p before running upstream f2", async () => {
    const temp_root = await fs.mkdtemp(
      path.join(os.tmpdir(), "f2-compat-empty-"),
    );
    const output_dir = path.join(temp_root, "out");
    const empty_path = path.join(output_dir, "empty.mp4");
    const keep_path = path.join(output_dir, "keep.mp4");
    const upstream_path = path.join(temp_root, "upstream_f2");
    try {
      await fs.mkdir(output_dir, { recursive: true });
      await fs.writeFile(empty_path, "");
      await fs.writeFile(keep_path, "video");
      await fs.writeFile(
        upstream_path,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'output_dir=""',
          'while [ "$#" -gt 0 ]; do',
          '  case "$1" in',
          "    -p)",
          '      output_dir="$2"',
          "      shift 2",
          "      ;;",
          "    *)",
          "      shift",
          "      ;;",
          "  esac",
          "done",
          'if find "$output_dir" -type f -size 0 | grep -q .; then',
          "  exit 92",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        "utf8",
      );
      await fs.chmod(upstream_path, 0o755);

      const result = await run_cli(["x", "-M", "post", "-u", "https://x.com/a", "-p", output_dir], {
        COMMAND_BASE_F2_UPSTREAM: upstream_path,
      });

      expect(result.exit_code).toBe(0);
      await expect(fs.stat(empty_path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(keep_path, "utf8")).toBe("video");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
