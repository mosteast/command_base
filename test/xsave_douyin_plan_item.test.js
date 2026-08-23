import { describe, expect, it } from "vitest";

const { plan_item } = require("../lib/xsave_douyin/plan_item");

const visible_item = {
  aweme_id: "1",
  video: { play_addr: { url_list: ["https://example.com/a.mp4"] } },
};

describe("xsave_douyin plan_item", () => {
  it("skips invisible items even when local media exists", () => {
    const planned = plan_item({
      item: { aweme_id: "1", is_prohibited: true },
      media: { media_path: "/tmp/a.mp4", stem_path: "/tmp/a" },
      sidecar_exists: { comments: false, danmaku: false },
    });
    expect(planned).toEqual({
      action: "skip",
      reason: "invisible",
      download: false,
      write_meta: false,
      write_comments: false,
      write_danmaku: false,
    });
  });

  it("fills sidecars without downloading when media exists", () => {
    const planned = plan_item({
      item: visible_item,
      media: { media_path: "/tmp/a.mp4", stem_path: "/tmp/a" },
      sidecar_exists: { comments: false, danmaku: true },
    });
    expect(planned.action).toBe("fill");
    expect(planned.download).toBe(false);
    expect(planned.write_meta).toBe(true);
    expect(planned.write_comments).toBe(true);
    expect(planned.write_danmaku).toBe(false);
  });

  it("downloads when media is missing and item is visible", () => {
    const planned = plan_item({
      item: visible_item,
      media: null,
      sidecar_exists: { comments: false, danmaku: false },
    });
    expect(planned).toEqual({
      action: "download",
      reason: "",
      download: true,
      write_meta: true,
      write_comments: true,
      write_danmaku: true,
    });
  });
});
