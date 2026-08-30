import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  collect_media_urls,
  download_media,
} = require("../lib/xsave_instagram/download_media");

describe("xsave_instagram download_media", () => {
  it("collects video then carousel then images", () => {
    expect(
      collect_media_urls({
        video_url: "https://example.com/a.mp4",
        image_urls: ["https://example.com/a.jpg"],
        carousel: [{ url: "https://example.com/b.jpg" }],
      }),
    ).toEqual([
      "https://example.com/a.mp4",
      "https://example.com/b.jpg",
      "https://example.com/a.jpg",
    ]);
  });

  it("writes bytes from http_download", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "ig-dl-"));
    const target_path = path.join(temp_root, "item_video.mp4");
    try {
      const result = await download_media({
        item: { video_url: "https://example.com/a.mp4" },
        target_path,
        http_download: async ({ target_path: dest }) => {
          await fs.writeFile(dest, "video");
          return { ok: true };
        },
      });
      expect(result.ok).toBe(true);
      expect(await fs.readFile(target_path, "utf8")).toBe("video");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
