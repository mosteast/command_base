import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const { parse_cli } = require("../lib/xsave_douyin/parse_cli");
const { run_export } = require("../lib/xsave_douyin/run_export");

const cli_entry = path.resolve(__dirname, "../bin/xsave_douyin");

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

describe("xsave_douyin CLI", () => {
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
    expect(result.stdout).toMatch(/# Download liked videos/);
    expect(result.stdout).toMatch(/\$0 like /);
    expect(result.stdout).toMatch(/\$0 post /);
    expect(result.stdout).toMatch(/\$0 --full-scan like /);
    expect(result.stdout).toMatch(/\$0 --dry-run collection /);
    expect(result.stdout).not.toMatch(/-M/);
    expect(result.stdout).not.toMatch(/-u,/);
    expect(result.stdout).not.toMatch(/--check-all/);
    expect(result.stdout).not.toMatch(/, one|mode: one|-M one/);
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

  it("parses source and url positionals", () => {
    const options = parse_cli([
      "like",
      "https://v.douyin.com/example/",
      "--max-comment",
      "12",
      "--max-danmaku",
      "34",
    ]);
    expect(options.source).toBe("like");
    expect(options.url).toBe("https://v.douyin.com/example/");
    expect(options.max_comment).toBe(12);
    expect(options.max_danmaku).toBe(34);
    expect(options.output).toBe("");
    expect(options.full_scan).toBe(false);
    expect(options.limit).toBe(0);
    expect(options.refresh).toBe(false);
    expect(options.cookie_file).toBe("");
    expect(options.chrome_profile).toBe("");
  });

  it("infers video from a /video/<id> url", () => {
    const options = parse_cli(["https://www.douyin.com/video/123"]);
    expect(options.source).toBe("video");
    expect(options.url).toBe("https://www.douyin.com/video/123");
  });

  it("accepts explicit video with a short url", () => {
    const options = parse_cli(["video", "https://v.douyin.com/AbCdEf/"]);
    expect(options.source).toBe("video");
    expect(options.url).toBe("https://v.douyin.com/AbCdEf/");
  });

  it("requires source for short and user urls", () => {
    expect(() => parse_cli(["https://v.douyin.com/kIg44MNOKz8/"])).toThrow(
      /Missing source/,
    );
    expect(() =>
      parse_cli(["https://www.douyin.com/user/MS4wLjABAAAA"]),
    ).toThrow(/Missing source/);
  });

  it("rejects unknown source, extra args, and mismatches", () => {
    expect(() =>
      parse_cli(["one", "https://www.douyin.com/video/123"]),
    ).toThrow(/Invalid source one/);
    expect(() =>
      parse_cli(["like", "https://v.douyin.com/a/", "extra"]),
    ).toThrow(/Unexpected argument extra/);
    expect(() =>
      parse_cli(["video", "https://www.douyin.com/user/MS4wLjABAAAA"]),
    ).toThrow(/source video does not match user URL/);
    expect(() =>
      parse_cli(["like", "https://www.douyin.com/video/123"]),
    ).toThrow(/source like does not match video URL/);
  });

  it("rejects removed F2 flags", () => {
    expect(() =>
      parse_cli(["-M", "like", "-u", "https://v.douyin.com/example/"]),
    ).toThrow(/Unknown option/);
    expect(() =>
      parse_cli(["like", "https://v.douyin.com/example/", "--check-all"]),
    ).toThrow(/Unknown option/);
    expect(() =>
      parse_cli(["like", "https://v.douyin.com/example/", "--path", "/tmp"]),
    ).toThrow(/Unknown option/);
  });

  it("parses output full-scan limit refresh and cookie-file", () => {
    const options = parse_cli([
      "--full-scan",
      "--refresh",
      "--limit",
      "3",
      "--output",
      "/tmp/dy-out",
      "--cookie-file",
      "/tmp/cookies.txt",
      "post",
      "https://www.douyin.com/user/MS4wLjABAAAA",
    ]);
    expect(options.source).toBe("post");
    expect(options.output).toBe("/tmp/dy-out");
    expect(options.full_scan).toBe(true);
    expect(options.limit).toBe(3);
    expect(options.refresh).toBe(true);
    expect(options.cookie_file).toBe("/tmp/cookies.txt");
  });

  it("keeps --max-comment 0 and --max-danmaku 0", () => {
    const options = parse_cli([
      "like",
      "https://v.douyin.com/example/",
      "--max-comment",
      "0",
      "--max-danmaku",
      "0",
    ]);
    expect(options.max_comment).toBe(0);
    expect(options.max_danmaku).toBe(0);
  });

  it("rejects invalid --limit", () => {
    expect(() =>
      parse_cli(["like", "https://v.douyin.com/example/", "--limit", "0"]),
    ).toThrow(/Invalid --limit/);
  });

  it("requires source and url", async () => {
    const result = await run_cli(["--dry-run"]);
    expect(result.exit_code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Missing URL/);
  });

  it("dry-run prints fill and skip without downloading", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-douyin-"));
    const media_name = `"uid","1","name","2026-01-01","desc"_video.mp4`;
    await fs.writeFile(path.join(temp_root, media_name), "video");
    const download_media = vi.fn();
    let stdout = "";
    try {
      const result = await run_export(
        {
          mode: "like",
          url: "https://v.douyin.com/example/",
          path: temp_root,
          dry_run: true,
          max_comment: 500,
          max_danmaku: 500,
          chrome_profile: "nori",
        },
        {
          resolve_cookie: async () => "dummy",
          collect_list: async () => [
            {
              aweme_list: [
                {
                  aweme_id: "1",
                  video: {
                    play_addr: { url_list: ["https://example.com/a.mp4"] },
                  },
                },
                { aweme_id: "2", is_prohibited: true },
              ],
            },
          ],
          download_media,
          open_session: async () => {
            throw new Error("should not open chrome in dry-run");
          },
          log: (text) => {
            stdout += `${text}\n`;
          },
        },
      );
      expect(result.exit_code).toBe(0);
      expect(stdout).toMatch(/fill/);
      expect(stdout).toMatch(/skip/);
      expect(download_media).not.toHaveBeenCalled();
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("attaches like intercept before preparing the page", async () => {
    const order = [];
    const result = await run_export(
      {
        mode: "like",
        url: "https://v.douyin.com/example/",
        path: "/tmp",
        dry_run: false,
        max_comment: 1,
        max_danmaku: 1,
        chrome_profile: "Profile 9",
      },
      {
        resolve_cookie: async () => "dummy",
        open_session: async (session_options) => {
          expect(session_options.chrome_profile).toBe("Profile 9");
          return {
            page: {},
            close: async () => {},
          };
        },
        attach_list_intercept: (_page, mode) => {
          order.push(`attach:${mode}`);
          return [
            {
              http: 200,
              status_code: 0,
              has_more: 0,
              aweme_list: [],
            },
          ];
        },
        prepare_list_page: async () => {
          order.push("prepare");
        },
        collect_list: async ({ intercepted_pages }) => {
          order.push("collect");
          expect(intercepted_pages).toHaveLength(1);
          return [];
        },
        log: () => {},
      },
    );
    expect(result.exit_code).toBe(0);
    expect(order).toEqual(["attach:like", "prepare", "collect"]);
  });

  it("uses gather runtime chrome-profile when the flag is omitted", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-douyin-"));
    const runtime_path = path.join(temp_root, "gather.runtime.yaml");
    await fs.writeFile(
      runtime_path,
      ["version: 1", "platform:", "  douyin:", '    chrome_profile: "Profile 9"', ""].join(
        "\n",
      ),
      "utf8",
    );
    const seen = [];
    try {
      await run_export(
        {
          mode: "like",
          url: "https://v.douyin.com/example/",
          path: temp_root,
          dry_run: true,
          chrome_profile: "",
          runtime_path,
        },
        {
          resolve_cookie: async (opts) => {
            seen.push(opts.chrome_profile);
            return "dummy";
          },
          collect_list: async () => [],
          log: () => {},
        },
      );
      expect(seen).toEqual(["Profile 9"]);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("fills sidecars beside library media when path is omitted", async () => {
    const f2_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-f2-lib-"));
    const folder = path.join(f2_root, "douyin", "like", "甘");
    const media_name = `"uid","9990001112223334444","name","2026-01-01","desc"_video.mp4`;
    const stem_path = path.join(folder, `"uid","9990001112223334444","name","2026-01-01","desc"`);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(`${stem_path}_video.mp4`, "video");
    try {
      const result = await run_export(
        {
          mode: "like",
          url: "https://v.douyin.com/example/",
          path: "",
          dry_run: false,
          max_comment: 1,
          max_danmaku: 1,
          chrome_profile: "nori",
        },
        {
          f2_output_dir: f2_root,
          resolve_cookie: async () => "dummy",
          open_session: async () => ({ page: {}, close: async () => {} }),
          attach_list_intercept: () => [],
          prepare_list_page: async () => {},
          collect_list: async () => [
            {
              aweme_list: [
                {
                  aweme_id: "9990001112223334444",
                  desc: "desc",
                  author: { nickname: "name", uid: "uid" },
                  video: {
                    play_addr: { url_list: ["https://example.com/a.mp4"] },
                  },
                  statistics: {
                    digg_count: 9,
                    comment_count: 2,
                    collect_count: 1,
                    share_count: 0,
                  },
                },
              ],
            },
          ],
          fetch_comments: async () => [
            {
              cid: "c1",
              text: "hi",
              user: { nickname: "u" },
              create_time: 1,
              digg_count: 0,
            },
          ],
          fetch_danmaku: async () => [],
          download_media: async () => {
            throw new Error("should not download library media");
          },
          log: () => {},
        },
      );
      expect(result.exit_code).toBe(0);
      expect(result.stats.fill).toBe(1);
      const meta = JSON.parse(await fs.readFile(`${stem_path}_meta.json`, "utf8"));
      expect(meta.digg_count).toBe(9);
      const comments = JSON.parse(
        await fs.readFile(`${stem_path}_comments.json`, "utf8"),
      );
      expect(comments).toHaveLength(1);
    } finally {
      await fs.rm(f2_root, { recursive: true, force: true });
    }
  });

  it("hints doctor fix when the cookie is missing", async () => {
    let stderr = "";
    const result = await run_export(
      {
        mode: "like",
        url: "https://v.douyin.com/example/",
        chrome_profile: "nori",
        path: "/tmp",
      },
      {
        resolve_cookie: async () => "",
        error: (text) => {
          stderr += `${text}\n`;
        },
      },
    );
    expect(result.exit_code).toBe(1);
    expect(stderr).toMatch(
      /gather doctor fix --platform douyin --chrome-profile nori/,
    );
  });
});
