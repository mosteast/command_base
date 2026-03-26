import path from "node:path";
import { describe, expect, it } from "vitest";

import transcribe_media_module from "../lib/live_media/transcribe_media";

const {
  transcribe_media,
  get_default_model_for_provider,
  get_default_transcript_provider,
  list_transcript_providers,
  resolve_model_for_provider,
  resolve_transcript_provider,
} = transcribe_media_module;

describe("transcript provider defaults", () => {
  it("uses qwen3_asr as the default provider", () => {
    expect(get_default_transcript_provider()).toBe("qwen3_asr");
  });

  it("uses qwen3 as the default local model", () => {
    expect(get_default_model_for_provider("qwen3_asr")).toBe(
      "Qwen/Qwen3-ASR-0.6B",
    );
  });

  it("defaults transcript outputs to vtt only", async () => {
    const input_path = path.resolve("tmp/default-transcript-format.mp3");
    const result = await transcribe_media({
      inputPath: input_path,
      dryRun: true,
    });

    expect(result.outputs).toEqual([
      {
        format: "vtt",
        path: path.join(path.dirname(input_path), "default-transcript-format.vtt"),
      },
    ]);
    expect(result.path).toBe(
      path.join(path.dirname(input_path), "default-transcript-format.vtt"),
    );
  });

  it("plans transcript outputs using the requested output base name", async () => {
    const input_path = path.resolve("tmp/default-transcript-format.mp3");
    const output_dir = path.resolve("tmp/transcript-output-dir");
    const result = await transcribe_media({
      inputPath: input_path,
      outputDir: output_dir,
      outputBaseName: "custom_name",
      outputFormats: ["vtt", "txt"],
      dryRun: true,
    });

    expect(result.outputs).toEqual([
      {
        format: "vtt",
        path: path.join(output_dir, "custom_name.vtt"),
      },
      {
        format: "txt",
        path: path.join(output_dir, "custom_name.txt"),
      },
    ]);
    expect(result.path).toBe(path.join(output_dir, "custom_name.vtt"));
  });
});

describe("transcript provider resolution", () => {
  it("resolves numeric and short aliases", () => {
    expect(resolve_transcript_provider("1")).toBe("qwen3_asr");
    expect(resolve_transcript_provider("qwen")).toBe("qwen3_asr");
    expect(resolve_transcript_provider("2")).toBe("sensevoice");
    expect(resolve_transcript_provider("3")).toBe("whisper");
  });

  it("lists supported providers", () => {
    expect(list_transcript_providers()).toEqual([
      "qwen3_asr",
      "sensevoice",
      "whisper",
    ]);
  });
});

describe("provider model aliases", () => {
  it("maps qwen quality aliases to the larger checkpoint", () => {
    expect(resolve_model_for_provider("qwen3_asr", "best")).toBe(
      "Qwen/Qwen3-ASR-1.7B",
    );
    expect(resolve_model_for_provider("qwen3_asr", "fast")).toBe(
      "Qwen/Qwen3-ASR-0.6B",
    );
  });

  it("keeps sensevoice pinned to its single checkpoint", () => {
    expect(resolve_model_for_provider("sensevoice", "best")).toBe(
      "iic/SenseVoiceSmall",
    );
  });

  it("preserves existing whisper aliases", () => {
    expect(resolve_model_for_provider("whisper", "latest")).toBe("turbo");
    expect(resolve_model_for_provider("whisper", "best")).toBe("large-v3");
  });
});
