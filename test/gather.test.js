import { execFile } from "node:child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it, expect } from "vitest";

const cli_entry = path.resolve(__dirname, "../bin/gather");

function run_cli(args) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli_entry, ...args],
      {
        env: { ...process.env, FORCE_COLOR: "0" },
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

async function create_temp_dir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "gather-test-"));
}

async function write_config_file(temp_root) {
  const config_path = path.join(temp_root, "gather.config.yaml");
  const config_text = [
    "source:",
    "  youtube:",
    "    - name: Example YouTube channel",
    "      handle: https://www.youtube.com/@example",
    "  bilibili:",
    "    - name: Example Bilibili creator",
    "      handle: 39449692",
    "  rumble:",
    "    - name: Example Rumble channel",
    "      handle: https://rumble.com/c/example",
    "",
  ].join("\n");
  await fs.writeFile(config_path, config_text, "utf8");
  return config_path;
}

async function write_command_range_config_file(temp_root, marker_file_path) {
  const config_path = path.join(temp_root, "gather.command_range.config.yaml");
  const first_command = `printf "first\\n" >> "${marker_file_path}"`;
  const second_command = `printf "second\\n" >> "${marker_file_path}"`;
  const config_text = [
    "source:",
    "  youtube:",
    "    - name: Invalid source entry",
    "      handle:",
    "command:",
    "  - name: Write first marker",
    `    command: ${JSON.stringify(first_command)}`,
    "  - name: Write second marker",
    `    command: ${JSON.stringify(second_command)}`,
    "",
  ].join("\n");
  await fs.writeFile(config_path, config_text, "utf8");
  return config_path;
}

async function write_source_and_command_config_file(temp_root) {
  const config_path = path.join(temp_root, "gather.source_and_command.yaml");
  const config_text = [
    "source:",
    "  youtube:",
    "    - name: Example YouTube channel",
    "      handle: https://www.youtube.com/@example",
    "command:",
    "  - name: Echo marker",
    '    command: "printf \\"marker\\\\n\\""',
    "",
  ].join("\n");
  await fs.writeFile(config_path, config_text, "utf8");
  return config_path;
}

function extract_total_jobs(stdout_text) {
  const lines = String(stdout_text || "")
    .split(/\r?\n/)
    .filter(Boolean);
  const summary_line = lines.find((line) => line.includes("Total jobs:"));
  if (!summary_line) {
    throw new Error(`Missing summary line in output:\n${stdout_text}`);
  }
  const match = summary_line.match(/Total jobs:\s*(\d+)/);
  if (!match) {
    throw new Error(`Unable to parse job count from:\n${summary_line}`);
  }
  return Number(match[1]);
}

function extract_total_commands(stdout_text) {
  const lines = String(stdout_text || "")
    .split(/\r?\n/)
    .filter(Boolean);
  const summary_line = lines.find((line) => line.includes("Total commands:"));
  if (!summary_line) {
    throw new Error(`Missing command summary line in output:\n${stdout_text}`);
  }
  const match = summary_line.match(/Total commands:\s*(\d+)/);
  if (!match) {
    throw new Error(`Unable to parse command count from:\n${summary_line}`);
  }
  return Number(match[1]);
}

