import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import compress_video_module from "../lib/live_media/compress_video";

const { compressVideo } = compress_video_module;
const temporary_directories = [];

async function create_temp_directory() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "compress-video-dry-run-"),
  );
  temporary_directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporary_directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("compressVideo dry-run", () => {
  it("honors pixelFormat alias during planning", async () => {
    const directory = await create_temp_directory();
    const input_path = path.join(directory, "sample.mp4");
    await fs.writeFile(input_path, "");

    const result = await compressVideo({
      inputPath: input_path,
      dryRun: true,
      pixelFormat: "nv12",
      logger: {
        log: () => {},
        debug: () => {},
      },
    });

    expect(result.dryRun).toBe(true);
    expect(result.pixFormat).toBe("nv12");
    expect(result.outputPath).toContain(".compressed.medium.mp4");
  });
});
