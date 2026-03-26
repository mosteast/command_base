import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const extract_burnt_subtitles_module = require(
  "../lib/live_media/extract_burnt_subtitles",
);

const {
  build_preferred_segments,
  build_segments,
  extract_burnt_subtitles,
  parse_tesseract_tsv,
  resolve_output_path,
} = extract_burnt_subtitles_module;

const temporary_directories = [];

async function create_temp_directory() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "extract-burnt-subtitles-"),
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

describe("extract_burnt_subtitles helpers", () => {
  it("parses tesseract TSV into subtitle text with line grouping", () => {
    const tsv_text = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "5\t1\t1\t1\t1\t1\t10\t10\t40\t10\t95\tHello",
      "5\t1\t1\t1\t1\t2\t55\t10\t55\t10\t92\tworld!",
      "5\t1\t1\t1\t2\t1\t10\t30\t12\t10\t88\t你",
      "5\t1\t1\t1\t2\t2\t24\t30\t12\t10\t84\t好",
      "5\t1\t1\t1\t2\t3\t38\t30\t12\t10\t80\t世",
      "5\t1\t1\t1\t2\t4\t52\t30\t12\t10\t78\t界",
    ].join("\n");

    const parsed = parse_tesseract_tsv(tsv_text);

    expect(parsed.text).toBe("Hello world!\n你好世界");
    expect(parsed.lines).toEqual([
      {
        text: "Hello world!",
        confidence: 93.5,
        word_count: 2,
      },
      {
        text: "你好世界",
        confidence: 82.5,
        word_count: 4,
      },
    ]);
    expect(parsed.confidence).toBeCloseTo(86.166, 2);
    expect(parsed.word_count).toBe(6);
  });

  it("merges similar OCR frames into one subtitle segment", () => {
    const segments = build_segments(
      [
        {
          start_time: 0,
          end_time: 0.5,
          text: "Hello world",
          confidence: 94,
        },
        {
          start_time: 0.5,
          end_time: 1.0,
          text: "Hello world",
          confidence: 91,
        },
        {
          start_time: 1.0,
          end_time: 1.5,
          text: "",
          confidence: 0,
        },
        {
          start_time: 1.5,
          end_time: 2.0,
          text: "hello world!",
          confidence: 88,
        },
      ],
      {
        similarity_threshold: 0.8,
        merge_gap_seconds: 0.6,
        min_duration_seconds: 0.4,
      },
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      start_time: 0,
      end_time: 2,
      text: "Hello world",
      sample_count: 3,
    });
    expect(segments[0].confidence).toBeCloseTo(91, 0);
  });

  it("falls back to low-confidence OCR text when the strict pass finds nothing", () => {
    const result = build_preferred_segments(
      [
        {
          start_time: 0,
          end_time: 0.5,
          text: "",
          raw_text: "First line",
          confidence: 18,
        },
        {
          start_time: 0.5,
          end_time: 1.0,
          text: "",
          raw_text: "First line",
          confidence: 22,
        },
      ],
      {
        min_duration_seconds: 0.4,
      },
    );

    expect(result.used_relaxed_ocr).toBe(true);
    expect(result.segments).toEqual([
      {
        start_time: 0,
        end_time: 1,
        duration: 1,
        text: "First line",
        confidence: 20,
        sample_count: 2,
      },
    ]);
  });

  it("plans output paths during dry-run and skips existing outputs before OCR", async () => {
    const directory = await create_temp_directory();
    const input_path = path.join(directory, "clip.mp4");
    const output_directory = path.join(directory, "subtitle");
    const existing_output_path = path.join(output_directory, "clip.vtt");

    await fs.writeFile(input_path, "");
    await fs.mkdir(output_directory, { recursive: true });
    await fs.writeFile(existing_output_path, "WEBVTT\n");

    const planned_output_path = resolve_output_path({
      input_path,
      output_dir: output_directory,
      output_format: "vtt",
    });
    expect(planned_output_path).toBe(existing_output_path);

    const dry_run_result = await extract_burnt_subtitles({
      input_path,
      output_dir: path.join(directory, "planned"),
      output_format: "srt",
      dry_run: true,
    });

    expect(dry_run_result).toMatchObject({
      dry_run: true,
      output_path: path.join(directory, "planned", "clip.srt"),
      output_format: "srt",
      sample_fps: 2,
    });
    expect(dry_run_result.frame_filter).toContain("fps=2");

    const skipped_result = await extract_burnt_subtitles({
      input_path,
      output_dir: output_directory,
      output_format: "vtt",
    });

    expect(skipped_result).toEqual({
      input_path: path.resolve(input_path),
      output_path: existing_output_path,
      output_format: "vtt",
      skipped: true,
      skip_reason: "output_exists",
    });
  });
});
