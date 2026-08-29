import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const { collect_list } = require("../lib/xsave_douyin/chrome_client");
const { run_export } = require("../lib/xsave_douyin/run_export");

function visible_item(aweme_id) {
  return {
    aweme_id,
    video: {
      play_addr: { url_list: [`https://example.com/${aweme_id}.mp4`] },
    },
  };
}

function page_by_cursor(pages_by_cursor) {
  return {
    evaluate: async (_fn, arg) => pages_by_cursor[arg.cursor],
  };
}

describe("xsave_douyin export resume", () => {
  it("stops collecting after the first already downloaded item", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-resume-"));
    const media_name = `"uid","old-1","name","2026-01-01","desc"_video.mp4`;
    await fs.writeFile(path.join(temp_root, media_name), "video");
    const pages_by_cursor = {
      0: {
        http: 200,
        status_code: 0,
        has_more: 1,
        max_cursor: 10,
        aweme_list: [visible_item("new-1"), visible_item("old-1")],
      },
      10: {
        http: 200,
        status_code: 0,
        has_more: 0,
        max_cursor: 20,
        aweme_list: [visible_item("older-1")],
      },
    };
    let stdout = "";
    try {
      const result = await run_export(
        {
          mode: "like",
          url: "https://v.douyin.com/example/",
          path: temp_root,
          dry_run: true,
          max_comment: 1,
          max_danmaku: 1,
          chrome_profile: "nori",
        },
        {
          page: page_by_cursor(pages_by_cursor),
          resolve_cookie: async () => "dummy",
          collect_list,
          attach_list_intercept: () => [],
          prepare_list_page: async () => {},
          download_media: vi.fn(),
          log: (text) => {
            stdout += `${text}\n`;
          },
        },
      );
      expect(result.exit_code).toBe(0);
      expect(result.stats.collected).toBe(2);
      expect(result.items.map((item) => item.aweme_id)).toEqual(["new-1", "old-1"]);
      expect(stdout).toMatch(/Resume at downloaded item old-1/);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("keeps collecting the whole list when --check-all is set", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-check-all-"));
    const media_name = `"uid","old-1","name","2026-01-01","desc"_video.mp4`;
    await fs.writeFile(path.join(temp_root, media_name), "video");
    const pages_by_cursor = {
      0: {
        http: 200,
        status_code: 0,
        has_more: 1,
        max_cursor: 10,
        aweme_list: [visible_item("new-1"), visible_item("old-1")],
      },
      10: {
        http: 200,
        status_code: 0,
        has_more: 0,
        max_cursor: 20,
        aweme_list: [visible_item("older-1")],
      },
    };
    try {
      const result = await run_export(
        {
          mode: "collection",
          url: "https://www.douyin.com/user/MS4wLjABAAAA",
          path: temp_root,
          dry_run: true,
          check_all: true,
          max_comment: 1,
          max_danmaku: 1,
          chrome_profile: "nori",
        },
        {
          page: page_by_cursor(pages_by_cursor),
          resolve_cookie: async () => "dummy",
          collect_list,
          attach_list_intercept: () => [],
          prepare_list_page: async () => {},
          download_media: vi.fn(),
          log: () => {},
        },
      );
      expect(result.exit_code).toBe(0);
      expect(result.stats.collected).toBe(3);
      expect(result.items.map((item) => item.aweme_id)).toEqual([
        "new-1",
        "old-1",
        "older-1",
      ]);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("does not stop list collect for mode one", async () => {
    const seen = [];
    const result = await run_export(
      {
        mode: "one",
        url: "https://www.douyin.com/video/123",
        path: "/tmp",
        dry_run: true,
        max_comment: 1,
        max_danmaku: 1,
        chrome_profile: "nori",
      },
      {
        resolve_cookie: async () => "dummy",
        collect_list: async (args) => {
          seen.push(args.should_stop);
          return [];
        },
        log: () => {},
      },
    );
    expect(result.exit_code).toBe(0);
    expect(seen[0]).toBeUndefined();
  });
});
