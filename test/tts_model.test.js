import path from "path";
import os from "os";
import { describe, it, expect } from "vitest";

import ttsModelModule from "../lib/tts_model";
import xttsModule from "../lib/tts_model/xtts_v2";

const { list_tts_models, get_tts_model, default_tts_model_id } = ttsModelModule;
const { xtts_v2_model } = xttsModule;

function create_silent_logger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

describe("tts model registry", () => {
  it("selects index-tts as the default model", () => {
    const models = list_tts_models();
    expect(models).toContain("index-tts");
    expect(default_tts_model_id).toBe("index-tts");
  });

  it("returns fully-formed model entries", () => {
    const model = get_tts_model("xtts-v2");
    expect(model).toHaveProperty("tts_model_id", "xtts-v2");
    expect(typeof model.synthesize_text).toBe("function");
    expect(model.model_label.length).toBeGreaterThan(0);
  });

  it("throws when requesting an unknown model", () => {
    expect(() => get_tts_model("non-existent")).toThrow(/Unknown TTS model/);
  });
});

describe("xtts v2 plugin", () => {
  it("supports dry-run without API credentials", async () => {
    const logger = create_silent_logger();
    const output_file_path = path.join(os.tmpdir(), `xtts-${Date.now()}.wav`);

    const result = await xtts_v2_model.synthesize_text({
      text_content: "Hello world",
      output_file_path,
      audio_format: "wav",
      dry_run: true,
      logger,
    });

    expect(result.model_id).toBe("xtts-v2");
    expect(result.audio_format).toBe("wav");
    expect(result.bytes_written).toBe(0);
  });
});
