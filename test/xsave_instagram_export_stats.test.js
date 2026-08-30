import { describe, expect, it } from "vitest";

const {
  describe_export_stats,
  empty_export_stats,
  run_export,
} = require("../lib/xsave_instagram/run_export");

describe("xsave_instagram export stats", () => {
  it("omits danmaku from the summary", () => {
    const text = describe_export_stats(empty_export_stats()).join("\n");
    expect(text).toMatch(/collected:/);
    expect(text).toMatch(/comments:/);
    expect(text).not.toMatch(/danmaku/);
  });

  it("counts download and comments from injected list items", async () => {
    const result = await run_export(
      {
        source: "post",
        url: "https://www.instagram.com/example_user/",
        output: "/tmp",
        dry_run: true,
        max_comment: 10,
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
        log: () => {},
      },
    );
    expect(result.exit_code).toBe(0);
    expect(result.stats.collected).toBe(1);
    expect(result.stats.download).toBe(1);
    expect(result.stats.danmaku).toBeUndefined();
  });
});
