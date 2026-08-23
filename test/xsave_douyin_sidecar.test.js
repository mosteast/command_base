import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

const {
  build_meta,
  build_comments,
  build_danmaku,
  write_sidecars,
  has_secret_leak,
} = require("../lib/xsave_douyin/sidecar");

describe("xsave_douyin sidecar", () => {
  it("builds meta comments and danmaku without secrets", async () => {
    const item = {
      aweme_id: "123",
      desc: "hello",
      create_time: 1700000000,
      author: { nickname: "nori" },
      statistics: {
        digg_count: 10,
        collect_count: 2,
        comment_count: 3,
        share_count: 4,
      },
    };
    const meta = build_meta(item, "2026-08-23T00:00:00.000Z");
    expect(meta.aweme_id).toBe("123");
    expect(meta.digg_count).toBe(10);
    expect(meta.collect_count).toBe(2);
    expect(meta.comment_count).toBe(3);
    expect(meta.share_count).toBe(4);
    expect(meta.online_status).toBe("visible");
    expect(meta.fetched_at).toBe("2026-08-23T00:00:00.000Z");
    expect(meta).not.toHaveProperty("play_count");
    expect(has_secret_leak(JSON.stringify(meta))).toBe(false);

    const comments = build_comments(
      [
        { cid: "c1", text: "a", user: { nickname: "u" }, create_time: 1, digg_count: 1 },
        { cid: "c2", text: "b", user: { nickname: "v" }, create_time: 2, digg_count: 0 },
      ],
      1,
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]).toEqual({
      id: "c1",
      text: "a",
      author: "u",
      time: 1,
      like_count: 1,
    });

    const danmaku = build_danmaku(
      [{ id: "d1", text: "fly", user: { nickname: "w" }, time: 3, digg_count: 0 }],
      500,
    );
    expect(danmaku).toHaveLength(1);

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-sidecar-"));
    const stem_path = path.join(root, "stem");
    await write_sidecars({
      stem_path,
      meta,
      comments,
      danmaku: [],
      write_comments: true,
      write_danmaku: true,
    });
    const names = await fs.readdir(root);
    expect(names).toContain("stem_meta.json");
    expect(names).toContain("stem_comments.json");
    expect(names).not.toContain("stem_danmaku.json");
    await fs.rm(root, { recursive: true, force: true });
  });
});
