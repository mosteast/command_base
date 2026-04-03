import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "path";
import { describe, expect, it } from "vitest";

const cli_entry = path.resolve(__dirname, "../bin/xsave_yt_dlp");

function run_cli(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cli_entry,
      args,
      {
        env: { ...process.env, FORCE_COLOR: "0", ...env },
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

function strip_ansi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

async function create_temp_dir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "xsave-yt-dlp-test-"));
}

async function create_fake_yt_dlp_bin(temp_root) {
  const bin_dir = path.join(temp_root, "fake_bin");
  const script_path = path.join(bin_dir, "yt-dlp");

  await fs.mkdir(bin_dir, { recursive: true });
  await fs.writeFile(
    script_path,
    `#!/usr/bin/env bash
set -u

log_file="\${FAKE_YT_DLP_LOG:?}"
printf '%s\\n' "$*" >> "$log_file"

if [[ "$*" == *"--cookies-from-browser"* ]] || [[ "$*" == *"--cookies "* ]]; then
  printf '%s\\n' "Extracting cookies from chrome"
  printf '%s\\n' "Extracted 225 cookies from chrome"
fi

if [[ "$*" == *"youtube:player_client=android"* ]] && [[ "$*" != *"--cookies-from-browser"* ]] && [[ "$*" != *"--cookies "* ]]; then
  if [[ "$*" == *"--skip-download"* ]]; then
    printf '%s\\n' "[info] Writing playlist metadata as JSON to: /tmp/example.info.json"
  else
    printf '%s\\n' "[download] Finished downloading playlist: Example - Videos"
  fi
  exit 0
fi

printf '%s\\n' "[download] Downloading playlist: Example - Videos"
printf '%s\\n' "WARNING: [youtube] No title found in player responses; falling back to title from initial data. Other metadata may also be missing"
printf '%s\\n' "ERROR: [youtube] abc123: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication."
printf '%s\\n' "[download] Finished downloading playlist: Example - Videos"
exit 1
`,
    "utf8",
  );
  await fs.chmod(script_path, 0o755);

  return { bin_dir };
}

async function create_persistent_auth_fake_yt_dlp_bin(temp_root) {
  const bin_dir = path.join(temp_root, "fake_bin_persistent_auth");
  const script_path = path.join(bin_dir, "yt-dlp");

  await fs.mkdir(bin_dir, { recursive: true });
  await fs.writeFile(
    script_path,
    `#!/usr/bin/env bash
set -u

log_file="\${FAKE_YT_DLP_LOG:?}"
printf '%s\\n' "$*" >> "$log_file"

if [[ "$*" == *"--cookies-from-browser"* ]] || [[ "$*" == *"--cookies "* ]]; then
  printf '%s\\n' "Extracting cookies from chrome"
  printf '%s\\n' "Extracted 225 cookies from chrome"
fi

printf '%s\\n' "[download] Downloading playlist: Example - Videos"
printf '%s\\n' "ERROR: [youtube] abc123: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication."
printf '%s\\n' "[download] Finished downloading playlist: Example - Videos"
exit 0
`,
    "utf8",
  );
  await fs.chmod(script_path, 0o755);

  return { bin_dir };
}

describe("xsave_yt_dlp match filters", () => {
  it("keeps missing availability fields in the generated yt-dlp command", async () => {
    const result = await run_cli([
      "--dry-run",
      "--debug",
      "--channel",
      "https://space.bilibili.com/3546751319410941",
    ]);

    const stdout_text = strip_ansi(result.stdout);

    expect(result.exit_code).toBe(0);
    expect(stdout_text).toContain("--match-filters");
    expect(stdout_text).toMatch(/availability\\!=\\\?\\'needs_subscription\\'/);
  });
});

