import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec_file = promisify(execFile);
const repo_root = path.resolve(import.meta.dirname, "..");

describe("git AI CLI help", () => {
  it("documents --ai on g and ggg", async () => {
    const g_result = await exec_file("bash", ["bin/g", "--help"]);
    const ggg_result = await exec_file("bash", ["bin/ggg", "--help"]);

    expect(g_result.stdout).toContain("--ai");
    expect(g_result.stdout).toContain("--ai-only");
    expect(g_result.stdout).toContain("--split");
    expect(g_result.stdout).toContain("$0 --ai --split");
    expect(ggg_result.stdout).toContain("--ai");
    expect(ggg_result.stdout).toContain("--ai-only");
    expect(ggg_result.stdout).toContain("--split");
    expect(ggg_result.stdout).toContain("$0 --ai --split");
  });

  it("prints an AI-only preview without creating a commit", async () => {
    const tmp_dir = await mkdtemp(
      path.join(os.tmpdir(), "command-base-ai-only-"),
    );
    const fake_bin_dir = await mkdtemp(
      path.join(os.tmpdir(), "command-base-fake-node-"),
    );
    const fake_node_path = path.join(fake_bin_dir, "node");

    try {
      await writeFile(
        fake_node_path,
        '#!/usr/bin/env bash\nprintf "Preview AI commit message\\n"\n',
        "utf8",
      );
      await chmod(fake_node_path, 0o755);

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
      await writeFile(path.join(tmp_dir, "file.txt"), "base\nnext\n", "utf8");

      const result = await exec_file(
        "bash",
        [path.join(repo_root, "bin/g"), "--ai-only"],
        {
          cwd: tmp_dir,
          env: {
            ...process.env,
            PATH: `${fake_bin_dir}:${process.env.PATH}`,
          },
        },
      );

      const commit_count = (
        await exec_file("git", ["rev-list", "--count", "HEAD"], {
          cwd: tmp_dir,
        })
      ).stdout.trim();
      const cached_diff_result = await exec_file(
        "git",
        ["diff", "--cached", "--name-only"],
        { cwd: tmp_dir },
      );

      expect(result.stdout).toBe("Preview AI commit message\n");
      expect(commit_count).toBe("1");
      expect(cached_diff_result.stdout.trim()).toBe("file.txt");
    } finally {
      await rm(tmp_dir, { recursive: true, force: true });
      await rm(fake_bin_dir, { recursive: true, force: true });
    }
  });
});
