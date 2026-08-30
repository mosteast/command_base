import { describe, expect, it } from "vitest";

const { plan_item } = require("../lib/xsave_instagram/plan_item");

const visible_item = {
  shortcode: "AbCdEfGhIjK",
  video_url: "https://example.com/a.mp4",
};

describe("xsave_instagram plan_item", () => {
  it("skips invisible items even when local media exists", () => {
    const planned = plan_item({
      item: { shortcode: "AbCdEfGhIjK", is_prohibited: true },
      media: { media_path: "/tmp/a.mp4", stem_path: "/tmp/a" },
      sidecar_exists: { comments: false },
    });
    expect(planned).toEqual({
      action: "skip",
      reason: "invisible",
      download: false,
      write_meta: false,
      write_comments: false,
    });
    expect(planned.write_danmaku).toBeUndefined();
  });

  it("fills comments without downloading when media exists", () => {
    const planned = plan_item({
      item: visible_item,
      media: { media_path: "/tmp/a.mp4", stem_path: "/tmp/a" },
      sidecar_exists: { comments: false },
    });
    expect(planned.action).toBe("fill");
    expect(planned.download).toBe(false);
    expect(planned.write_meta).toBe(true);
    expect(planned.write_comments).toBe(true);
  });

  it("downloads when media is missing and item is visible", () => {
    const planned = plan_item({
      item: visible_item,
      media: null,
      sidecar_exists: { comments: false },
    });
    expect(planned).toEqual({
      action: "download",
      reason: "",
      download: true,
      write_meta: true,
      write_comments: true,
    });
  });

  it("re-downloads existing media when refresh is set", () => {
    const planned = plan_item({
      item: visible_item,
      media: { media_path: "/tmp/a.mp4", stem_path: "/tmp/a" },
      sidecar_exists: { comments: true },
      refresh: true,
    });
    expect(planned).toEqual({
      action: "download",
      reason: "refresh",
      download: true,
      write_meta: true,
      write_comments: true,
    });
  });

  it("still skips invisible items when refresh is set", () => {
    const planned = plan_item({
      item: { shortcode: "AbCdEfGhIjK", is_prohibited: true },
      media: { media_path: "/tmp/a.mp4", stem_path: "/tmp/a" },
      refresh: true,
    });
    expect(planned.action).toBe("skip");
    expect(planned.download).toBe(false);
  });
});