describe("gather CLI platform selection", () => {
  it("gathers all config entries when no platform filter is set", async () => {
    const temp_root = await create_temp_dir();
    const state_file = path.join(temp_root, "gather.state.json");

    try {
      const config_path = await write_config_file(temp_root);
      const result = await run_cli([
        "--dry-run",
        "--state-file",
        state_file,
        config_path,
      ]);

      expect(result.exit_code).toBe(0);
      expect(extract_total_jobs(result.stdout)).toBe(3);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("filters to the selected platform when platform is set", async () => {
    const temp_root = await create_temp_dir();
    const state_file = path.join(temp_root, "gather.state.json");

    try {
      const config_path = await write_config_file(temp_root);
      const result = await run_cli([
        "--dry-run",
        "--state-file",
        state_file,
        "--platform",
        "youtube",
        config_path,
      ]);

      expect(result.exit_code).toBe(0);
      expect(extract_total_jobs(result.stdout)).toBe(1);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("supports bilibili sources in config and builds an xsave_yt_dlp command", async () => {
    const temp_root = await create_temp_dir();
    const state_file = path.join(temp_root, "gather.state.json");

    try {
      const config_path = await write_config_file(temp_root);
      const result = await run_cli([
        "--dry-run",
        "--state-file",
        state_file,
        "--platform",
        "bilibili",
        config_path,
      ]);

      expect(result.exit_code).toBe(0);
      expect(extract_total_jobs(result.stdout)).toBe(1);
      expect(result.stdout).toContain(
        "xsave_yt_dlp -c https://space.bilibili.com/39449692",
      );
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("keeps comments in yt-dlp info refresh commands", async () => {
    const temp_root = await create_temp_dir();
    const state_file = path.join(temp_root, "gather.state.json");

    try {
      const config_path = await write_config_file(temp_root);
      const result = await run_cli([
        "--dry-run",
        "--refresh",
        "info",
        "--state-file",
        state_file,
        "--platform",
        "youtube",
        config_path,
      ]);

      expect(result.exit_code).toBe(0);
      expect(extract_total_jobs(result.stdout)).toBe(1);
      expect(result.stdout).toContain(
        "xsave_yt_dlp -c https://www.youtube.com/@example --refresh --overwrite -- --skip-download",
      );
      expect(result.stdout).not.toContain("--no-write-comments");
      expect(result.stdout).toContain("--no-write-subs");
      expect(result.stdout).toContain("--no-write-auto-subs");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("treats a path-like platform token as config when platform value is missing", async () => {
    const temp_root = await create_temp_dir();
    const state_file = path.join(temp_root, "gather.state.json");

    try {
      const config_path = await write_config_file(temp_root);
      const result = await run_cli([
        "--dry-run",
        "--state-file",
        state_file,
        "--platform",
        config_path,
      ]);

      expect(result.exit_code).toBe(0);
      expect(extract_total_jobs(result.stdout)).toBe(3);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("runs only command entries when range is command", async () => {
    const temp_root = await create_temp_dir();
    const marker_file_path = path.join(temp_root, "command_range.log");
    const state_file = path.join(temp_root, "gather.state.json");

    try {
      const config_path = await write_command_range_config_file(
        temp_root,
        marker_file_path,
      );
      const result = await run_cli([
        "--range",
        "command",
        "--state-file",
        state_file,
        config_path,
      ]);

      expect(result.exit_code).toBe(0);
      expect(extract_total_commands(result.stdout)).toBe(2);
      const marker_text = await fs.readFile(marker_file_path, "utf8");
      expect(marker_text).toContain("first");
      expect(marker_text).toContain("second");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("runs source and command when range includes both", async () => {
    const temp_root = await create_temp_dir();
    const state_file = path.join(temp_root, "gather.state.json");

    try {
      const config_path = await write_source_and_command_config_file(temp_root);
      const result = await run_cli([
        "--dry-run",
        "--range",
        "source",
        "command",
        "--state-file",
        state_file,
        config_path,
      ]);

      expect(result.exit_code).toBe(0);
      expect(extract_total_jobs(result.stdout)).toBe(1);
      expect(extract_total_commands(result.stdout)).toBe(1);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("defaults to all range and runs source plus command", async () => {
    const temp_root = await create_temp_dir();
    const state_file = path.join(temp_root, "gather.state.json");

    try {
      const config_path = await write_source_and_command_config_file(temp_root);
      const result = await run_cli([
        "--dry-run",
        "--state-file",
        state_file,
        config_path,
      ]);

      expect(result.exit_code).toBe(0);
      expect(extract_total_jobs(result.stdout)).toBe(1);
      expect(extract_total_commands(result.stdout)).toBe(1);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
