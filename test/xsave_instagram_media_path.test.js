import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  build_stem,
  find_existing_media,
  sidecar_paths,
} = require("../lib/xsave_instagram/media_path");

describe("xsave_instagram media_path", () => {
  it("builds a stem that includes the shortcode", () => {
    const stem = build_stem(
      {
        shortcode: "AbCdEfGhIjK",
        author: { username: "nori", full_name: "Nori" },
        caption: "hello",
        taken_at: 1700000000,
      },
      "/tmp/ig",
    );
    expect(stem).toContain("AbCdEfGhIjK");
    expect(path.dirname(stem)).toBe("/tmp/ig");
    expect(sidecar_paths(stem).danmaku).toBeUndefined();
    expect(sidecar_paths(stem).comments).toBe(`${stem}_comments.json`);
  });

  it("finds existing media by shortcode", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "ig-media-"));
    const name = `"nori","AbCdEfGhIjK","Nori","2026-01-01","hello"_video.mp4`;
    await fs.writeFile(path.join(temp_root, name), "video");
    try {
      const found = await find_existing_media(temp_root, "AbCdEfGhIjK");
      expect(found.media_path).toBe(path.join(temp_root, name));
      expect(found.stem_path).toContain("AbCdEfGhIjK");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
