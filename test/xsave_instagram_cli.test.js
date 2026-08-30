import { execFile } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { parse_cli } = require("../lib/xsave_instagram/parse_cli");

const cli_entry = path.resolve(__dirname, "../bin/xsave_instagram");

function run_cli(args) {
  return new Promise((resolve) => {
    execFile(
      cli_entry,
      args,
      {
        env: { ...process.env, FORCE_COLOR: "0" },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exit_code: error ? error.code || 1 : 0,
        });
      },
    );
  });
}

describe("xsave_instagram CLI", () => {
  it("prints help with usage description options and examples", async () => {
    const result = await run_cli(["-h"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toMatch(/Usage/);
    expect(result.stdout).toMatch(/Description/);
    expect(result.stdout).toMatch(/Options/);
    expect(result.stdout).toMatch(/like, post, collection, video/);
    expect(result.stdout).toMatch(/gather runtime/);
    expect(result.stdout).toMatch(/export paths/);
    expect(result.stdout).toMatch(/--full-scan/);
    expect(result.stdout).toMatch(/--output/);
    expect(result.stdout).toMatch(/--limit/);
    expect(result.stdout).toMatch(/--refresh/);
    expect(result.stdout).toMatch(/--cookie-file/);
    expect(result.stdout).toMatch(/# Download liked posts/);
    expect(result.stdout).toMatch(/\$0 like /);
    expect(result.stdout).toMatch(/\$0 post /);
    expect(result.stdout).toMatch(/\$0 --full-scan like /);
    expect(result.stdout).toMatch(/\$0 --dry-run collection /);
    expect(result.stdout).not.toMatch(/--max-danmaku/);
    expect(result.stdout).not.toMatch(/COMMAND_BASE_F2_LIKE_LIMIT/);
  });

  it("prints only the version number", async () => {
    const result = await run_cli(["-v"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toBe("1.0.1");
  });

  it("rejects unknown options", async () => {
    const result = await run_cli(["--nope"]);
    expect(result.exit_code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Unknown option/);
  });

  it("rejects --max-danmaku as unknown", async () => {
    const result = await run_cli([
      "like",
      "https://www.instagram.com/example_user/",
      "--max-danmaku",
      "1",
    ]);
    expect(result.exit_code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Unknown option/);
  });

  it("parses source and url positionals", () => {
    const options = parse_cli([
      "like",
      "https://www.instagram.com/example_user/",
      "--max-comment",
      "12",
    ]);
    expect(options.source).toBe("like");
    expect(options.url).toBe("https://www.instagram.com/example_user/");
    expect(options.max_comment).toBe(12);
    expect(options.output).toBe("");
    expect(options.full_scan).toBe(false);
    expect(options.limit).toBe(0);
    expect(options.refresh).toBe(false);
    expect(options.cookie_file).toBe("");
    expect(options.chrome_profile).toBe("");
    expect(options.max_danmaku).toBeUndefined();
  });

  it("infers video from a /p/ url and a /reel/ url", () => {
    expect(parse_cli(["https://www.instagram.com/p/AbCdEfGhIjK/"]).source).toBe(
      "video",
    );
    expect(
      parse_cli(["https://www.instagram.com/reel/AbCdEfGhIjK/"]).source,
    ).toBe("video");
  });

  it("accepts explicit video with a short url", () => {
    const options = parse_cli(["video", "https://instagr.am/p/AbCdEfGhIjK/"]);
    expect(options.source).toBe("video");
    expect(options.url).toBe("https://instagr.am/p/AbCdEfGhIjK/");
  });

  it("requires source for short and profile urls", () => {
    expect(() => parse_cli(["https://instagr.am/p/AbCdEfGhIjK/"])).toThrow(
      /Missing source/,
    );
    expect(() => parse_cli(["https://l.instagram.com/p/AbCdEfGhIjK/"])).toThrow(
      /Missing source/,
    );
    expect(() =>
      parse_cli(["https://www.instagram.com/example_user/"]),
    ).toThrow(/Missing source/);
  });

  it("rejects unknown source, extra args, and mismatches", () => {
    expect(() =>
      parse_cli(["one", "https://www.instagram.com/p/AbCdEfGhIjK/"]),
    ).toThrow(/Invalid source one/);
    expect(() =>
      parse_cli(["like", "https://www.instagram.com/a/", "extra"]),
    ).toThrow(/Unexpected argument extra/);
    expect(() =>
      parse_cli(["video", "https://www.instagram.com/example_user/"]),
    ).toThrow(/source video does not match profile URL/);
    expect(() =>
      parse_cli(["like", "https://www.instagram.com/p/AbCdEfGhIjK/"]),
    ).toThrow(/source like does not match item URL/);
    expect(() =>
      parse_cli(["post", "https://www.instagram.com/reel/AbCdEfGhIjK/"]),
    ).toThrow(/source post does not match item URL/);
  });

  it("parses output full-scan limit refresh and cookie-file", () => {
    const options = parse_cli([
      "--full-scan",
      "--refresh",
      "--limit",
      "3",
      "--output",
      "/tmp/ig-out",
      "--cookie-file",
      "/tmp/cookies.txt",
      "post",
      "https://www.instagram.com/example_user/",
    ]);
    expect(options.source).toBe("post");
    expect(options.output).toBe("/tmp/ig-out");
    expect(options.full_scan).toBe(true);
    expect(options.limit).toBe(3);
    expect(options.refresh).toBe(true);
    expect(options.cookie_file).toBe("/tmp/cookies.txt");
  });

  it("keeps --max-comment 0", () => {
    const options = parse_cli([
      "like",
      "https://www.instagram.com/example_user/",
      "--max-comment",
      "0",
    ]);
    expect(options.max_comment).toBe(0);
  });

  it("rejects invalid --limit", () => {
    expect(() =>
      parse_cli([
        "like",
        "https://www.instagram.com/example_user/",
        "--limit",
        "0",
      ]),
    ).toThrow(/Invalid --limit/);
  });

  it("requires source and url", async () => {
    const result = await run_cli(["--dry-run"]);
    expect(result.exit_code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Missing URL/);
  });

  it("refresh re-downloads existing library media and skips comments at 0", async () => {
    const fs = require("node:fs/promises");
    const os = require("node:os");
    const path = require("node:path");
    const { run_export } = require("../lib/xsave_instagram/run_export");
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-ig-refresh-"));
    const media_name = `"nori","AbCdEfGhIjK","Nori","2026-01-01","desc"_video.mp4`;
    await fs.writeFile(path.join(temp_root, media_name), "video");
    const download_media = async ({ target_path }) => {
      await fs.writeFile(target_path, "new");
      return { ok: true };
    };
    try {
      const result = await run_export(
        {
          source: "like",
          url: "https://www.instagram.com/example_user/",
          output: temp_root,
          refresh: true,
          max_comment: 0,
          chrome_profile: "nori",
        },
        {
          resolve_cookie: async () => "dummy",
          collect_list: async () => [
            {
              shortcode: "AbCdEfGhIjK",
              video_url: "https://example.com/a.mp4",
              author: { username: "nori" },
            },
          ],
          download_media,
          fetch_comments: async () => {
            throw new Error("should not fetch comments when max_comment is 0");
          },
          open_session: async () => ({ page: {}, close: async () => {} }),
          assert_logged_in_profile: async () => {},
          log: () => {},
        },
      );
      expect(result.exit_code).toBe(0);
      expect(result.stats.download).toBe(1);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});

