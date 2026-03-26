import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  MAX_FILE_NAME_BYTES,
  build_bounded_output_path,
  create_short_temporary_output_path,
  limit_output_path_length,
} = require("../lib/live_media/output_path_utils");

describe("live_media output path utils", () => {
  it("preserves the compression suffix when the stem is too long", () => {
    const output_path = build_bounded_output_path({
      directory: "/tmp",
      stem: "a".repeat(236),
      suffix: ".compressed.medium",
      extension: ".mp4",
    });
    const base_name = path.basename(output_path);

    expect(base_name.endsWith(".compressed.medium.mp4")).toBe(true);
    expect(Buffer.byteLength(base_name, "utf8")).toBeLessThanOrEqual(
      MAX_FILE_NAME_BYTES,
    );
  });

  it("creates short temporary media paths for near-limit outputs", () => {
    const final_path = build_bounded_output_path({
      directory: "/tmp",
      stem: "a".repeat(232),
      suffix: ".compressed.medium",
      extension: ".mp4",
    });
    const temp_path = create_short_temporary_output_path(final_path, {
      label: "compress",
    });
    const temp_base_name = path.basename(temp_path);

    expect(temp_base_name.startsWith("__in_progress-compress-")).toBe(true);
    expect(temp_base_name.endsWith(".mp4")).toBe(true);
    expect(Buffer.byteLength(temp_base_name, "utf8")).toBeLessThanOrEqual(
      MAX_FILE_NAME_BYTES,
    );
  });

  it("trims oversized explicit output paths without breaking utf8 characters", () => {
    const output_path = limit_output_path_length(
      path.join("/tmp", `${"你".repeat(90)}.mp4`),
    );
    const base_name = path.basename(output_path);

    expect(base_name.endsWith(".mp4")).toBe(true);
    expect(Buffer.byteLength(base_name, "utf8")).toBeLessThanOrEqual(
      MAX_FILE_NAME_BYTES,
    );
  });
});
