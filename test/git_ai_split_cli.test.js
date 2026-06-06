import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec_file = promisify(execFile);
const repo_root = path.resolve(import.meta.dirname, "..");

async function create_git_repo() {
  const tmp_dir = await mkdtemp(path.join(os.tmpdir(), "command-base-split-"));

  await exec_file("git", ["init", "-b", "main"], { cwd: tmp_dir });
  await exec_file("git", ["config", "user.email", "test@example.com"], {
    cwd: tmp_dir,
  });
  await exec_file("git", ["config", "user.name", "Test"], { cwd: tmp_dir });
  await writeFile(path.join(tmp_dir, "file.txt"), "base\n", "utf8");
  await exec_file("git", ["add", "file.txt"], { cwd: tmp_dir });
  await exec_file("git", ["commit", "-m", "init"], { cwd: tmp_dir });
  await writeFile(path.join(tmp_dir, "file.txt"), "base\nnext\n", "utf8");

  return tmp_dir;
}

async function exec_file_status(command, args, options = {}) {
  try {
    const result = await exec_file(command, args, options);
    return { ...result, code: 0 };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

describe("git AI split CLI", () => {
  it("routes g --ai --split through the split commit helper", async () => {
    const tmp_dir = await create_git_repo();
    const fake_bin_dir = await mkdtemp(
      path.join(os.tmpdir(), "command-base-fake-node-"),
    );
    const captured_args_path = path.join(tmp_dir, "node_args.txt");

    try {
      const fake_node_path = path.join(fake_bin_dir, "node");
      await writeFile(
        fake_node_path,
        [
          "#!/usr/bin/env bash",
          'printf "%s\\n" "$@" > "$CAPTURED_ARGS_PATH"',
          'printf "0\\n"',
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(fake_node_path, 0o755);

      await exec_file(
        "bash",
        [path.join(repo_root, "bin/g"), "--ai", "--split", "--dry-run"],
        {
          cwd: tmp_dir,
          env: {
            ...process.env,
            CAPTURED_ARGS_PATH: captured_args_path,
            PATH: `${fake_bin_dir}:${process.env.PATH}`,
          },
        },
      );

      const captured_args = await readFile(captured_args_path, "utf8");
      expect(captured_args).toContain("utility/git_smart_commit_ai.js");
      expect(captured_args).toContain("--dry-run");
    } finally {
      await rm(tmp_dir, { recursive: true, force: true });
      await rm(fake_bin_dir, { recursive: true, force: true });
    }
  });

  it("forwards ggg --ai --split to g after formatting", async () => {
    const tmp_dir = await create_git_repo();
    const fake_bin_dir = await mkdtemp(
      path.join(os.tmpdir(), "command-base-fake-g-"),
    );
    const captured_args_path = path.join(tmp_dir, "g_args.txt");

    try {
      const fake_npm_path = path.join(fake_bin_dir, "npm");
      const fake_g_path = path.join(fake_bin_dir, "g");
      await writeFile(fake_npm_path, "#!/usr/bin/env bash\nexit 0\n", "utf8");
      await writeFile(
        fake_g_path,
        [
          "#!/usr/bin/env bash",
          'printf "%s\\n" "$@" > "$CAPTURED_ARGS_PATH"',
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(fake_npm_path, 0o755);
      await chmod(fake_g_path, 0o755);

      await exec_file(
        "bash",
        [path.join(repo_root, "bin/ggg"), "--ai", "--split"],
        {
          cwd: tmp_dir,
          env: {
            ...process.env,
            CAPTURED_ARGS_PATH: captured_args_path,
            PATH: `${fake_bin_dir}:${process.env.PATH}`,
          },
        },
      );

      const captured_args = await readFile(captured_args_path, "utf8");
      expect(captured_args.trim().split("\n")).toEqual(["--ai", "--split"]);
    } finally {
      await rm(tmp_dir, { recursive: true, force: true });
      await rm(fake_bin_dir, { recursive: true, force: true });
    }
  });

  it("forwards ggg --smart as the compatibility alias for --ai --split", async () => {
    const tmp_dir = await create_git_repo();
    const fake_bin_dir = await mkdtemp(
      path.join(os.tmpdir(), "command-base-fake-g-"),
    );
    const captured_args_path = path.join(tmp_dir, "g_args.txt");

    try {
      const fake_npm_path = path.join(fake_bin_dir, "npm");
      const fake_g_path = path.join(fake_bin_dir, "g");
      await writeFile(fake_npm_path, "#!/usr/bin/env bash\nexit 0\n", "utf8");
      await writeFile(
        fake_g_path,
        [
          "#!/usr/bin/env bash",
          'printf "%s\\n" "$@" > "$CAPTURED_ARGS_PATH"',
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(fake_npm_path, 0o755);
      await chmod(fake_g_path, 0o755);

      await exec_file("bash", [path.join(repo_root, "bin/ggg"), "--smart"], {
        cwd: tmp_dir,
        env: {
          ...process.env,
          CAPTURED_ARGS_PATH: captured_args_path,
          PATH: `${fake_bin_dir}:${process.env.PATH}`,
        },
      });

      const captured_args = await readFile(captured_args_path, "utf8");
      expect(captured_args.trim().split("\n")).toEqual(["--ai", "--split"]);
    } finally {
      await rm(tmp_dir, { recursive: true, force: true });
      await rm(fake_bin_dir, { recursive: true, force: true });
    }
  });

  it("requires --ai when --split is used", async () => {
    const result = await exec_file_status(
      "bash",
      [path.join(repo_root, "bin/g"), "--split"],
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--split requires --ai");
  });
});
