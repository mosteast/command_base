import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  default_output_dir,
  describe_export_layout,
  resolve_output_dir,
} = require("../lib/xsave_instagram/run_export");

describe("xsave_instagram export layout", () => {
  it("lists output paths with source and full_scan and no danmaku", () => {
    const lines = describe_export_layout({
      source: "like",
      url: "https://www.instagram.com/example_user/",
      output_dir: "/tmp/ig-out",
      chrome_profile: "Profile 9",
      runtime_path: "/tmp/gather.runtime.yaml",
      max_comment: 500,
      dry_run: false,
      item_limit: 0,
    });
    const text = lines.join("\n");
    expect(text).toMatch(/source: like/);
    expect(text).toMatch(/full_scan: false/);
    expect(text).toMatch(/sidecar comments/);
    expect(text).not.toMatch(/danmaku/);
  });

  it("defaults instagram/<source> and uses an explicit output", () => {
    expect(default_output_dir("video", "/tmp/f2")).toBe(
      path.join("/tmp/f2", "instagram", "video"),
    );
    expect(resolve_output_dir({ output: "/tmp/ig-out", source: "like" })).toBe(
      path.resolve("/tmp/ig-out"),
    );
    expect(
      resolve_output_dir(
        { source: "like", output: "" },
        { f2_output_dir: "/tmp/f2" },
      ),
    ).toBe(path.join("/tmp/f2", "instagram", "like"));
  });
});
