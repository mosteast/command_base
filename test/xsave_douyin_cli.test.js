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
    expect(result.stdout).toMatch(/like, post, one, collection/);
    expect(result.stdout).toMatch(/# Download liked videos/);
    expect(result.stdout).toMatch(/\$0 -M like -u /);
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

  it("requires mode and url", async () => {
    const result = await run_cli(["--dry-run"]);
    expect(result.exit_code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/-M|--mode|-u|--url/);
  });

  it("parses max-comment and max-danmaku as numbers", () => {
    const options = parse_cli([
      "-M",
      "like",
      "-u",
      "https://v.douyin.com/example/",
      "--max-comment",
      "12",
      "--max-danmaku",
      "34",
    ]);
    expect(options.max_comment).toBe(12);
    expect(options.max_danmaku).toBe(34);
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
