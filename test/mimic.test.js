import { createRequire } from "node:module";
import child_process from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const mimic = require("../bin/mimic");
const cli_entry = path.resolve(__dirname, "../bin/mimic");
const exec_file = util.promisify(child_process.execFile);

function create_test_logger() {
  return {
    debug() {},
    error() {},
    info() {},
    warn() {},
  };
}

function create_cli_argv(overrides = {}) {
  return {
    repo_uri: "mosteast/giao",
    dir_path: "workspace/demo",
    branch: "",
    "keep-origin": false,
    "keep-branch": false,
    parent: "parent",
    "fork-branch": "master",
    "create-remote": false,
    remote: "",
    "remote-alias": "",
    "remote-visibility": "private",
    "dry-run": false,
    quiet: false,
    debug: false,
    ...overrides,
  };
}

function run_cli(args) {
  return new Promise((resolve, reject) => {
    exec_file(process.execPath, [cli_entry, ...args], {
      env: {
        ...process.env,
        FORCE_COLOR: "0",
      },
      maxBuffer: 1024 * 1024,
    })
      .then(({ stdout, stderr }) =>
        resolve({
          stdout,
          stderr,
          exit_code: 0,
        }),
      )
      .catch((error) => {
        const exec_error = new Error(error.stderr || error.message);
        exec_error.stdout = error.stdout || "";
        exec_error.stderr = error.stderr || "";
        exec_error.exit_code = error.code || 1;
        reject(exec_error);
      });
  });
}

