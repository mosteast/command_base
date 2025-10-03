import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it, expect } from "vitest";

import cliHelperModule from "../lib/tts/tts_cli_helper";

const {
  normalize_concurrency,
  build_synthesis_jobs,
  parse_additional_options,
} = cliHelperModule;

describe("normalize_concurrency", () => {
  it("returns default for invalid inputs", () => {
    expect(normalize_concurrency(Number.NaN)).toBe(2);
    expect(normalize_concurrency("3")).toBe(2);
  });

  it("clamps values within bounds", () => {
    expect(normalize_concurrency(0)).toBe(1);
    expect(normalize_concurrency(1)).toBe(1);
    expect(normalize_concurrency(5)).toBe(5);
    expect(normalize_concurrency(99)).toBe(8);
  });
});

describe("parse_additional_options", () => {
  it("parses JSON strings", () => {
    const parsed = parse_additional_options('{"tone":"warm"}');
    expect(parsed).toEqual({ tone: "warm" });
  });

  it("throws on invalid JSON", () => {
    expect(() => parse_additional_options("{invalid}")).toThrow(
      /Failed to parse additional options JSON/,
    );
  });

  it("returns undefined for empty inputs", () => {
    expect(parse_additional_options("")).toBeUndefined();
    expect(parse_additional_options(null)).toBeUndefined();
  });
});

describe("build_synthesis_jobs", () => {
  it("creates job entries and detects existing outputs", async () => {
    const temp_root = await fs.mkdtemp(
      path.join(os.tmpdir(), "text-to-speech-"),
    );
    const input_path = path.join(temp_root, "sample.txt");
    await fs.writeFile(input_path, "Hello world");

    const jobs_initial = await build_synthesis_jobs({
      input_files: [input_path],
      output_dir: temp_root,
      audio_format: "wav",
      force: false,
      model_id: "xtts-v2",
      cwd: temp_root,
    });

    expect(jobs_initial).toHaveLength(1);
    expect(jobs_initial[0].skip_reason).toBeNull();

    const expected_output = path.join(temp_root, "sample.xtts-v2.wav");
    await fs.writeFile(expected_output, "fake audio");

    const jobs_after = await build_synthesis_jobs({
      input_files: [input_path],
      output_dir: temp_root,
      audio_format: "wav",
      force: false,
      model_id: "xtts-v2",
      cwd: temp_root,
    });

    expect(jobs_after[0].skip_reason).toBe("existing output");
    expect(jobs_after[0].output_file_path).toBe(expected_output);
  });

  it("ignores existing outputs when force is true", async () => {
    const temp_root = await fs.mkdtemp(
      path.join(os.tmpdir(), "text-to-speech-"),
    );
    const input_path = path.join(temp_root, "sample.txt");
    await fs.writeFile(input_path, "Hello world");
    const expected_output = path.join(temp_root, "sample.xtts-v2.wav");
    await fs.writeFile(expected_output, "fake audio");

    const jobs = await build_synthesis_jobs({
      input_files: [input_path],
      output_dir: temp_root,
      audio_format: "wav",
      force: true,
      model_id: "xtts-v2",
      cwd: temp_root,
    });

    expect(jobs[0].skip_reason).toBeNull();
  });
});
