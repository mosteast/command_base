import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import set_video_volume_module from "../lib/live_media/set_video_volume";

const {
  build_volume_label,
  looks_like_volume_output,
  normalize_volume_value,
  set_video_volume,
} = set_video_volume_module;

const temporary_directories = [];

async function create_temp_directory() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "set-video-volume-"),
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

describe("set_video_volume helpers", () => {
  it("normalizes common volume formats", () => {
    expect(normalize_volume_value("150%")).toBe("1.5");
    expect(normalize_volume_value("+6dB")).toBe("+6dB");
    expect(normalize_volume_value("1.25")).toBe("1.25");
    expect(build_volume_label("150%")).toBe("150pct");
    expect(build_volume_label("+6dB")).toBe("6db");
    expect(looks_like_volume_output("/tmp/example.volume_150pct.mp4")).toBe(
      true,
    );
  });
});

describe("set_video_volume", () => {
  it("plans output paths during dry-run", async () => {
    const directory = await create_temp_directory();
    const input_path = path.join(directory, "sample.mp4");
    await fs.writeFile(input_path, "");

    const result = await set_video_volume({
      input_path,
      volume: "150%",
      dry_run: true,
      logger: {
        log: () => {},
        debug: () => {},
      },
    });

    expect(result.dry_run).toBe(true);
    expect(result.volume_expression).toBe("1.5");
    expect(result.output_path).toContain(".volume_150pct.mp4");
  });

  it("skips existing output before invoking ffmpeg", async () => {
    const directory = await create_temp_directory();
    const input_path = path.join(directory, "sample.mp4");
    const output_path = path.join(directory, "sample.volume_150pct.mp4");
    await fs.writeFile(input_path, "");
    await fs.writeFile(output_path, "");

    const result = await set_video_volume({
      input_path,
      volume: "150%",
      logger: {
        log: () => {},
        debug: () => {},
      },
    });

    expect(result.skipped).toBe(true);
    expect(result.skip_reason).toBe("output_exists");
    expect(result.output_path).toBe(output_path);
  });
});
