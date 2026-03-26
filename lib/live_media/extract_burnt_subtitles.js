const fs = require("fs");
const path = require("path");

const {
  runCommand: run_command,
  ensureExecutable: ensure_executable,
} = require("./process_utils");
const {
  build_bounded_output_path,
  create_short_temporary_output_path,
} = require("./output_path_utils");
const { clear_hidden_flag_if_needed } = require("./file_visibility_utils");
const {
  cleanup_stale_temporary_artifacts,
  create_temporary_directory_prefix,
} = require("./temporary_artifact_utils");

const DEFAULT_OUTPUT_FORMAT = "srt";
const SUPPORTED_OUTPUT_FORMATS = ["srt", "vtt", "json"];
const DEFAULT_SAMPLE_FPS = 2;
const DEFAULT_REGION_PRESET = "bottom";
const DEFAULT_SCALE_MULTIPLIER = 2;
const DEFAULT_OCR_PSM = 6;
const DEFAULT_MIN_CONFIDENCE = 30;
const DEFAULT_MIN_TEXT_LENGTH = 2;
const DEFAULT_MIN_DURATION_SECONDS = 0.6;
const DEFAULT_MERGE_GAP_SECONDS = 0.8;
const DEFAULT_TEXT_SIMILARITY = 0.84;
const DEFAULT_OCR_CONCURRENCY = 2;
const DEFAULT_LANGUAGE = "eng";

const REGION_PRESETS = {
  bottom: {
    x: 0,
    y: 0.5,
    width: 1,
    height: 0.44,
  },
  top: {
    x: 0,
    y: 0.04,
    width: 1,
    height: 0.3,
  },
  full: {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  },
};

const CJK_CHARACTER_PATTERN =
  /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;
const SUBTITLE_SIGNAL_PATTERN =
  /[A-Za-z0-9\u00c0-\u024f\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;

const temporary_directories = new Set();
let cleanup_registered = false;

function ensure_cleanup_registered() {
  if (cleanup_registered) return;
  cleanup_registered = true;
  process.on("exit", () => {
    for (const directory_path of temporary_directories) {
      if (!directory_path) continue;
      try {
        if (typeof fs.rmSync === "function") {
          fs.rmSync(directory_path, { recursive: true, force: true });
        }
      } catch (error) {
        // Ignore cleanup failures during process exit.
      }
    }
    temporary_directories.clear();
  });
}

function emit_debug_log(logger, is_debug_enabled, message) {
  if (!is_debug_enabled) return;
  if (!logger || typeof logger.debug !== "function") return;
  logger.debug(message);
}

function parse_number(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric_value = Number(value);
  if (Number.isNaN(numeric_value)) {
    throw new Error(`Invalid value for ${label}: ${value}`);
  }
  return numeric_value;
}

function parse_output_format(value) {
  const normalized_value = `${value || DEFAULT_OUTPUT_FORMAT}`
    .trim()
    .toLowerCase();
  if (!SUPPORTED_OUTPUT_FORMATS.includes(normalized_value)) {
    throw new Error(
      `Unsupported output format: ${value}. Supported formats: ${SUPPORTED_OUTPUT_FORMATS.join(", ")}`,
    );
  }
  return normalized_value;
}

function parse_crop_box(value) {
  if (!value) return undefined;
  const parts = `${value}`
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length !== 4) {
    throw new Error(
      `Invalid crop box: ${value}. Expected normalized x,y,width,height values.`,
    );
  }
  const [x, y, width, height] = parts.map((part) =>
    parse_number(part, "--crop"),
  );
  const candidate_box = { x, y, width, height };
  validate_crop_box(candidate_box);
  return candidate_box;
}

function validate_crop_box(box) {
  if (!box) {
    throw new Error("Crop box is required.");
  }
  const keys = ["x", "y", "width", "height"];
  keys.forEach((key) => {
    const value = box[key];
    if (typeof value !== "number" || Number.isNaN(value)) {
      throw new Error(`Invalid crop box value for ${key}.`);
    }
    if (value < 0 || value > 1) {
      throw new Error(`Crop box ${key} must be between 0 and 1.`);
    }
  });
  if (box.width <= 0 || box.height <= 0) {
    throw new Error("Crop box width and height must be greater than 0.");
  }
  if (box.x + box.width > 1 || box.y + box.height > 1) {
    throw new Error("Crop box must fit inside the source video frame.");
  }
}

