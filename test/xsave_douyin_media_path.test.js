import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

const {
  find_existing_media,
  sidecar_paths,
} = require("../lib/xsave_douyin/media_path");

async function create_temp_dir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "xsave-douyin-media-"));
}

describe("xsave_douyin media_path", () => {
  it("finds non-empty media by aweme_id and builds sidecar paths", async () => {
    const root = await create_temp_dir();
    const folder = path.join(root, "douyin", "like", "甘");
    await fs.mkdir(folder, { recursive: true });
    const media_name =
      '"uid","12345","name","2026-01-01","desc"_video.mp4';
    const media_path = path.join(folder, media_name);
    await fs.writeFile(media_path, "video-bytes");
    const empty_path = path.join(
      folder,
      '"uid","999","x","2026-01-01","z"_video.mp4',
    );
    await fs.writeFile(empty_path, "");

    const found = await find_existing_media(folder, "12345");
    expect(found.media_path).toBe(media_path);
    expect(found.stem_path).toBe(
      path.join(folder, '"uid","12345","name","2026-01-01","desc"'),
    );
    const sidecars = sidecar_paths(found.stem_path);
    expect(sidecars.meta).toBe(`${found.stem_path}_meta.json`);
    expect(sidecars.comments).toBe(`${found.stem_path}_comments.json`);
    expect(sidecars.danmaku).toBe(`${found.stem_path}_danmaku.json`);
    expect(await find_existing_media(folder, "999")).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });
});
