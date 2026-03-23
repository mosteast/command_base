import { execFile } from "node:child_process";
import path from "path";
import { describe, expect, it } from "vitest";

const cli_entry = path.resolve(__dirname, "../bin/xsave_yt_dlp");

function run_cli(args) {
  return new Promise((resolve, reject) => {
    execFile(
      cli_entry,
      args,
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

function strip_ansi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
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
    expect(stdout_text).toMatch(
      /availability\\!=\\\?\\'needs_subscription\\'/,
    );
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