function resolve_crop_box(options = {}) {
  const { region = DEFAULT_REGION_PRESET, crop } = options;
  if (crop) {
    validate_crop_box(crop);
    return crop;
  }
  const normalized_region = `${region || DEFAULT_REGION_PRESET}`
    .trim()
    .toLowerCase();
  const preset = REGION_PRESETS[normalized_region];
  if (!preset) {
    throw new Error(
      `Unsupported region preset: ${region}. Supported presets: ${Object.keys(
        REGION_PRESETS,
      ).join(", ")}`,
    );
  }
  return { ...preset };
}

function format_decimal(value, digits = 6) {
  return Number(value).toFixed(digits).replace(/\.?0+$/, "");
}

function build_frame_filter(options = {}) {
  const {
    sample_fps = DEFAULT_SAMPLE_FPS,
    crop_box = resolve_crop_box(),
    scale_multiplier = DEFAULT_SCALE_MULTIPLIER,
  } = options;

  validate_crop_box(crop_box);

  const normalized_fps = parse_number(sample_fps, "--fps");
  if (!normalized_fps || normalized_fps <= 0) {
    throw new Error("--fps must be greater than 0.");
  }

  const normalized_scale = parse_number(scale_multiplier, "--scale");
  if (!normalized_scale || normalized_scale <= 0) {
    throw new Error("--scale must be greater than 0.");
  }

  return [
    `fps=${format_decimal(normalized_fps, 4)}`,
    `crop=iw*${format_decimal(crop_box.width)}:ih*${format_decimal(
      crop_box.height,
    )}:iw*${format_decimal(crop_box.x)}:ih*${format_decimal(crop_box.y)}`,
    `scale=iw*${format_decimal(normalized_scale, 3)}:-1:flags=lanczos`,
    "format=gray",
    "eq=contrast=1.35:brightness=0.04",
    "unsharp=5:5:1.0:5:5:0.0",
  ].join(",");
}

function resolve_output_path(options = {}) {
  const {
    input_path,
    output_path,
    output_dir,
    output_format = DEFAULT_OUTPUT_FORMAT,
    output_base_name,
  } = options;

  if (!input_path) {
    throw new Error("resolve_output_path: input_path is required.");
  }

  const resolved_format = parse_output_format(output_format);
  if (output_path) {
    const absolute_output_path = path.resolve(output_path);
    const parsed_output = path.parse(absolute_output_path);
    const resolved_extension = `.${resolved_format}`;
    const next_base = path.join(parsed_output.dir, parsed_output.name);
    return `${next_base}${resolved_extension}`;
  }

  const absolute_input_path = path.resolve(input_path);
  const parsed_input = path.parse(absolute_input_path);
  const target_directory = output_dir
    ? path.resolve(output_dir)
    : parsed_input.dir;
  const target_stem = `${output_base_name || parsed_input.name}`.trim();
  if (!target_stem) {
    throw new Error("Output base name resolved to an empty value.");
  }

  return build_bounded_output_path({
    directory: target_directory,
    stem: target_stem,
    extension: `.${resolved_format}`,
  });
}

function create_temporary_directory(target_path) {
  return fs.promises.mkdir(path.dirname(target_path), { recursive: true }).then(
    async () => {
      const prefix = create_temporary_directory_prefix(target_path, {
        label: "burnt-subtitles",
      });
      const temporary_directory = await fs.promises.mkdtemp(prefix);
      ensure_cleanup_registered();
      temporary_directories.add(temporary_directory);
      return temporary_directory;
    },
  );
}