describe("mimic helpers", () => {
  it("builds clone args with gh git-flag separator", () => {
    const clone_args = mimic.build_clone_args(
      {
        repo_uri: "mosteast/giao",
        branch: "feature/login",
      },
      "/tmp/demo",
    );

    expect(clone_args).toEqual([
      "repo",
      "clone",
      "mosteast/giao",
      "/tmp/demo",
      "--",
      "--recursive",
      "--single-branch",
      "--branch=feature/login",
    ]);
  });

  it("derives the remote repo name from the target directory", () => {
    expect(
      mimic.derive_remote_repo_name(
        {
          remote_name: "",
        },
        "/tmp/workspace/demo",
      ),
    ).toBe("demo");
  });

  it("defaults the created remote alias to fork when origin is preserved", () => {
    expect(
      mimic.resolve_remote_alias({
        remote_alias: "",
        keep_origin: true,
      }),
    ).toBe("fork");
  });

  it("rejects create-remote when keep-origin still uses origin", () => {
    expect(() =>
      mimic.normalize_cli_options(
        create_cli_argv({
          "keep-origin": true,
          "create-remote": true,
          "remote-alias": "origin",
        }),
      ),
    ).toThrow(/--remote-alias origin conflicts with --keep-origin/);
  });

  it("parses create-remote options and keeps the safe alias fallback", () => {
    const cli_result = mimic.parse_cli_arguments([
      "mosteast/giao",
      "workspace/demo",
      "--create-remote",
      "--keep-origin",
    ]);

    expect(cli_result.action).toBe("run");
    expect(cli_result.options.create_remote).toBe(true);
    expect(mimic.resolve_remote_alias(cli_result.options)).toBe("fork");
  });

  it("rejects unknown options", () => {
    expect(() =>
      mimic.parse_cli_arguments(["mosteast/giao", "--bad-option"]),
    ).toThrow(/Unknown arguments?: bad-option/);
  });

  it("documents default false for boolean options", () => {
    const help_text = mimic.build_help_text("mimic");

    expect(help_text).toContain(
      "--keep-origin                 Preserve the original origin remote (default: false)",
    );
    expect(help_text).toContain(
      "--keep-branch                 Skip renaming the default branch (default: false)",
    );
    expect(help_text).toContain(
      "--create-remote               Create a brand new GitHub repo via gh (default: false)",
    );
    expect(help_text).toContain(
      "-d, --dry-run                 Show planned commands without running them (default: false)",
    );
    expect(help_text).toContain(
      "--quiet                       Print only warnings and errors (default: false)",
    );
    expect(help_text).toContain(
      "--debug                       Show verbose debug logs (default: false)",
    );
  });

  it("documents canonical flags and deprecated aliases in help", () => {
    const help_text = mimic.build_help_text("mimic");

    expect(help_text).toContain(
      "--parent <name>               Name to assign to the parent remote (default: parent; deprecated alias: --parent-name)",
    );
    expect(help_text).toContain(
      "--remote <name>               Name for the new remote repo (default: target dir name; deprecated alias: --remote-name)",
    );
    expect(help_text).toContain(
      "$0 mosteast/giao demo --parent upstream --fork-branch worktree",
    );
    expect(help_text).toContain(
      "$0 mosteast/giao demo --keep-origin --parent upstream --create-remote --remote myuser/demo --remote-alias fork",
    );
  });

  it("accepts deprecated aliases for parent and remote", () => {
    const cli_result = mimic.parse_cli_arguments([
      "mosteast/giao",
      "workspace/demo",
      "--parent-name",
      "upstream",
      "--remote-name",
      "myuser/demo",
      "--create-remote",
    ]);

    expect(cli_result.action).toBe("run");
    expect(cli_result.options.parent_remote_name).toBe("upstream");
    expect(cli_result.options.remote_name).toBe("myuser/demo");
    expect(cli_result.options.create_remote).toBe(true);
  });

  it("prints the version number only", async () => {
    const result = await run_cli(["--version"]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("1.0.1\n");
    expect(result.stderr).toBe("");
  });

  it("prints error details outside debug mode", () => {
    const old_console_error = console.error;
    const error_lines = [];
    console.error = (message) => {
      error_lines.push(String(message));
    };

    try {
      const logger = mimic.create_logger({
        quiet_mode: false,
        debug_mode: false,
      });

      logger.error(
        "Failed to complete mimic workflow.",
        new Error("Target path already exists: prompt"),
      );
    } finally {
      console.error = old_console_error;
    }

    expect(error_lines.join("\n")).toContain(
      "Target path already exists: prompt",
    );
  });

  it("reports an existing target directory directly", async () => {
    const temp_dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimic-exists-"));
    const fake_bin_dir = path.join(temp_dir, "bin");
    const fake_gh_path = path.join(fake_bin_dir, "gh");
    const workspace_dir = path.join(temp_dir, "workspace");
    const target_dir = path.join(workspace_dir, "prompt");
    const old_cwd = process.cwd();
    const old_path = process.env.PATH;

    await fs.mkdir(fake_bin_dir);
    await fs.mkdir(workspace_dir);
    await fs.mkdir(target_dir);
    await fs.writeFile(
      fake_gh_path,
      [
        "#!/usr/bin/env node",
        'throw new Error("gh should not run when target exists");',
      ].join("\n"),
    );
    await fs.chmod(fake_gh_path, 0o755);

    try {
      process.chdir(workspace_dir);
      process.env.PATH = `${fake_bin_dir}${path.delimiter}${old_path}`;

      await expect(
        mimic.mimic_repository(
          {
            repo_uri: "mosteast/prompt",
            dir_path: "",
            branch: "",
            keep_origin: false,
            keep_branch: false,
            parent_remote_name: "parent",
            fork_branch_name: "master",
            create_remote: false,
            remote_name: "",
            remote_alias: "",
            remote_visibility: "private",
            dry_run: false,
            quiet_mode: false,
            debug_mode: false,
          },
          create_test_logger(),
        ),
      ).rejects.toThrow(/^Target path already exists: prompt$/);
    } finally {
      process.chdir(old_cwd);
      process.env.PATH = old_path;
    }
  });

  it("handles empty source repositories with unborn branches", async () => {
    const temp_dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimic-empty-"));
    const source_repo = path.join(temp_dir, "source.git");
    const fake_bin_dir = path.join(temp_dir, "bin");
    const fake_gh_path = path.join(fake_bin_dir, "gh");
    const workspace_dir = path.join(temp_dir, "workspace");
    const target_dir = path.join(workspace_dir, "prompt");
    const old_cwd = process.cwd();
    const old_path = process.env.PATH;

    await fs.mkdir(fake_bin_dir);
    await fs.mkdir(workspace_dir);
    await exec_file("git", ["init", "--bare", source_repo]);
    await exec_file("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
      cwd: source_repo,
    });
    await fs.writeFile(
      fake_gh_path,
      [
        "#!/usr/bin/env node",
        'const { spawnSync } = require("node:child_process");',
        "const args = process.argv.slice(2);",
        'if (args[0] !== "repo" || args[1] !== "clone") process.exit(2);',
        "const target = args[3];",
        'const result = spawnSync("git", ["clone", process.env.MIMIC_TEST_SOURCE_REPO, target], { stdio: "inherit" });',
        "process.exit(result.status || 0);",
      ].join("\n"),
    );
    await fs.chmod(fake_gh_path, 0o755);

    try {
      process.chdir(workspace_dir);
      process.env.PATH = `${fake_bin_dir}${path.delimiter}${old_path}`;
      process.env.MIMIC_TEST_SOURCE_REPO = source_repo;

      await mimic.mimic_repository(
        {
          repo_uri: "mosteast/prompt",
          dir_path: "",
          branch: "",
          keep_origin: false,
          keep_branch: false,
          parent_remote_name: "parent",
          fork_branch_name: "master",
          create_remote: false,
          remote_name: "",
          remote_alias: "",
          remote_visibility: "private",
          dry_run: false,
          quiet_mode: false,
          debug_mode: false,
        },
        create_test_logger(),
      );

      const branch_result = await exec_file(
        "git",
        ["branch", "--show-current"],
        {
          cwd: target_dir,
        },
      );
      const remote_result = await exec_file("git", ["remote"], {
        cwd: target_dir,
      });

      expect(branch_result.stdout.trim()).toBe("master");
      expect(remote_result.stdout.trim()).toBe("parent");
    } finally {
      process.chdir(old_cwd);
      process.env.PATH = old_path;
      delete process.env.MIMIC_TEST_SOURCE_REPO;
    }
  });
});
