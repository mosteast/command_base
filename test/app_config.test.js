import { execFile } from "node:child_process";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  get_backup_root,
  app_dir_under_root,
  next_id,
  list_numeric_ids,
  resolve_restore_id,
} = require("../lib/app_config/backup_root");
const cursor_provider = require("../lib/app_config/provider/cursor_provider");
const {
  ensure_readme_at_backup_root,
  readme_at_backup_root,
} = require("../lib/app_config/ensure_backup_readme");

const cli_entry = path.resolve(__dirname, "../bin/app_config");

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
        if (error) {
          const exec_error = new Error(stderr || error.message);
          exec_error.stdout = stdout;
          exec_error.stderr = stderr;
          exec_error.exit_code = error.code ?? 1;
          reject(exec_error);
          return;
        }
        resolve({ stdout, stderr, exit_code: 0 });
      },
    );
  });
}

describe("app_config backup_root", () => {
  const original_env = { ...process.env };

  beforeEach(() => {
    process.env = { ...original_env };
  });

  afterEach(() => {
    process.env = { ...original_env };
  });

  it("honors APP_CONFIG_BACKUP_ROOT", () => {
    process.env.APP_CONFIG_BACKUP_ROOT = "/tmp/backup-root";
    expect(get_backup_root()).toBe(path.resolve("/tmp/backup-root"));
  });

  it("next_id starts at 1 on empty tree", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acb-"));
    const app_dir = app_dir_under_root(tmp, "cursor");
    expect(next_id(app_dir)).toBe(1);
  });

  it("next_id is max + 1", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acb-"));
    const app_dir = app_dir_under_root(tmp, "cursor");
    await fs.ensureDir(path.join(app_dir, "1"));
    await fs.ensureDir(path.join(app_dir, "3"));
    expect(next_id(app_dir)).toBe(4);
  });

  it("list_numeric_ids ignores non-numeric dirs", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acb-"));
    const app_dir = app_dir_under_root(tmp, "cursor");
    await fs.ensureDir(path.join(app_dir, "2"));
    await fs.ensureDir(path.join(app_dir, "legacy_ts"));
    expect(list_numeric_ids(app_dir)).toEqual([2]);
  });

  it("resolve_restore_id errors when no backups", () => {
    const tmp = path.join(os.tmpdir(), "no-backups-" + Date.now());
    expect(() => resolve_restore_id(tmp, undefined)).toThrow(
      /no numeric backup id/,
    );
  });

  it("resolve_restore_id picks latest", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acb-"));
    const app_dir = app_dir_under_root(tmp, "cursor");
    await fs.ensureDir(path.join(app_dir, "1"));
    await fs.ensureDir(path.join(app_dir, "5"));
    expect(resolve_restore_id(app_dir, undefined)).toBe(5);
  });

  it("resolve_restore_id respects explicit id", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acb-"));
    const app_dir = app_dir_under_root(tmp, "cursor");
    await fs.ensureDir(path.join(app_dir, "2"));
    expect(resolve_restore_id(app_dir, 2)).toBe(2);
  });

  it("ensure_readme_at_backup_root creates backup root only", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acb-readme-"));
    const backup_root = path.join(tmp, "__app_config_backup");
    ensure_readme_at_backup_root(backup_root);
    expect(await fs.pathExists(backup_root)).toBe(true);
    expect(await fs.pathExists(readme_at_backup_root(backup_root))).toBe(false);
  });
});

describe("cursor_provider backup", () => {
  it("writes manifest and extensions.txt with mocked list", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "home-"));
    const user_base = path.join(
      home,
      "Library",
      "Application Support",
      "Cursor",
      "User",
    );
    await fs.ensureDir(user_base);
    await fs.writeFile(path.join(user_base, "settings.json"), "{}", "utf8");
    await fs.writeFile(
      path.join(user_base, "keybindings.json"),
      "[]",
      "utf8",
    );
    await fs.ensureDir(path.join(user_base, "snippets"));
    await fs.ensureDir(path.join(user_base, "globalStorage"));
    await fs.ensureDir(path.join(home, ".cursor", "extensions"));
    await fs.writeFile(path.join(home, ".cursor", "argv.json"), "{}", "utf8");

    const backup_dir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-"));
    const ctx = {
      debug: false,
      quiet: true,
      dry_run: false,
      home_dir: home,
      exec_cursor_list_extensions: () => "publisher.ext\n",
    };

    cursor_provider.backup(backup_dir, ctx);
    const man_path = path.join(backup_dir, cursor_provider.MANIFEST_NAME);
    expect(await fs.pathExists(man_path)).toBe(true);
    const manifest = await fs.readJson(man_path);
    expect(manifest.app).toBe("cursor");
    expect(manifest.included_paths.length).toBeGreaterThan(0);
    expect(await fs.pathExists(path.join(backup_dir, "extensions.txt"))).toBe(
      true,
    );
  });
});