describe("xsave_yt_dlp danmaku handling", () => {
  it("exports bilibili danmaku by default with a standalone command", async () => {
    const result = await run_cli([
      "--dry-run",
      "--debug",
      "--channel",
      "https://space.bilibili.com/3546751319410941",
    ]);

    const stdout_text = strip_ansi(result.stdout);

    expect(result.exit_code).toBe(0);
    expect(stdout_text).toContain("Channel danmaku export");
    expect(stdout_text).toMatch(/--sub-langs danmaku/);
    expect(stdout_text).toContain(".danmaku.txt");
  });

  it("allows danmaku export to be disabled explicitly", async () => {
    const result = await run_cli([
      "--dry-run",
      "--debug",
      "--channel",
      "https://space.bilibili.com/3546751319410941",
      "--no-danmaku",
    ]);

    const stdout_text = strip_ansi(result.stdout);

    expect(result.exit_code).toBe(0);
    expect(stdout_text).not.toContain("Channel danmaku export");
    expect(stdout_text).not.toMatch(/--sub-langs danmaku/);
  });

  it("supports danmaku-only downloads without regular subtitle embedding", async () => {
    const result = await run_cli([
      "--dry-run",
      "--debug",
      "--only-danmaku",
      "https://www.bilibili.com/video/BV1jL41167ZG/",
    ]);

    const stdout_text = strip_ansi(result.stdout);

    expect(result.exit_code).toBe(0);
    expect(stdout_text).toContain("Danmaku export:");
    expect(stdout_text).toMatch(/--skip-download/);
    expect(stdout_text).toMatch(/--sub-langs danmaku/);
    expect(stdout_text).not.toMatch(/--embed-subs/);
    expect(stdout_text).not.toContain("Video download:");
  });

  it("passes browser cookies for bilibili subtitle-capable downloads", async () => {
    const result = await run_cli([
      "--dry-run",
      "--debug",
      "--channel",
      "https://space.bilibili.com/3546751319410941",
      "--cookies-from-browser",
      "safari",
    ]);

    const stdout_text = strip_ansi(result.stdout);

    expect(result.exit_code).toBe(0);
    expect(stdout_text).toContain("--cookies-from-browser safari");
    expect(stdout_text).toContain("Channel danmaku export");
    expect(
      stdout_text.match(/--cookies-from-browser safari/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("xsave_yt_dlp youtube auth fallback", () => {
  it("skips identical retries for youtube auth challenges and falls back without cookies", async () => {
    const temp_root = await create_temp_dir();
    const output_dir = path.join(temp_root, "output");
    const fake_yt_dlp_log = path.join(temp_root, "fake_yt_dlp.log");

    await fs.mkdir(output_dir, { recursive: true });
    await fs.writeFile(fake_yt_dlp_log, "", "utf8");

    try {
      const fake_yt_dlp = await create_fake_yt_dlp_bin(temp_root);
      const result = await run_cli(
        [
          "--debug",
          "--retry-count",
          "3",
          "--no-danmaku",
          "--channel",
          "https://www.youtube.com/@example",
          "--output",
          output_dir,
        ],
        {
          env: {
            PATH: `${fake_yt_dlp.bin_dir}:${process.env.PATH || ""}`,
            FAKE_YT_DLP_LOG: fake_yt_dlp_log,
          },
        },
      );

      const stdout_text = strip_ansi(result.stdout);
      const invocation_lines = (await fs.readFile(fake_yt_dlp_log, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean);

      const primary_download_calls = invocation_lines.filter(
        (line) =>
          !line.includes("--skip-download") &&
          line.includes("--cookies-from-browser chrome") &&
          line.includes("youtube:player_client=web,web_safari,web_embedded"),
      );
      const primary_metadata_calls = invocation_lines.filter(
        (line) =>
          line.includes("--skip-download") &&
          line.includes("--cookies-from-browser chrome") &&
          line.includes("youtube:player_client=web,web_safari,web_embedded"),
      );
      const android_download_calls = invocation_lines.filter(
        (line) =>
          !line.includes("--skip-download") &&
          !line.includes("--cookies-from-browser") &&
          !line.includes("--cookies ") &&
          line.includes("youtube:player_client=android"),
      );
      const android_metadata_calls = invocation_lines.filter(
        (line) =>
          line.includes("--skip-download") &&
          !line.includes("--cookies-from-browser") &&
          !line.includes("--cookies ") &&
          line.includes("youtube:player_client=android"),
      );

      expect(result.exit_code).toBe(0);
      expect(invocation_lines.some((line) => line.includes("[DEBUG]"))).toBe(
        false,
      );
      expect(stdout_text).toContain("non-retriable yt-dlp error(s): auth");
      expect(stdout_text).not.toContain(
        "Retrying Channel download: https://www.youtube.com/@example (attempt 2 of 3)",
      );
      expect(stdout_text).toContain(
        "Channel fallback download without cookies using android",
      );
      expect(primary_download_calls).toHaveLength(1);
      expect(primary_metadata_calls).toHaveLength(1);
      expect(android_download_calls).toHaveLength(1);
      expect(android_metadata_calls).toHaveLength(1);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("fails the channel run when auth errors persist after the final fallback", async () => {
    const temp_root = await create_temp_dir();
    const output_dir = path.join(temp_root, "output");
    const fake_yt_dlp_log = path.join(temp_root, "fake_yt_dlp.log");

    await fs.mkdir(output_dir, { recursive: true });
    await fs.writeFile(fake_yt_dlp_log, "", "utf8");

    try {
      const fake_yt_dlp =
        await create_persistent_auth_fake_yt_dlp_bin(temp_root);

      await expect(
        run_cli(
          [
            "--debug",
            "--retry-count",
            "3",
            "--no-danmaku",
            "--channel",
            "https://www.youtube.com/@example",
            "--output",
            output_dir,
          ],
          {
            env: {
              PATH: `${fake_yt_dlp.bin_dir}:${process.env.PATH || ""}`,
              FAKE_YT_DLP_LOG: fake_yt_dlp_log,
            },
          },
        ),
      ).rejects.toMatchObject({
        exit_code: 1,
      });

      const invocation_lines = (await fs.readFile(fake_yt_dlp_log, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean);

      expect(invocation_lines).toHaveLength(3);
      expect(
        invocation_lines.some((line) => line.includes("--skip-download")),
      ).toBe(false);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
