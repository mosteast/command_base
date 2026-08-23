import { describe, expect, it, vi } from "vitest";

const { download_media } = require("../lib/xsave_douyin/download_media");

const item = {
  aweme_id: "1",
  video: { play_addr: { url_list: ["https://example.com/a.mp4"] } },
};

describe("xsave_douyin download_media", () => {
  it("uses f2 HTTP download and skips Chrome when f2 succeeds", async () => {
    const chrome_download = vi.fn();
    const result = await download_media({
      item,
      target_path: "/tmp/a.mp4",
      run_f2: async () => ({ ok: true, status: 200 }),
      chrome_download,
    });
    expect(result.ok).toBe(true);
    expect(chrome_download).not.toHaveBeenCalled();
  });

  it("falls back to Chrome when f2 returns 403", async () => {
    const result = await download_media({
      item,
      target_path: "/tmp/a.mp4",
      run_f2: async () => ({ ok: false, status: 403 }),
      chrome_download: async () => ({ ok: true }),
    });
    expect(result).toEqual({ ok: true, reason: "" });
  });

  it("returns media_forbidden when both downloads fail", async () => {
    const result = await download_media({
      item,
      target_path: "/tmp/a.mp4",
      run_f2: async () => ({ ok: false, status: 403 }),
      chrome_download: async () => ({ ok: false }),
    });
    expect(result).toEqual({ ok: false, reason: "media_forbidden" });
  });

  it("returns chrome_download_failed when Chrome throws", async () => {
    const result = await download_media({
      item,
      target_path: "/tmp/a.mp4",
      run_f2: async () => ({ ok: false, status: 403 }),
      chrome_download: async () => {
        throw new Error("chrome closed");
      },
    });
    expect(result).toEqual({ ok: false, reason: "chrome_download_failed" });
  });
});