describe("cursor_provider restore", () => {
  it("replaces managed directories instead of leaving stale files behind", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "home-"));
    const backup_dir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-"));
    const snippet_rel = path.join(
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "snippets",
    );
    const extension_rel = path.join(".cursor", "extensions");
    const live_snippet_dir = path.join(home, snippet_rel);
    const backup_snippet_dir = path.join(backup_dir, snippet_rel);

    await fs.ensureDir(live_snippet_dir);
    await fs.writeFile(
      path.join(live_snippet_dir, "stale.code-snippets"),
      '{"stale":true}',
      "utf8",
    );

    await fs.ensureDir(backup_snippet_dir);
    await fs.ensureDir(path.join(backup_dir, extension_rel));
    await fs.writeFile(
      path.join(backup_snippet_dir, "fresh.code-snippets"),
      '{"fresh":true}',
      "utf8",
    );
    await fs.writeJson(path.join(backup_dir, cursor_provider.MANIFEST_NAME), {
      included_paths: [snippet_rel, extension_rel],
    });

    cursor_provider.restore(backup_dir, {
      debug: false,
      quiet: true,
      dry_run: false,
      home_dir: home,
    });

    expect(
      await fs.pathExists(path.join(live_snippet_dir, "fresh.code-snippets")),
    ).toBe(true);
    expect(
      await fs.pathExists(path.join(live_snippet_dir, "stale.code-snippets")),
    ).toBe(false);
  });

  it("does not install extensions during dry-run even with injected installer", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "home-"));
    const backup_dir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-"));
    const install_calls = [];

    await fs.writeFile(
      path.join(backup_dir, cursor_provider.EXTENSIONS_LIST_FILE),
      "publisher.one\npublisher.two\n",
      "utf8",
    );
    await fs.writeJson(path.join(backup_dir, cursor_provider.MANIFEST_NAME), {
      included_paths: [],
    });

    cursor_provider.restore(backup_dir, {
      debug: false,
      quiet: true,
      dry_run: true,
      home_dir: home,
      exec_cursor_install_extension: (ext_id) => install_calls.push(ext_id),
    });

    expect(install_calls).toEqual([]);
  });
});

describe("app_config CLI", () => {
  it("prints version only with -v", async () => {
    const result = await run_cli(["-v"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.stdout.trim().split("\n").length).toBe(1);
  });

  it("prints version only with -v on backup subcommand", async () => {
    const result = await run_cli(["backup", "-v"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.stdout.trim().split("\n").length).toBe(1);
  });

  it("prints version only with -v on restore subcommand", async () => {
    const result = await run_cli(["restore", "-v"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.stdout.trim().split("\n").length).toBe(1);
  });

  it("includes Usage on global --help", async () => {
    const result = await run_cli(["--help"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toMatch(/backup <app>/);
  });

  it("prints structured backup help that matches AGENTS requirements", async () => {
    const result = await run_cli(["backup", "--help"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("Usage");
    expect(result.stdout).toContain("Description");
    expect(result.stdout).toContain("Options");
    expect(result.stdout).toContain("Examples");
    expect(result.stdout).toContain("--debug");
    expect(result.stdout).toContain("--quiet");
    expect(result.stdout).toContain("# ");
  });

  it("prints structured restore help that matches AGENTS requirements", async () => {
    const result = await run_cli(["restore", "--help"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("Usage");
    expect(result.stdout).toContain("Description");
    expect(result.stdout).toContain("Options");
    expect(result.stdout).toContain("Examples");
    expect(result.stdout).toContain("--debug");
    expect(result.stdout).toContain("--quiet");
    expect(result.stdout).toContain("--no-safety-backup");
    expect(result.stdout).toContain("# ");
  });

  it("rejects unknown global option and prints help", async () => {
    try {
      await run_cli(["--not-a-flag"]);
      expect.fail("should reject");
    } catch (error) {
      expect(error.exit_code).toBe(1);
      expect(error.message).toMatch(/command|Unknown|option/i);
      expect(error.stdout).toContain("Usage");
    }
  });

  it("rejects unknown option on backup subcommand and prints backup help", async () => {
    try {
      await run_cli(["backup", "cursor", "--not-a-flag"], {
        env: { APP_CONFIG_BACKUP_ROOT: os.tmpdir() },
      });
      expect.fail("should reject");
    } catch (error) {
      expect(error.exit_code).toBe(1);
      expect(error.message).toMatch(/Unknown|not-a-flag/i);
      expect(error.stdout).toContain("app_config backup <app>");
    }
  });

  it("reports missing app on backup and prints backup help", async () => {
    try {
      await run_cli(["backup"]);
      expect.fail("should reject");
    } catch (error) {
      expect(error.exit_code).toBe(1);
      expect(error.message).toMatch(/application name is required/i);
      expect(error.stdout).toContain("app_config backup <app>");
    }
  });

  it("reports missing app on restore and prints restore help", async () => {
    try {
      await run_cli(["restore"]);
      expect.fail("should reject");
    } catch (error) {
      expect(error.exit_code).toBe(1);
      expect(error.message).toMatch(/application name is required/i);
      expect(error.stdout).toContain("app_config restore <app>");
    }
  });

  it("reports missing command and prints global help", async () => {
    try {
      await run_cli([]);
      expect.fail("should reject");
    } catch (error) {
      expect(error.exit_code).toBe(1);
      expect(error.message).toMatch(/specify a command/i);
      expect(error.stdout).toContain("backup <app>");
      expect(error.stdout).toContain("restore <app>");
    }
  });

  it("reports unknown app and prints subcommand help", async () => {
    try {
      await run_cli(["backup", "foo"], {
        env: { APP_CONFIG_BACKUP_ROOT: os.tmpdir() },
      });
      expect.fail("should reject");
    } catch (error) {
      expect(error.exit_code).toBe(1);
      expect(error.message).toMatch(/unknown app "foo"/i);
      expect(error.stdout).toContain("app_config backup <app>");
    }
  });
});

describe("app_config backup dry-run (temp root)", () => {
  it("does not create snapshot dir on dry-run", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acb-cli-"));
    const result = await run_cli(["backup", "cursor", "--dry-run"], {
      env: {
        APP_CONFIG_BACKUP_ROOT: tmp,
        HOME: "/nonexistent-for-dry-run",
      },
    });
    expect(result.exit_code).toBe(0);
    const app_dir = app_dir_under_root(tmp, "cursor");
    expect(await fs.pathExists(app_dir)).toBe(false);
  });
});
