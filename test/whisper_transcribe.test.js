import { afterEach, describe, expect, it } from "vitest";

import whisper_transcribe_module from "../lib/live_media/whisper_transcribe";

const { get_default_whisper_model, resolve_model_for_flavor } =
  whisper_transcribe_module;

const original_whisper_default_model = process.env.WHISPER_DEFAULT_MODEL;

afterEach(() => {
  if (original_whisper_default_model === undefined) {
    delete process.env.WHISPER_DEFAULT_MODEL;
    return;
  }

  process.env.WHISPER_DEFAULT_MODEL = original_whisper_default_model;
});

describe("whisper model defaults", () => {
  it("uses large-v3 as the local default model", () => {
    delete process.env.WHISPER_DEFAULT_MODEL;

    expect(get_default_whisper_model()).toBe("large-v3");
  });

  it("honors WHISPER_DEFAULT_MODEL when provided", () => {
    process.env.WHISPER_DEFAULT_MODEL = "turbo";

    expect(get_default_whisper_model()).toBe("turbo");
  });
});

describe("whisper model aliases", () => {
  it("maps best-quality aliases to large-v3", () => {
    expect(resolve_model_for_flavor("best")).toBe("large-v3");
    expect(resolve_model_for_flavor("strongest")).toBe("large-v3");
    expect(resolve_model_for_flavor("most-powerful")).toBe("large-v3");
  });

  it("maps latest and speed aliases to turbo", () => {
    expect(resolve_model_for_flavor("latest")).toBe("turbo");
    expect(resolve_model_for_flavor("newest")).toBe("turbo");
    expect(resolve_model_for_flavor("fast")).toBe("turbo");
    expect(resolve_model_for_flavor("large-v3-turbo")).toBe("turbo");
  });

  it("passes explicit model ids through unchanged", () => {
    expect(resolve_model_for_flavor("large-v3")).toBe("large-v3");
    expect(resolve_model_for_flavor("medium")).toBe("medium");
  });
});
