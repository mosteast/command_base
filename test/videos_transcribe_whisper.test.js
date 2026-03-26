import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const videos_transcribe_whisper = require("../bin/videos_transcribe_whisper");

const { build_help_text, build_runtime_flags, normalize_formats } =
  videos_transcribe_whisper;

describe("videos_transcribe_whisper defaults", () => {
  it("defaults transcript outputs to vtt only without txt sidecars", () => {
    const runtime_flags = build_runtime_flags({});

    expect(normalize_formats(undefined)).toEqual(["vtt"]);
    expect(runtime_flags.should_generate_txt_conversion).toBe(false);
  });

  it("documents txt sidecars as opt-in", () => {
    const help_text = build_help_text("videos_transcribe_whisper");

    expect(help_text).toContain("--vtt2txt");
    expect(help_text).toContain(
      "Convert VTT outputs to TXT sidecars (default: false)",
    );
  });

  it("enables txt sidecars only when requested", () => {
    const runtime_flags = build_runtime_flags({ vtt2txt: true });

    expect(runtime_flags.should_generate_txt_conversion).toBe(true);
  });
});
