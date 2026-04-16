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

async function write_douyin_config_file(temp_root) {
  const config_path = path.join(temp_root, "gather.douyin.config.yaml");
  const config_text = [
    "source:",
    "  youtube:",
    "    - name: Example YouTube channel",
    "      handle: https://www.youtube.com/@example",
    "  douyin:",
    "    - name: Example Douyin user",
    "      handle: https://www.douyin.com/user/EXAMPLE_ID",
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

async function write_platform_filtered_command_config_file(temp_root) {
  const config_path = path.join(
    temp_root,
    "gather.platform_filtered_command.yaml",
  );
  const config_text = [
    "source:",
    "  douyin_f2:",
    "    - name: Example Douyin user",
    "      handle: https://www.douyin.com/user/EXAMPLE_ID",
    "command:",
    "  - name: Douyin Likes",
    '    command: "f2_compat dy -M like -u https://v.douyin.com/EXAMPLE/"',
    "  - name: YouTube Playlist",
    '    command: "videos_download -l \\"https://www.youtube.com/playlist?list=PLexample\\""',
    "",
  ].join("\n");
  await fs.writeFile(config_path, config_text, "utf8");
  return config_path;
}

async function write_duplicate_source_config_file(temp_root) {
  const config_path = path.join(temp_root, "gather.duplicate_source.yaml");
  const config_text = [
    "source:",
    "  youtube:",
    "    - name: Example YouTube channel",
    "      handle: https://www.youtube.com/@example",
    "    - name: Duplicate YouTube channel",
    '      handle: "@example"',
    "",
  ].join("\n");
  await fs.writeFile(config_path, config_text, "utf8");
  return config_path;
}

async function write_playlist_source_config_file(temp_root) {
  const config_path = path.join(temp_root, "gather.playlist_source.yaml");
  const config_text = [
    "source:",
    "  youtube:",
    "    - name: Example YouTube playlist",
    "      handle: https://www.youtube.com/playlist?list=PLexample",
    "",
  ].join("\n");
  await fs.writeFile(config_path, config_text, "utf8");
  return config_path;
}

async function write_video_source_config_file(temp_root) {
  const config_path = path.join(temp_root, "gather.video_source.yaml");
  const config_text = [
    "source:",
    "  youtube:",
    "    - name: Example YouTube video",
    "      handle: https://www.youtube.com/watch?v=abc123",
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
        "xsave_yt_dlp --channel-library-layout -c https://space.bilibili.com/39449692",
      );
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("uses playlist mode for youtube playlist source urls", async () => {
    const temp_root = await create_temp_dir();
    const state_file = path.join(temp_root, "gather.state.json");

    try {
      const config_path = await write_playlist_source_config_file(temp_root);
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
      expect(result.stdout).toContain(
        "xsave_yt_dlp --channel-library-layout -l https://www.youtube.com/playlist?list=PLexample",
      );
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("keeps youtube video source urls as direct video downloads", async () => {
    const temp_root = await create_temp_dir();
    const state_file = path.join(temp_root, "gather.state.json");

    try {
      const config_path = await write_video_source_config_file(temp_root);
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
      expect(result.stdout).toContain(
        "xsave_yt_dlp --channel-library-layout https://www.youtube.com/watch?v=abc123",
      );
      expect(result.stdout).not.toContain(
        "xsave_yt_dlp --channel-library-layout -c https://www.youtube.com/watch?v=abc123",
      );
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("supports douyin_f2 as an alias for douyin", async () => {
    const temp_root = await create_temp_dir();
    const state_file = path.join(temp_root, "gather.state.json");

    try {
      const config_path = await write_douyin_config_file(temp_root);
      const result = await run_cli([
        "--dry-run",
        "--state-file",
        state_file,
        "--platform",
        "douyin_f2",
        config_path,
      ]);

      expect(result.exit_code).toBe(0);
      expect(extract_total_jobs(result.stdout)).toBe(1);
      expect(result.stdout).toContain(
        "f2_compat dy -M post -u https://www.douyin.com/user/EXAMPLE_ID",
      );
      expect(result.stdout).not.toContain("https://www.youtube.com/@example");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("uses the saved f2 export directory by default", async () => {
    const temp_root = await create_temp_dir();
    const state_file = path.join(temp_root, "gather.state.json");
    const default_f2_output_dir =
      "/Users/hailang/Library/Mobile Documents/com~apple~CloudDocs/main/saved/f2";

    try {
      const config_path = await write_douyin_config_file(temp_root);
      const result = await run_cli([
        "--dry-run",
        "--state-file",
        state_file,
        "--platform",
        "douyin",
        config_path,
      ]);

      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain(`-p "${default_f2_output_dir}"`);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("deduplicates urls per source type while loading config", async () => {
    const temp_root = await create_temp_dir();
    const state_file = path.join(temp_root, "gather.state.json");

    try {
      const config_path = await write_duplicate_source_config_file(temp_root);
      const result = await run_cli([
        "--dry-run",
        "--state-file",
        state_file,
        config_path,
      ]);

      expect(result.exit_code).toBe(0);
      expect(extract_total_jobs(result.stdout)).toBe(1);
      expect(result.stdout).not.toContain(
        "Skipped 1 duplicate handle entries.",
      );
      expect(result.stderr).toContain(
        "Skipping duplicate youtube url in config",
      );
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("filters custom commands by inferred platform when platform is set", async () => {
    const temp_root = await create_temp_dir();
    const state_file = path.join(temp_root, "gather.state.json");

    try {
      const config_path =
        await write_platform_filtered_command_config_file(temp_root);
      const result = await run_cli([
        "--dry-run",
        "--state-file",
        state_file,
        "--platform",
        "douyin_f2",
        config_path,
      ]);

      expect(result.exit_code).toBe(0);
      expect(extract_total_jobs(result.stdout)).toBe(1);
      expect(extract_total_commands(result.stdout)).toBe(1);
      expect(result.stdout).toContain(
        "f2_compat dy -M like -u https://v.douyin.com/EXAMPLE/",
      );
      expect(result.stdout).not.toContain(
        "https://www.youtube.com/playlist?list=PLexample",
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
        "xsave_yt_dlp --channel-library-layout -c https://www.youtube.com/@example --refresh --overwrite -- --skip-download",
      );
      expect(result.stdout).not.toContain("--no-write-comments");
      expect(result.stdout).toContain("--no-write-subs");
      expect(result.stdout).toContain("--no-write-auto-subs");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("forwards max comments to yt-dlp-backed jobs", async () => {
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
        "--max-comment",
        "100",
        config_path,
      ]);

      expect(result.exit_code).toBe(0);
      expect(extract_total_jobs(result.stdout)).toBe(1);
      expect(result.stdout).toContain(
        "xsave_yt_dlp --channel-library-layout -c https://www.youtube.com/@example --max-comment 100",
      );
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("skips comment sidecars for yt-dlp-backed jobs", async () => {
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
        "--skip-comment",
        config_path,
      ]);

      expect(result.exit_code).toBe(0);
      expect(extract_total_jobs(result.stdout)).toBe(1);
      expect(result.stdout).toContain(
        "xsave_yt_dlp --channel-library-layout -c https://www.youtube.com/@example -- --no-write-comments",
      );
      expect(result.stdout).not.toContain("--max-comment");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("adds comment skipping to yt-dlp info refresh commands", async () => {
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
        "--skip-comment",
        config_path,
      ]);

      expect(result.exit_code).toBe(0);
      expect(extract_total_jobs(result.stdout)).toBe(1);
      expect(result.stdout).toContain(
        "xsave_yt_dlp --channel-library-layout -c https://www.youtube.com/@example --refresh --overwrite -- --skip-download --no-write-subs --no-write-auto-subs --no-write-comments",
      );
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("suppresses max comment forwarding when comments are skipped", async () => {
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
        "--max-comment",
        "100",
        "--skip-comment",
        config_path,
      ]);

      expect(result.exit_code).toBe(0);
      expect(extract_total_jobs(result.stdout)).toBe(1);
      expect(result.stdout).toContain("--no-write-comments");
      expect(result.stdout).not.toContain("--max-comment 100");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("rejects the old max-comments option name", async () => {
    const temp_root = await create_temp_dir();
    const state_file = path.join(temp_root, "gather.state.json");

    try {
      const config_path = await write_config_file(temp_root);
      await expect(
        run_cli([
          "--dry-run",
          "--state-file",
          state_file,
          "--platform",
          "youtube",
          "--max-comments",
          "100",
          config_path,
        ]),
      ).rejects.toMatchObject({
        exit_code: 1,
      });
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

  it("fails fast when platform is unknown", async () => {
    const temp_root = await create_temp_dir();
    const state_file = path.join(temp_root, "gather.state.json");

    try {
      const config_path = await write_config_file(temp_root);
      await expect(
        run_cli([
          "--dry-run",
          "--state-file",
          state_file,
          "--platform",
          "unknown_platform",
          config_path,
        ]),
      ).rejects.toMatchObject({
        exit_code: 1,
      });
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
