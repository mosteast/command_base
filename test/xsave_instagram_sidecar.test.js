import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  build_comments,
  build_meta,
  write_sidecars,
} = require("../lib/xsave_instagram/sidecar");

describe("xsave_instagram sidecar", () => {
  it("builds meta from shortcode fields", () => {
    const meta = build_meta(
      {
        shortcode: "AbCdEfGhIjK",
        pk: "99",
        author: { username: "nori", full_name: "Nori" },
        caption: "hello",
        taken_at: 1700000000,
        like_count: 3,
        comment_count: 2,
      },
      "2026-01-01T00:00:00.000Z",
    );
    expect(meta.shortcode).toBe("AbCdEfGhIjK");
    expect(meta.pk).toBe("99");
    expect(meta.author).toBe("Nori");
    expect(meta.aweme_id).toBeUndefined();
  });

  it("writes meta and comments and never a danmaku file", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "ig-side-"));
    const stem_path = path.join(temp_root, "item");
    try {
      await write_sidecars({
        stem_path,
        meta: { shortcode: "AbCdEfGhIjK" },
        comments: build_comments(
          [{ id: "1", text: "hi", user: { username: "a" }, created_at: 1 }],
          500,
        ),
        write_comments: true,
      });
      const names = await fs.readdir(temp_root);
      expect(names).toContain("item_meta.json");
      expect(names).toContain("item_comments.json");
      expect(names.some((name) => name.includes("danmaku"))).toBe(false);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
