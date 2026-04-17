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

async function find_files_with_suffix(root_dir, suffix) {
  const matches = [];
  const entries = await fs.readdir(root_dir, { withFileTypes: true });

  for (const entry of entries) {
    const full_path = path.join(root_dir, entry.name);
    if (entry.isDirectory()) {
      matches.push(...(await find_files_with_suffix(full_path, suffix)));
      continue;
    }
    if (entry.isFile() && full_path.endsWith(suffix)) {
      matches.push(full_path);
    }
  }

  return matches;
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

async function create_channel_library_layout_fake_yt_dlp_bin(temp_root) {
  const bin_dir = path.join(temp_root, "fake_bin_channel_library");
  const script_path = path.join(bin_dir, "yt-dlp");

  await fs.mkdir(bin_dir, { recursive: true });
  await fs.writeFile(
    script_path,
    `#!/usr/bin/env bash
set -euo pipefail

log_file="\${FAKE_YT_DLP_LOG:?}"
printf '%s\\n' "$*" >> "$log_file"

node - "$@" <<'NODE'
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const meta = {
  uploader: "Example Channel",
  channel: "Example Channel",
  creator: "Example Channel",
  playlist_uploader: "Example Channel",
  playlist: "Example Playlist",
  playlist_index: "1",
  n_entries: "1",
  title: "Example Video",
  id: "abc123",
  ext: "mp4",
};

function argValue(name) {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) return "";
  return args[index + 1];
}

function renderTemplate(template) {
  return String(template || "").replace(/%\\(([^)]+)\\)([a-z])/g, (_match, fieldExpr) => {
    if (fieldExpr === "n_entries+1-playlist_index") {
      return String(Number(meta.n_entries) + 1 - Number(meta.playlist_index));
    }

    const candidates = fieldExpr.split(",");
    for (const candidate of candidates) {
      const key = candidate.trim();
      if (key && meta[key]) {
        return meta[key];
      }
    }
    return "";
  });
}

function ensureFile(filePath, contents = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

const outputTemplate = argValue("-o");
const renderedFilename = renderTemplate(outputTemplate);
const isDumpSingleJson = args.includes("-J") || args.includes("--dump-single-json");
const isSkipDownload = args.includes("--skip-download");
const shouldWriteSubs = args.includes("--write-subs") || args.includes("--write-auto-subs");
const shouldWriteInfoJson = args.includes("--write-info-json");
const shouldWriteDescription = args.includes("--write-description");
const shouldWriteComments = args.includes("--write-comments");
const shouldWriteLink = args.includes("--write-link");
const subtitleLangs = argValue("--sub-langs");

if (isDumpSingleJson) {
  process.stdout.write(
    JSON.stringify({
      entries: [
        {
          id: meta.id,
          title: meta.title,
          playlist: meta.playlist,
          playlist_index: Number(meta.playlist_index),
          filename: renderedFilename,
          requested_downloads: [{ filename: renderedFilename }],
        },
      ],
    }),
  );
  process.exit(0);
}

if (!isSkipDownload) {
  ensureFile(renderedFilename, "fake media");
}

if (shouldWriteSubs) {
  const stem = renderedFilename.replace(/\\.[^.]+$/, "");
  if (subtitleLangs.includes("danmaku")) {
    ensureFile(\`\${stem}.danmaku.xml\`, "<i></i>");
  } else {
    ensureFile(\`\${stem}.en.vtt\`, "WEBVTT\\n");
  }
}

if (shouldWriteInfoJson) {
  ensureFile(
    renderedFilename.replace(/\\.[^.]+$/, ".info.json"),
    JSON.stringify({ id: meta.id, title: meta.title }),
  );
}

if (shouldWriteDescription) {
  ensureFile(renderedFilename.replace(/\\.[^.]+$/, ".description"), "description");
}

if (shouldWriteComments) {
  ensureFile(renderedFilename.replace(/\\.[^.]+$/, ".comments"), "comments");
}

if (shouldWriteLink) {
  ensureFile(renderedFilename.replace(/\\.[^.]+$/, ".url"), "https://example.com/watch?v=abc123");
}

process.stdout.write("[download] Finished downloading playlist: Example Playlist\\n");
NODE
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

describe("xsave_yt_dlp comment extraction", () => {
  it("adds a YouTube max comments extractor arg during metadata export", async () => {
    const result = await run_cli([
      "--dry-run",
      "--debug",
      "--channel",
      "https://www.youtube.com/@user1",
      "--max-comment",
      "100",
    ]);

    const stdout_text = strip_ansi(result.stdout);

    expect(result.exit_code).toBe(0);
    expect(stdout_text).toContain("--write-comments");
    expect(stdout_text).toMatch(
      /--extractor-args youtube:max_comments=100\\,all\\,all\\,all/,
    );
  });

  it("suppresses comment export when yt-dlp passthrough disables comments", async () => {
    const result = await run_cli([
      "--dry-run",
      "--debug",
      "--channel",
      "https://www.youtube.com/@user1",
      "--max-comment",
      "100",
      "--",
      "--no-write-comments",
    ]);

    const stdout_text = strip_ansi(result.stdout);

    expect(result.exit_code).toBe(0);
    expect(stdout_text).toContain("--write-info-json");
    expect(stdout_text).not.toContain("--write-comments");
    expect(stdout_text).not.toContain("youtube:max_comments=100,all,all,all");
    expect(stdout_text).toMatch(/youtube:max_comments=0\\,all\\,all\\,all/);
    expect(stdout_text).not.toContain("--no-write-comments");
  });

  it("strips conflicting comment flags before invoking yt-dlp", async () => {
    const temp_root = await create_temp_dir();
    const output_dir = path.join(temp_root, "output");
    const fake_yt_dlp_log = path.join(temp_root, "fake_yt_dlp.log");

    await fs.mkdir(output_dir, { recursive: true });
    await fs.writeFile(fake_yt_dlp_log, "", "utf8");

    try {
      const fake_yt_dlp =
        await create_channel_library_layout_fake_yt_dlp_bin(temp_root);

      const result = await run_cli(
        [
          "--debug",
          "--retry-count",
          "2",
          "--no-danmaku",
          "--channel",
          "https://www.youtube.com/@example",
          "--output",
          output_dir,
          "--max-comment",
          "100",
          "--",
          "--no-write-comments",
        ],
        {
          env: {
            PATH: `${fake_yt_dlp.bin_dir}:${process.env.PATH || ""}`,
            FAKE_YT_DLP_LOG: fake_yt_dlp_log,
          },
        },
      );

      const invocation_lines = (await fs.readFile(fake_yt_dlp_log, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean);
      const download_call = invocation_lines.find(
        (line) => !line.includes("--skip-download"),
      );
      const metadata_call = invocation_lines.find((line) =>
        line.includes("--skip-download"),
      );

      expect(result.exit_code).toBe(0);
      expect(download_call).toBeDefined();
      expect(metadata_call).toBeDefined();
      expect(download_call).toContain("youtube:max_comments=0,all,all,all");
      expect(metadata_call).not.toContain("--write-comments");
      expect(metadata_call).not.toContain(
        "youtube:max_comments=100,all,all,all",
      );
      expect(metadata_call).toContain("youtube:max_comments=0,all,all,all");
      expect(
        invocation_lines.some((line) => line.includes("--no-write-comments")),
      ).toBe(false);
      expect(
        await find_files_with_suffix(output_dir, ".comments"),
      ).toHaveLength(0);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
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

describe("xsave_yt_dlp channel library layout", () => {
  it("stores playlist media in the channel library and creates playlist symlinks", async () => {
    const temp_root = await create_temp_dir();
    const output_dir = path.join(temp_root, "output");
    const fake_yt_dlp_log = path.join(temp_root, "fake_yt_dlp.log");

    await fs.mkdir(output_dir, { recursive: true });
    await fs.writeFile(fake_yt_dlp_log, "", "utf8");

    try {
      const fake_yt_dlp =
        await create_channel_library_layout_fake_yt_dlp_bin(temp_root);

      const result = await run_cli(
        [
          "--debug",
          "--retry-count",
          "2",
          "--no-danmaku",
          "--channel-library-layout",
          "--list",
          "https://www.youtube.com/playlist?list=PLexample",
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

      const actual_media = path.join(
        output_dir,
        "Example Channel - Videos",
        "Example Video [abc123].mp4",
      );
      const actual_subtitle = path.join(
        output_dir,
        "Example Channel - Videos",
        "Example Video [abc123].en.vtt",
      );
      const playlist_media_link = path.join(
        output_dir,
        "Example Playlist",
        "1.Example Video.mp4",
      );
      const playlist_subtitle_link = path.join(
        output_dir,
        "Example Playlist",
        "1.Example Video.en.vtt",
      );

      expect(result.exit_code).toBe(0);
      await expect(fs.readFile(actual_media, "utf8")).resolves.toBe(
        "fake media",
      );
      await expect(fs.readFile(actual_subtitle, "utf8")).resolves.toContain(
        "WEBVTT",
      );

      const playlist_media_stat = await fs.lstat(playlist_media_link);
      const playlist_subtitle_stat = await fs.lstat(playlist_subtitle_link);

      expect(playlist_media_stat.isSymbolicLink()).toBe(true);
      expect(playlist_subtitle_stat.isSymbolicLink()).toBe(true);
      expect(await fs.realpath(playlist_media_link)).toBe(
        await fs.realpath(actual_media),
      );
      expect(await fs.realpath(playlist_subtitle_link)).toBe(
        await fs.realpath(actual_subtitle),
      );
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
