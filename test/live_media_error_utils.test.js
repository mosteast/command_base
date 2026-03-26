import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  format_stage_failure_message,
  resolve_error_message,
} = require("../lib/live_media/error_utils");

describe("live_media error utils", () => {
  it("falls back when the error only contains empty object placeholders", () => {
    const resolved = resolve_error_message(
      {
        stderr: "{}",
        stdout: "",
        message: "[object Object]",
      },
      "Unknown error",
    );

    expect(resolved).toBe("Unknown error");
  });

  it("uses nested original error output when available", () => {
    const resolved = resolve_error_message({
      originalError: {
        stderr: "ffmpeg: invalid data found",
      },
    });

    expect(resolved).toBe("ffmpeg: invalid data found");
  });

  it("formats stage failures with the offending file path", () => {
    const message = format_stage_failure_message(
      "Audio extraction",
      "~/video/broken.mp4",
      "Unknown error",
    );

    expect(message).toBe(
      "Audio extraction failed for ~/video/broken.mp4: Unknown error",
    );
  });
});
