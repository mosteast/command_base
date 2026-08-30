import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const { describe_export_stats, run_export } = require(
  "../lib/xsave_douyin/run_export",
);

describe("xsave_douyin export stats", () => {
  it("formats collected download fill skip and sidecar counts", () => {
    const text = describe_export_stats(
      {
        collected: 5,
        download: 2,
        fill: 1,
        skip: 1,
        download_failed: 1,
        comments: 3,
        danmaku: 0,
      },
      { dry_run: false, elapsed_ms: 1200 },
    ).join("\n");
    expect(text).toMatch(/Export summary/);
    expect(text).toMatch(/collected: 5/);
    expect(text).toMatch(/download: 2/);
    expect(text).toMatch(/fill: 1/);
    expect(text).toMatch(/skip: 1/);
    expect(text).toMatch(/download_failed: 1/);
    expect(text).toMatch(/comments: 3/);
    expect(text).toMatch(/danmaku: 0/);
    expect(text).toMatch(/elapsed_ms: 1200/);
    expect(text).not.toMatch(/sessionid=|msToken|a_bogus/i);
  });

  it("prints a summary after a dry-run export", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-stats-"));
    const media_name = `"uid","1","name","2026-01-01","desc"_video.mp4`;
    await fs.writeFile(path.join(temp_root, media_name), "video");
    let stdout = "";
    try {
      const result = await run_export(
        {
          source: "like",
          url: "https://v.douyin.com/example/",
          output: temp_root,
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
          download_media: vi.fn(),
          log: (text) => {
            stdout += `${text}\n`;
          },
        },
      );
      expect(result.exit_code).toBe(0);
      expect(stdout).toMatch(/Export summary/);
      expect(stdout).toMatch(/collected: 2/);
      expect(stdout).toMatch(/fill: 1/);
      expect(stdout).toMatch(/skip: 1/);
      expect(stdout).toMatch(/download: 0/);
      expect(result.stats.fill).toBe(1);
      expect(result.stats.skip).toBe(1);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