async function remove_directory_if_exists(directory_path) {
  if (!directory_path) return;
  try {
    if (typeof fs.promises.rm === "function") {
      await fs.promises.rm(directory_path, { recursive: true, force: true });
    } else {
      await fs.promises.rmdir(directory_path, { recursive: true });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function remove_file_if_exists(file_path) {
  if (!file_path) return;
  try {
    await fs.promises.unlink(file_path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function ensure_readable_file(file_path) {
  await fs.promises.access(path.resolve(file_path), fs.constants.R_OK);
}

async function path_exists(file_path) {
  try {
    await fs.promises.access(file_path, fs.constants.F_OK);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function write_output_file(output_path, content, options = {}) {
  const { logger = console, debug = false } = options;
  emit_debug_log(
    logger,
    debug,
    `Preparing subtitle output directory: ${path.dirname(output_path)}`,
  );
  await fs.promises.mkdir(path.dirname(output_path), { recursive: true });
  await cleanup_stale_temporary_artifacts(output_path, {
    label: "burnt-subtitles",
    entry_kind: "file",
  });

  const temporary_output_path = create_short_temporary_output_path(output_path, {
    label: "burnt-subtitles",
  });
  emit_debug_log(logger, debug, `Writing subtitle output: ${temporary_output_path}`);
  await fs.promises.writeFile(temporary_output_path, content, "utf8");
  await remove_file_if_exists(output_path);
  await fs.promises.rename(temporary_output_path, output_path);
  await clear_hidden_flag_if_needed(output_path, { logger, debug });
}

function build_frame_records(frame_file_names, sample_fps) {
  const frame_duration_seconds = 1 / sample_fps;
  return frame_file_names.map((file_name) => {
    const match = file_name.match(/(\d+)\.png$/i);
    if (!match) {
      throw new Error(`Unexpected frame file name: ${file_name}`);
    }
    const frame_index = Number(match[1]);
    return {
      file_name,
      frame_index,
      start_time: frame_index / sample_fps,
      end_time: frame_index / sample_fps + frame_duration_seconds,
    };
  });
}

async function extract_sample_frames(options = {}) {
  const {
    input_path,
    frame_directory,
    sample_fps = DEFAULT_SAMPLE_FPS,
    crop_box = resolve_crop_box(),
    scale_multiplier = DEFAULT_SCALE_MULTIPLIER,
    ffmpeg_path = "ffmpeg",
    logger = console,
    debug = false,
  } = options;

  if (!input_path) {
    throw new Error("extract_sample_frames: input_path is required.");
  }
  if (!frame_directory) {
    throw new Error("extract_sample_frames: frame_directory is required.");
  }

  emit_debug_log(
    logger,
    debug,
    `Checking video input before frame extraction: ${input_path}`,
  );
  await ensure_readable_file(input_path);
  emit_debug_log(logger, debug, `Preparing frame directory: ${frame_directory}`);
  await fs.promises.mkdir(frame_directory, { recursive: true });

  const ffmpeg_bin = await ensure_executable(ffmpeg_path, "ffmpeg");
  const frame_filter = build_frame_filter({
    sample_fps,
    crop_box,
    scale_multiplier,
  });
  const output_pattern = path.join(frame_directory, "frame_%06d.png");

  emit_debug_log(
    logger,
    debug,
    `Extracting subtitle-region frames with filter: ${frame_filter}`,
  );
  await run_command(
    ffmpeg_bin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      path.resolve(input_path),
      "-an",
      "-sn",
      "-vf",
      frame_filter,
      "-start_number",
      "0",
      output_pattern,
    ],
    {
      label: "ffmpeg (burnt subtitle frame extraction)",
      logger,
      debug,
      silent: true,
    },
  );

  emit_debug_log(logger, debug, `Reading extracted frames from: ${frame_directory}`);
  const frame_file_names = (await fs.promises.readdir(frame_directory))
    .filter((file_name) => /^frame_\d+\.png$/i.test(file_name))
    .sort();

  if (!frame_file_names.length) {
    throw new Error("No frames were extracted from the input video.");
  }

  return {
    frame_filter,
    frame_records: build_frame_records(frame_file_names, sample_fps),
  };
}

function split_tsv_line(line) {
  return `${line}`.split("\t");
}

function join_ocr_tokens(tokens) {
  let joined_text = "";
  for (const token of tokens) {
    if (!token) continue;
    if (!joined_text) {
      joined_text = token;
      continue;
    }

    const previous_character = joined_text.slice(-1);
    const next_character = token.slice(0, 1);
    const both_cjk =
      CJK_CHARACTER_PATTERN.test(previous_character) &&
      CJK_CHARACTER_PATTERN.test(next_character);
    const next_is_tight_punctuation = /^[,.;:!?%)}\]\u3001\u3002\uff01\uff1f\uff0c\uff1a\uff1b]/u.test(
      token,
    );
    const previous_is_opening_punctuation = /[(\[{'"“‘\u300c\u300e]$/u.test(
      joined_text,
    );

    if (both_cjk || next_is_tight_punctuation || previous_is_opening_punctuation) {
      joined_text += token;
      continue;
    }

    joined_text += ` ${token}`;
  }
  return joined_text;
}

function parse_tesseract_tsv(tsv_text) {
  const lines = `${tsv_text || ""}`
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.length > 0);

  if (!lines.length) {
    return {
      text: "",
      confidence: 0,
      lines: [],
      word_count: 0,
    };
  }

  const header = split_tsv_line(lines[0]);
  const header_index = new Map(header.map((name, index) => [name, index]));
  if (!header_index.has("text")) {
    return {
      text: "",
      confidence: 0,
      lines: [],
      word_count: 0,
    };
  }

  const grouped_lines = new Map();
  let total_confidence = 0;
  let word_count = 0;

  for (let index = 1; index < lines.length; index += 1) {
    const columns = split_tsv_line(lines[index]);
    const level = Number(columns[header_index.get("level")] || "0");
    if (level !== 5) continue;

    const raw_text = columns[header_index.get("text")] || "";
    const token = `${raw_text}`.trim();
    if (!token) continue;

    const raw_confidence = Number(columns[header_index.get("conf")] || "-1");
    if (Number.isNaN(raw_confidence) || raw_confidence < 0) continue;

    const line_key = [
      columns[header_index.get("block_num")] || "0",
      columns[header_index.get("par_num")] || "0",
      columns[header_index.get("line_num")] || "0",
    ].join(":");

    if (!grouped_lines.has(line_key)) {
      grouped_lines.set(line_key, {
        tokens: [],
        confidence_total: 0,
        word_count: 0,
      });
    }

    const current_group = grouped_lines.get(line_key);
    current_group.tokens.push(token);
    current_group.confidence_total += raw_confidence;
    current_group.word_count += 1;

    total_confidence += raw_confidence;
    word_count += 1;
  }

  const line_entries = Array.from(grouped_lines.values())
    .map((entry) => ({
      text: join_ocr_tokens(entry.tokens),
      confidence:
        entry.word_count > 0
          ? entry.confidence_total / entry.word_count
          : 0,
      word_count: entry.word_count,
    }))
    .filter((entry) => entry.text.trim().length > 0);

  return {
    text: line_entries.map((entry) => entry.text).join("\n"),
    confidence: word_count > 0 ? total_confidence / word_count : 0,
    lines: line_entries,
    word_count,
  };
}

function normalize_subtitle_text(value) {
  const normalized_lines = `${value || ""}`
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(
          /([\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af])\s+([\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af])/gu,
          "$1$2",
        )
        .replace(/\s+([,.;:!?%)}\]\u3001\u3002\uff01\uff1f\uff0c\uff1a\uff1b])/gu, "$1")
        .replace(/([(\[{\u300c\u300e])\s+/gu, "$1"),
    );

  return normalized_lines.join("\n");
}

function looks_like_subtitle_text(value, options = {}) {
  const { min_text_length = DEFAULT_MIN_TEXT_LENGTH } = options;
  const normalized_text = normalize_subtitle_text(value);
  if (!normalized_text) return false;

  const signal_characters = Array.from(normalized_text).filter((character) =>
    SUBTITLE_SIGNAL_PATTERN.test(character),
  );
  if (signal_characters.length < min_text_length) {
    return false;
  }

  const total_visible_characters = Array.from(normalized_text).filter(
    (character) => character.trim().length > 0,
  ).length;
  if (!total_visible_characters) return false;

  return signal_characters.length / total_visible_characters >= 0.35;
}

function build_text_fingerprint(value) {
  return normalize_subtitle_text(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(
      /[^a-z0-9\u00c0-\u024f\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function calculate_levenshtein_distance(left_value, right_value) {
  const left = `${left_value || ""}`;
  const right = `${right_value || ""}`;
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  const previous_row = new Array(right.length + 1);
  const current_row = new Array(right.length + 1);

  for (let column_index = 0; column_index <= right.length; column_index += 1) {
    previous_row[column_index] = column_index;
  }

  for (let row_index = 1; row_index <= left.length; row_index += 1) {
    current_row[0] = row_index;
    for (
      let column_index = 1;
      column_index <= right.length;
      column_index += 1
    ) {
      const substitution_cost =
        left[row_index - 1] === right[column_index - 1] ? 0 : 1;
      current_row[column_index] = Math.min(
        previous_row[column_index] + 1,
        current_row[column_index - 1] + 1,
        previous_row[column_index - 1] + substitution_cost,
      );
    }
    for (
      let column_index = 0;
      column_index <= right.length;
      column_index += 1
    ) {
      previous_row[column_index] = current_row[column_index];
    }
  }

  return previous_row[right.length];
}

function calculate_text_similarity(left_value, right_value) {
  const left = build_text_fingerprint(left_value);
  const right = build_text_fingerprint(right_value);
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  if (left === right) return 1;
  const longest_length = Math.max(left.length, right.length);
  if (!longest_length) return 1;
  const distance = calculate_levenshtein_distance(left, right);
  return Math.max(0, 1 - distance / longest_length);
}

function choose_segment_text(segment) {
  let best_variant = segment.text;
  let best_score = -1;

  for (const [variant_text, variant_data] of segment.variant_map.entries()) {
    const candidate_score =
      variant_data.confidence_total + variant_data.count * 8;
    if (candidate_score > best_score) {
      best_variant = variant_text;
      best_score = candidate_score;
    }
  }

  segment.text = best_variant;
  segment.fingerprint = build_text_fingerprint(best_variant);
}

function create_segment_from_frame(frame_entry) {
  const variant_map = new Map();
  variant_map.set(frame_entry.text, {
    count: 1,
    confidence_total: frame_entry.confidence,
  });
  return {
    start_time: frame_entry.start_time,
    end_time: frame_entry.end_time,
    text: frame_entry.text,
    fingerprint: build_text_fingerprint(frame_entry.text),
    confidence_total: frame_entry.confidence,
    sample_count: 1,
    variant_map,
  };
}

function extend_segment(segment, frame_entry) {
  segment.end_time = frame_entry.end_time;
  segment.sample_count += 1;
  segment.confidence_total += frame_entry.confidence;
  if (!segment.variant_map.has(frame_entry.text)) {
    segment.variant_map.set(frame_entry.text, {
      count: 0,
      confidence_total: 0,
    });
  }
  const variant_entry = segment.variant_map.get(frame_entry.text);
  variant_entry.count += 1;
  variant_entry.confidence_total += frame_entry.confidence;
  choose_segment_text(segment);
}

function build_raw_segments(frame_entries, options = {}) {
  const { similarity_threshold = DEFAULT_TEXT_SIMILARITY } = options;
  const segments = [];
  let current_segment = null;

  for (const frame_entry of frame_entries) {
    if (!frame_entry.text) {
      current_segment = null;
      continue;
    }

    if (!current_segment) {
      current_segment = create_segment_from_frame(frame_entry);
      segments.push(current_segment);
      continue;
    }

    const similarity = calculate_text_similarity(
      current_segment.text,
      frame_entry.text,
    );
    if (similarity >= similarity_threshold) {
      extend_segment(current_segment, frame_entry);
      continue;
    }

    current_segment = create_segment_from_frame(frame_entry);
    segments.push(current_segment);
  }

  segments.forEach((segment) => {
    choose_segment_text(segment);
  });
  return segments;
}

function merge_adjacent_segments(segments, options = {}) {
  const {
    similarity_threshold = DEFAULT_TEXT_SIMILARITY,
    merge_gap_seconds = DEFAULT_MERGE_GAP_SECONDS,
  } = options;

  const merged_segments = [];

  for (const segment of segments) {
    const previous_segment = merged_segments[merged_segments.length - 1];
    if (!previous_segment) {
      merged_segments.push({ ...segment, variant_map: new Map(segment.variant_map) });
      continue;
    }

    const gap_seconds = segment.start_time - previous_segment.end_time;
    const similarity = calculate_text_similarity(
      previous_segment.text,
      segment.text,
    );
    if (gap_seconds <= merge_gap_seconds && similarity >= similarity_threshold) {
      previous_segment.end_time = segment.end_time;
      previous_segment.sample_count += segment.sample_count;
      previous_segment.confidence_total += segment.confidence_total;

      for (const [variant_text, variant_data] of segment.variant_map.entries()) {
        if (!previous_segment.variant_map.has(variant_text)) {
          previous_segment.variant_map.set(variant_text, {
            count: 0,
            confidence_total: 0,
          });
        }
        const previous_variant = previous_segment.variant_map.get(variant_text);
        previous_variant.count += variant_data.count;
        previous_variant.confidence_total += variant_data.confidence_total;
      }

      choose_segment_text(previous_segment);
      continue;
    }

    merged_segments.push({ ...segment, variant_map: new Map(segment.variant_map) });
  }

  return merged_segments;
}

function finalize_segments(segments, options = {}) {
  const { min_duration_seconds = DEFAULT_MIN_DURATION_SECONDS } = options;
  return segments
    .map((segment) => ({
      start_time: segment.start_time,
      end_time: segment.end_time,
      duration: Math.max(0, segment.end_time - segment.start_time),
      text: normalize_subtitle_text(segment.text),
      confidence:
        segment.sample_count > 0
          ? segment.confidence_total / segment.sample_count
          : 0,
      sample_count: segment.sample_count,
    }))
    .filter(
      (segment) =>
        segment.text &&
        segment.duration >= min_duration_seconds &&
        looks_like_subtitle_text(segment.text),
    );
}

function build_segments(frame_entries, options = {}) {
  const raw_segments = build_raw_segments(frame_entries, options);
  const merged_segments = merge_adjacent_segments(raw_segments, options);
  return finalize_segments(merged_segments, options);
}

async function run_with_concurrency(items, concurrency_limit, runner) {
  const limited_concurrency = Math.max(
    1,
    Math.min(concurrency_limit, items.length || 1),
  );
  const results = new Array(items.length);
  let next_index = 0;

  async function worker() {
    for (;;) {
      if (next_index >= items.length) return;
      const current_index = next_index;
      next_index += 1;
      results[current_index] = await runner(items[current_index], current_index);
    }
  }

  await Promise.all(
    Array.from({ length: limited_concurrency }, () => worker()),
  );
  return results;
}

async function ocr_frame(frame_path, options = {}) {
  const {
    tesseract_bin,
    language = DEFAULT_LANGUAGE,
    ocr_psm = DEFAULT_OCR_PSM,
    min_confidence = DEFAULT_MIN_CONFIDENCE,
    min_text_length = DEFAULT_MIN_TEXT_LENGTH,
    logger = console,
    debug = false,
  } = options;

  if (!tesseract_bin) {
    throw new Error("ocr_frame: tesseract_bin is required.");
  }
  emit_debug_log(logger, debug, `Running OCR on frame: ${frame_path}`);
  const command_arguments = [frame_path, "stdout"];
  if (language) {
    command_arguments.push("-l", language);
  }
  command_arguments.push("--psm", `${ocr_psm}`, "tsv");

  const { stdout } = await run_command(tesseract_bin, command_arguments, {
    capture: true,
    label: "tesseract (burnt subtitle OCR)",
    logger,
    debug,
  });

  const parsed_tsv = parse_tesseract_tsv(stdout);
  const normalized_text = normalize_subtitle_text(parsed_tsv.text);
  const confidence = parsed_tsv.confidence;
  const is_confident = confidence >= min_confidence;
  const has_subtitle_signal = looks_like_subtitle_text(normalized_text, {
    min_text_length,
  });
  const signal_text = has_subtitle_signal ? normalized_text : "";

  return {
    text: is_confident ? signal_text : "",
    confidence,
    raw_text: signal_text,
  };
}

async function ocr_frames(frame_records, options = {}) {
  const {
    frame_directory,
    tesseract_path = "tesseract",
    ocr_concurrency = DEFAULT_OCR_CONCURRENCY,
    logger = console,
    debug = false,
  } = options;

  const tesseract_bin = await ensure_executable(tesseract_path, "tesseract");
  emit_debug_log(
    logger,
    debug,
    `Starting OCR for ${frame_records.length} frame(s) with concurrency ${ocr_concurrency}.`,
  );

  return await run_with_concurrency(
    frame_records,
    ocr_concurrency,
    async (frame_record) => {
      const frame_path = path.join(frame_directory, frame_record.file_name);
      const ocr_result = await ocr_frame(frame_path, {
        ...options,
        tesseract_bin,
        logger,
        debug,
      });
      return {
        ...frame_record,
        ...ocr_result,
      };
    },
  );
}

function format_timestamp_srt(total_seconds) {
  const clamped_ms = Math.max(0, Math.round(total_seconds * 1000));
  const hours = Math.floor(clamped_ms / 3600000);
  const minutes = Math.floor((clamped_ms % 3600000) / 60000);
  const seconds = Math.floor((clamped_ms % 60000) / 1000);
  const milliseconds = clamped_ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0",
  )}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(
    3,
    "0",
  )}`;
}

function format_timestamp_vtt(total_seconds) {
  return format_timestamp_srt(total_seconds).replace(",", ".");
}

function serialize_srt(segments) {
  return segments
    .map(
      (segment, index) =>
        `${index + 1}\n${format_timestamp_srt(segment.start_time)} --> ${format_timestamp_srt(segment.end_time)}\n${segment.text}`,
    )
    .join("\n\n");
}

function serialize_vtt(segments) {
  const body = segments
    .map(
      (segment) =>
        `${format_timestamp_vtt(segment.start_time)} --> ${format_timestamp_vtt(segment.end_time)}\n${segment.text}`,
    )
    .join("\n\n");
  return body ? `WEBVTT\n\n${body}\n` : "WEBVTT\n";
}

function serialize_json(segments, metadata = {}) {
  return `${JSON.stringify(
    {
      ...metadata,
      subtitle_count: segments.length,
      subtitles: segments,
    },
    null,
    2,
  )}\n`;
}

function serialize_output(segments, options = {}) {
  const { output_format = DEFAULT_OUTPUT_FORMAT, metadata = {} } = options;
  const resolved_format = parse_output_format(output_format);
  if (resolved_format === "vtt") {
    return serialize_vtt(segments);
  }
  if (resolved_format === "json") {
    return serialize_json(segments, metadata);
  }
  return serialize_srt(segments);
}

function build_preferred_segments(frame_entries, options = {}) {
  const strict_segments = build_segments(frame_entries, options);
  if (strict_segments.length) {
    return {
      segments: strict_segments,
      used_relaxed_ocr: false,
    };
  }

  const relaxed_frame_entries = frame_entries.map((frame_entry) => ({
    ...frame_entry,
    text: normalize_subtitle_text(frame_entry.raw_text || ""),
  }));
  const relaxed_segments = build_segments(relaxed_frame_entries, options);
  if (relaxed_segments.length) {
    return {
      segments: relaxed_segments,
      used_relaxed_ocr: true,
    };
  }

  return {
    segments: [],
    used_relaxed_ocr: false,
  };
}

async function extract_burnt_subtitles(options = {}) {
  const {
    input_path,
    output_path,
    output_dir,
    output_format = DEFAULT_OUTPUT_FORMAT,
    output_base_name,
    ffmpeg_path = "ffmpeg",
    tesseract_path = "tesseract",
    sample_fps = DEFAULT_SAMPLE_FPS,
    region = DEFAULT_REGION_PRESET,
    crop,
    scale_multiplier = DEFAULT_SCALE_MULTIPLIER,
    language = DEFAULT_LANGUAGE,
    ocr_psm = DEFAULT_OCR_PSM,
    min_confidence = DEFAULT_MIN_CONFIDENCE,
    min_text_length = DEFAULT_MIN_TEXT_LENGTH,
    min_duration_seconds = DEFAULT_MIN_DURATION_SECONDS,
    merge_gap_seconds = DEFAULT_MERGE_GAP_SECONDS,
    similarity_threshold = DEFAULT_TEXT_SIMILARITY,
    ocr_concurrency = DEFAULT_OCR_CONCURRENCY,
    refresh = false,
    keep_artifacts = false,
    dry_run = false,
    logger = console,
    debug = false,
  } = options;

  if (!input_path) {
    throw new Error("extract_burnt_subtitles: input_path is required.");
  }

  const absolute_input_path = path.resolve(input_path);
  const resolved_output_format = parse_output_format(output_format);
  const crop_box = resolve_crop_box({
    region,
    crop,
  });
  const resolved_output_path = resolve_output_path({
    input_path: absolute_input_path,
    output_path,
    output_dir,
    output_format: resolved_output_format,
    output_base_name,
  });

  emit_debug_log(logger, debug, `Checking source video: ${absolute_input_path}`);
  await ensure_readable_file(absolute_input_path);
  emit_debug_log(
    logger,
    debug,
    `Resolved subtitle output path: ${resolved_output_path}`,
  );

  if (!refresh && (await path_exists(resolved_output_path))) {
    return {
      input_path: absolute_input_path,
      output_path: resolved_output_path,
      output_format: resolved_output_format,
      skipped: true,
      skip_reason: "output_exists",
    };
  }

  if (dry_run) {
    return {
      input_path: absolute_input_path,
      output_path: resolved_output_path,
      output_format: resolved_output_format,
      dry_run: true,
      frame_filter: build_frame_filter({
        sample_fps,
        crop_box,
        scale_multiplier,
      }),
      sample_fps,
      region,
      crop_box,
      language,
      ocr_psm,
      min_confidence,
      min_duration_seconds,
      merge_gap_seconds,
      similarity_threshold,
    };
  }

  emit_debug_log(logger, debug, "Stage 1/4: preparing temporary work directory.");
  await cleanup_stale_temporary_artifacts(resolved_output_path, {
    label: "burnt-subtitles",
    entry_kind: "directory",
    include_extension: false,
  });
  const frame_directory = await create_temporary_directory(resolved_output_path);

  try {
    emit_debug_log(logger, debug, "Stage 2/4: extracting subtitle-region frames.");
    const frame_result = await extract_sample_frames({
      input_path: absolute_input_path,
      frame_directory,
      sample_fps,
      crop_box,
      scale_multiplier,
      ffmpeg_path,
      logger,
      debug,
    });

    emit_debug_log(logger, debug, "Stage 3/4: OCR on extracted frames.");
    const frame_entries = await ocr_frames(frame_result.frame_records, {
      frame_directory,
      tesseract_path,
      language,
      ocr_psm,
      min_confidence,
      min_text_length,
      ocr_concurrency,
      logger,
      debug,
    });

    emit_debug_log(logger, debug, "Stage 4/4: merging OCR results into subtitles.");
    const confident_frame_count = frame_entries.filter(
      (frame_entry) => frame_entry.text,
    ).length;
    const raw_text_frame_count = frame_entries.filter(
      (frame_entry) => frame_entry.raw_text,
    ).length;
    const { segments, used_relaxed_ocr } = build_preferred_segments(
      frame_entries,
      {
        similarity_threshold,
        merge_gap_seconds,
        min_duration_seconds,
      },
    );

    if (used_relaxed_ocr && logger && typeof logger.warn === "function") {
      logger.warn(
        "OCR confidence stayed below the configured threshold for most sampled frames; using relaxed subtitle fallback.",
      );
    }
    if (!segments.length && logger && typeof logger.warn === "function") {
      logger.warn(
        "No subtitle segments were detected. Try --region full, --region top, --keep-artifacts, or a lower --min-confidence value.",
      );
    }

    const output_content = serialize_output(segments, {
      output_format: resolved_output_format,
      metadata: {
        input_path: absolute_input_path,
        output_path: resolved_output_path,
        sample_fps,
        frame_filter: frame_result.frame_filter,
      },
    });

    await write_output_file(resolved_output_path, output_content, {
      logger,
      debug,
    });

    return {
      input_path: absolute_input_path,
      output_path: resolved_output_path,
      output_format: resolved_output_format,
      frame_count: frame_entries.length,
      confident_frame_count,
      raw_text_frame_count,
      subtitle_count: segments.length,
      subtitles: segments,
      used_relaxed_ocr,
      skipped: false,
    };
  } finally {
    if (keep_artifacts) {
      temporary_directories.delete(frame_directory);
      emit_debug_log(
        logger,
        debug,
        `Keeping OCR artifacts at: ${frame_directory}`,
      );
    } else {
      emit_debug_log(
        logger,
        debug,
        `Cleaning temporary frame directory: ${frame_directory}`,
      );
      await remove_directory_if_exists(frame_directory);
      temporary_directories.delete(frame_directory);
    }
  }
}

module.exports = {
  DEFAULT_LANGUAGE,
  DEFAULT_MERGE_GAP_SECONDS,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MIN_DURATION_SECONDS,
  DEFAULT_MIN_TEXT_LENGTH,
  DEFAULT_OCR_CONCURRENCY,
  DEFAULT_OCR_PSM,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_REGION_PRESET,
  DEFAULT_SAMPLE_FPS,
  DEFAULT_SCALE_MULTIPLIER,
  DEFAULT_TEXT_SIMILARITY,
  REGION_PRESETS,
  SUPPORTED_OUTPUT_FORMATS,
  build_frame_filter,
  build_segments,
  build_text_fingerprint,
  calculate_text_similarity,
  build_preferred_segments,
  extract_burnt_subtitles,
  format_timestamp_srt,
  format_timestamp_vtt,
  looks_like_subtitle_text,
  normalize_subtitle_text,
  parse_crop_box,
  parse_number,
  parse_output_format,
  parse_tesseract_tsv,
  resolve_crop_box,
  resolve_output_path,
  serialize_output,
  serialize_srt,
  serialize_vtt,
};
