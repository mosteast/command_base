import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec_file = promisify(execFile);
const repo_root = path.resolve(import.meta.dirname, "..");

function strip_ansi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

describe("g commit message logging", () => {
  it("prints the selected commit message in a padded block", async () => {
    const tmp_dir = await mkdtemp(
      path.join(os.tmpdir(), "command-base-g-log-repo-"),
    );
    const remote_dir = await mkdtemp(
      path.join(os.tmpdir(), "command-base-g-log-remote-"),
    );

    try {
      await exec_file("git", ["init", "-b", "main"], { cwd: tmp_dir });
      await exec_file("git", ["config", "user.email", "test@example.com"], {
        cwd: tmp_dir,
      });
      await exec_file("git", ["config", "user.name", "Test"], {
        cwd: tmp_dir,
      });

      await writeFile(path.join(tmp_dir, "file.txt"), "base\n", "utf8");
      await exec_file("git", ["add", "file.txt"], { cwd: tmp_dir });
      await exec_file("git", ["commit", "-m", "init"], { cwd: tmp_dir });

      await exec_file("git", ["init", "--bare", remote_dir]);
      await exec_file("git", ["remote", "add", "origin", remote_dir], {
        cwd: tmp_dir,
      });
      await exec_file("git", ["push", "-u", "origin", "main"], {
        cwd: tmp_dir,
      });

      await writeFile(path.join(tmp_dir, "file.txt"), "base\nnext\n", "utf8");

      const result = await exec_file(
        "bash",
        [path.join(repo_root, "bin/g"), "Refine log output"],
        {
          cwd: tmp_dir,
          maxBuffer: 1024 * 1024,
        },
      );
      const stderr = strip_ansi(result.stderr);

      expect(stderr).toContain("[INFO] Using commit message:");
      expect(stderr).toContain("\n\n  Refine log output\n\n");
    } finally {
      await rm(tmp_dir, { recursive: true, force: true });
      await rm(remote_dir, { recursive: true, force: true });
    }
  });
});
