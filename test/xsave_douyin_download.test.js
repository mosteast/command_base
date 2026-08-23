import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const {
  default_chrome_download,
  default_run_f2,
  download_media,
  first_play_url,
} = require("../lib/xsave_douyin/download_media");

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
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("chrome_download_failed");
    expect(result.error).toMatch(/chrome closed/);
  });

  it("prefers bit_rate play addresses over the first play_addr", () => {
    expect(
      first_play_url({
        video: {
          play_addr: { url_list: ["https://example.com/first.mp4"] },
          bit_rate: [
            {
              play_addr: {
                url_list: [
                  "https://example.com/br0.mp4",
                  "https://example.com/br1.mp4",
                ],
              },
            },
          ],
        },
      }),
    ).toBe("https://example.com/br1.mp4");
  });

  it("downloads through page.request and does not serialize bytes via evaluate", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-dl-"));
    const target_path = path.join(temp_root, "a.mp4");
    const evaluate = vi.fn();
    try {
      const result = await default_chrome_download({
        page: {
          evaluate,
          request: {
            get: async () => ({
              ok: () => true,
              status: () => 200,
              body: async () => Buffer.from("mp4-bytes"),
            }),
          },
        },
        url: "https://example.com/a.mp4",
        target_path,
      });
      expect(result.ok).toBe(true);
      expect(evaluate).not.toHaveBeenCalled();
      expect(await fs.readFile(target_path, "utf8")).toBe("mp4-bytes");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("sends a browser User-Agent on the HTTP download", async () => {
    const original_fetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (_url, options) => {
      seen.push(options && options.headers);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      };
    };
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-http-"));
    const target_path = path.join(temp_root, "a.mp4");
    try {
      const result = await default_run_f2({
        url: "https://example.com/a.mp4",
        target_path,
        cookie_header: "sessionid=dummy",
      });
      expect(result.ok).toBe(true);
      expect(seen[0]["User-Agent"]).toMatch(/Chrome\/\d+/);
      expect(seen[0].Referer).toBe("https://www.douyin.com/");
    } finally {
      globalThis.fetch = original_fetch;
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
