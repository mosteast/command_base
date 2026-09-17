import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as exec_file_callback } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const exec_file = promisify(exec_file_callback);
const require = createRequire(import.meta.url);
const { run_git_init } = require("../lib/git_init/run");
const {
  GITIGNORE_TEMPLATE,
  GITATTRIBUTES_TEMPLATE,
} = require("../lib/git_init/templates");

async function create_temp_dir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "git-init-"));
}

function silent_logger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
    success() {},
  };
}

describe("git_init run", () => {
  it("creates git metadata, repo, and local LFS hooks in an empty directory", async () => {
    const root = await create_temp_dir();
    const lfs_calls = [];
    try {
      const result = await run_git_init({
        cwd: root,
        logger: silent_logger(),
        install_lfs: async ({ cwd }) => {
          lfs_calls.push(cwd);
        },
      });

      expect(result.created).toEqual([".gitignore", ".gitattributes"]);
      expect(result.skipped).toEqual([]);
      expect(result.initialized_repo).toBe(true);
      expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toBe(
        GITIGNORE_TEMPLATE,
      );
      expect(await fs.readFile(path.join(root, ".gitattributes"), "utf8")).toBe(
        GITATTRIBUTES_TEMPLATE,
      );
      expect(lfs_calls).toEqual([root]);
      await exec_file("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: root,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite existing git metadata unless --force is set", async () => {
    const root = await create_temp_dir();
    try {
      await fs.writeFile(path.join(root, ".gitignore"), "keep-me\n", "utf8");
      await fs.writeFile(path.join(root, ".gitattributes"), "keep-attr\n", "utf8");

      const skipped = await run_git_init({
        cwd: root,
        logger: silent_logger(),
        install_lfs: async () => {},
      });
      expect(skipped.created).toEqual([]);
      expect(skipped.skipped).toEqual([".gitignore", ".gitattributes"]);
      expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toBe(
        "keep-me\n",
      );

      const forced = await run_git_init({
        cwd: root,
        force: true,
        logger: silent_logger(),
        install_lfs: async () => {},
      });
      expect(forced.created).toEqual([".gitignore", ".gitattributes"]);
      expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toBe(
        GITIGNORE_TEMPLATE,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("dry-run does not write files or initialize git", async () => {
    const root = await create_temp_dir();
    try {
      const result = await run_git_init({
        cwd: root,
        dry_run: true,
        logger: silent_logger(),
        install_lfs: async () => {
          throw new Error("lfs should not run during dry-run");
        },
      });
      expect(result.created).toEqual([".gitignore", ".gitattributes"]);
      await expect(fs.access(path.join(root, ".gitignore"))).rejects.toMatchObject(
        { code: "ENOENT" },
      );
      await expect(fs.access(path.join(root, ".git"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps package-lock.json and nested build directories trackable", async () => {
    const root = await create_temp_dir();
    try {
      await run_git_init({
        cwd: root,
        logger: silent_logger(),
        install_lfs: async () => {},
      });
      await fs.mkdir(path.join(root, "形象", "build"), { recursive: true });
      await fs.writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");
      await fs.writeFile(
        path.join(root, "形象", "build", "logo.svg"),
        "<svg />\n",
        "utf8",
      );

      const ignored_lock = await exec_file(
        "git",
        ["check-ignore", "-v", "package-lock.json"],
        { cwd: root },
      ).then(
        () => true,
        (error) => {
          if (error.code === 1) return false;
          throw error;
        },
      );
      const ignored_nested_build = await exec_file(
        "git",
        ["check-ignore", "-v", "形象/build/logo.svg"],
        { cwd: root },
      ).then(
        () => true,
        (error) => {
          if (error.code === 1) return false;
          throw error;
        },
      );
      const ignored_root_build = await exec_file(
        "git",
        ["check-ignore", "-v", "build/index.js"],
        { cwd: root },
      ).then(
        () => true,
        (error) => {
          if (error.code === 1) return false;
          throw error;
        },
      );

      expect(ignored_lock).toBe(false);
      expect(ignored_nested_build).toBe(false);
      expect(ignored_root_build).toBe(true);
      expect(GITATTRIBUTES_TEMPLATE).toMatch(/\*\.sketch filter=lfs/);
      expect(GITATTRIBUTES_TEMPLATE).toMatch(/\* text=auto eol=lf/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
