import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import whisper_transcribe_module from "../lib/live_media/whisper_transcribe";

const {
  transcribeWithWhisper,
  get_default_whisper_model,
  resolve_model_for_flavor,
} = whisper_transcribe_module;

const original_whisper_default_model = process.env.WHISPER_DEFAULT_MODEL;
const temporary_directories = [];

async function create_temp_directory() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "whisper-transcribe-"),
  );
  temporary_directories.push(directory);
  return directory;
}

afterEach(() => {
  if (original_whisper_default_model === undefined) {
    delete process.env.WHISPER_DEFAULT_MODEL;
  } else {
    process.env.WHISPER_DEFAULT_MODEL = original_whisper_default_model;
  }
});

afterEach(async () => {
  await Promise.all(
    temporary_directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
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

describe("whisper transcription", () => {
  it("completes a non-dry-run transcript without referencing an undefined debug flag", async () => {
    const directory = await create_temp_directory();
    const input_path = path.join(directory, "sample.mp3");
    const whisper_path = path.join(directory, "whisper");
    await fs.writeFile(input_path, "fake audio", "utf8");
    await fs.writeFile(
      whisper_path,
      [
        "#!/bin/sh",
        'output_dir=""',
        'output_format="txt"',
        'input_path=""',
        'previous_arg=""',
        'for arg in "$@"; do',
        '  if [ "$previous_arg" = "--output_dir" ]; then',
        '    output_dir="$arg"',
        '    previous_arg=""',
        "    continue",
        "  fi",
        '  if [ "$previous_arg" = "--output_format" ]; then',
        '    output_format="$arg"',
        '    previous_arg=""',
        "    continue",
        "  fi",
        '  case "$arg" in',
        "    --output_dir|--output_format)",
        '      previous_arg="$arg"',
        "      ;;",
        "    *)",
        '      input_path="$arg"',
        "      ;;",
        "  esac",
        "done",
        'base_name="$(basename "$input_path")"',
        'base_name="${base_name%.*}"',
        'mkdir -p "$output_dir"',
        "printf 'WEBVTT\\n\\n00:00.000 --> 00:01.000\\nhello\\n' > \"$output_dir/$base_name.$output_format\"",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(whisper_path, 0o755);

    const result = await transcribeWithWhisper({
      inputPath: input_path,
      whisperPath: whisper_path,
      logger: {
        log() {},
        warn() {},
        debug() {},
      },
    });

    expect(result.outputs).toEqual([
      {
        format: "vtt",
        path: path.join(directory, "sample.vtt"),
      },
    ]);
    expect(result.primaryOutput).toBe(path.join(directory, "sample.vtt"));
    await expect(
      fs.readFile(path.join(directory, "sample.vtt"), "utf8"),
    ).resolves.toContain("Speaker 1: hello");
  });
});
