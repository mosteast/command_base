import path from "node:path";
import { describe, expect, it } from "vitest";

const { describe_export_layout, run_export } = require(
  "../lib/xsave_douyin/run_export",
);

describe("xsave_douyin export layout", () => {
  it("lists output locations for media and sidecars", () => {
    const lines = describe_export_layout({
      mode: "like",
      url: "https://v.douyin.com/example/",
      output_dir: "/tmp/dy-out",
      chrome_profile: "Profile 9",
      runtime_path: "/tmp/gather.runtime.yaml",
      max_comment: 500,
      max_danmaku: 200,
      dry_run: false,
      item_limit: 0,
    });
    const text = lines.join("\n");
    expect(text).toMatch(/mode: like/);
    expect(text).toMatch(/output_dir: \/tmp\/dy-out/);
    expect(text).toMatch(/chrome_profile: Profile 9/);
    expect(text).toMatch(/runtime: \/tmp\/gather\.runtime\.yaml/);
    expect(text).toMatch(/_video\.mp4/);
    expect(text).toMatch(/_meta\.json/);
    expect(text).toMatch(/_comments\.json/);
    expect(text).toMatch(/_danmaku\.json/);
    expect(text).toMatch(/"<uid>","<aweme_id>"/);
    expect(text).not.toMatch(/sessionid=|msToken|a_bogus/i);
  });

  it("prints the layout at the start of a debug export", async () => {
    const debug_lines = [];
    await run_export(
      {
        mode: "like",
        url: "https://v.douyin.com/example/",
        path: "/tmp/dy-out",
        debug: true,
        dry_run: true,
        chrome_profile: "Profile 9",
        runtime_path: "/tmp/gather.runtime.yaml",
        max_comment: 12,
        max_danmaku: 34,
      },
      {
        resolve_cookie: async () => "dummy",
        collect_list: async () => [],
        debug: (text) => {
          debug_lines.push(text);
        },
        log: () => {},
      },
    );
    const text = debug_lines.join("\n");
    expect(debug_lines[0]).toMatch(/Export plan/);
    expect(text).toMatch(/output_dir: \/tmp\/dy-out/);
    expect(text).toMatch(/_comments\.json/);
    expect(text.indexOf("Export plan")).toBeLessThan(
      text.indexOf("Resolving Douyin cookie") === -1
        ? text.length
        : text.indexOf("Resolving Douyin cookie"),
    );
  });
});
