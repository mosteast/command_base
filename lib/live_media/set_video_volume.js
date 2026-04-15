const fs = require("fs");
const path = require("path");

const { runCommand, ensureExecutable } = require("./process_utils");
const {
  build_bounded_output_path,
  create_short_temporary_output_path,
  limit_output_path_length,
} = require("./output_path_utils");
const { clear_hidden_flag_if_needed } = require("./file_visibility_utils");
const {
  cleanup_stale_temporary_artifacts,
} = require("./temporary_artifact_utils");

const DEFAULT_AUDIO_CODEC = "aac";
const DEFAULT_AUDIO_BITRATE = "192k";
const GENERATED_OUTPUT_MARKER = ".volume_";
const temporary_outputs = new Set();
let cleanup_registered = false;

function emit_debug_log(logger, debug, message) {
  if (!debug || !logger || typeof logger.debug !== "function") return;
  logger.debug(message);
}

function ensure_cleanup_registered() {
  if (cleanup_registered) return;
  cleanup_registered = true;
  process.on("exit", () => {
    for (const temp_path of temporary_outputs) {
      if (!temp_path) continue;
      try {
        if (typeof fs.rmSync === "function") {
          fs.rmSync(temp_path, { force: true });
        } else {
          fs.unlinkSync(temp_path);
        }
      } catch (error) {
        // Ignore shutdown cleanup failures.
      }
    }
    temporary_outputs.clear();
  });
}

function create_temporary_output_path(final_path) {
  return create_short_temporary_output_path(final_path, {
    label: "volume",
  });
}

async function ensure_parent_directory(file_path) {
  const directory = path.dirname(file_path);
  await fs.promises.mkdir(directory, { recursive: true });
}

async function remove_if_exists(target_path) {
  if (!target_path) return;
  try {
    await fs.promises.unlink(target_path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function finalize_temporary_output(temp_path, final_path, options = {}) {
  const { logger = console, debug = false } = options;
  await remove_if_exists(final_path);
  await fs.promises.rename(temp_path, final_path);
  await clear_hidden_flag_if_needed(final_path, { logger, debug });
}

async function cleanup_interrupted_volume_output(
  resolved_output_path,
  options = {},
) {
  const { logger = console, debug = false } = options;
  const stale_paths = await cleanup_stale_temporary_artifacts(
    resolved_output_path,
    {
      label: "volume",
      entry_kind: "file",
    },
  );
  if (!stale_paths.length) return;

  if (logger && typeof logger.warn === "function") {
    logger.warn(
      `Found interrupted volume output for ${path.basename(resolved_output_path)}; deleting ${stale_paths.length} stale temp file${stale_paths.length === 1 ? "" : "s"} and restarting.`,
    );
  }

  if (debug && logger && typeof logger.debug === "function") {
    stale_paths.forEach((candidate_path) => {
      logger.debug(`Removed stale volume temp output: ${candidate_path}`);
    });
  }
}

function normalize_numeric_token(value) {
  const trimmed_value = `${value ?? ""}`.trim();
  if (!trimmed_value) return "1";

  let token = trimmed_value.replace(/^\+/, "");
  token = token.replace(/^-/, "minus_");
  token = token.replace(/\./g, "_");
  token = token.replace(/[^a-zA-Z0-9_]+/g, "_");
  token = token.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return token || "1";
}

function build_volume_label(volume_value) {
  const volume_text = `${volume_value ?? ""}`.trim();
  if (!volume_text) return "custom";

  const percent_match = volume_text.match(/^([+-]?\d+(?:\.\d+)?)\s*%$/);
  if (percent_match) {
    return `${normalize_numeric_token(percent_match[1])}pct`;
  }

  const db_match = volume_text.match(/^([+-]?\d+(?:\.\d+)?)\s*dB$/i);
  if (db_match) {
    return `${normalize_numeric_token(db_match[1])}db`;
  }

  if (/^[+-]?\d+(?:\.\d+)?$/.test(volume_text)) {
    return `x${normalize_numeric_token(volume_text)}`;
  }

  const sanitized_label = volume_text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return sanitized_label || "custom";
}

function normalize_volume_value(volume_value) {
  const volume_text = `${volume_value ?? ""}`.trim();
  if (!volume_text) {
    throw new Error("--volume is required.");
  }

  const percent_match = volume_text.match(/^([+-]?\d+(?:\.\d+)?)\s*%$/);
  if (percent_match) {
    const percent_value = Number(percent_match[1]);
    return `${percent_value / 100}`;
  }

  const db_match = volume_text.match(/^([+-]?\d+(?:\.\d+)?)\s*dB$/i);
  if (db_match) {
    return `${db_match[1]}dB`;
  }

  if (/^[+-]?\d+(?:\.\d+)?$/.test(volume_text)) {
    return `${Number(volume_text)}`;
  }

  return volume_text;
}

function looks_like_volume_output(file_path) {
  const parsed_path = path.parse(path.resolve(file_path));
  return parsed_path.name.toLowerCase().includes(GENERATED_OUTPUT_MARKER);
}

function resolve_output_path(options = {}) {
  const {
    input_path,
    output_path,
    output_dir,
    volume_label,
  } = options;

  const absolute_input_path = path.resolve(input_path);
  const input_extension = path.extname(absolute_input_path) || ".mp4";

  if (output_path) {
    let resolved_output_path = path.resolve(output_path);
    if (!path.extname(resolved_output_path)) {
      resolved_output_path = `${resolved_output_path}${input_extension}`;
    }
    return limit_output_path_length(resolved_output_path);
  }

  const output_directory = output_dir
    ? path.resolve(output_dir)
    : path.dirname(absolute_input_path);
  const output_stem = path.basename(absolute_input_path, input_extension);
  return build_bounded_output_path({
    directory: output_directory,
    stem: output_stem,
    suffix: `${GENERATED_OUTPUT_MARKER}${volume_label}`,
    extension: input_extension,
  });
}

async function set_video_volume(options = {}) {
  const {
    input_path,
    output_path,
    output_dir,
    volume,
    audio_codec = DEFAULT_AUDIO_CODEC,
    audio_bitrate = DEFAULT_AUDIO_BITRATE,
    ffmpeg_path = "ffmpeg",
    refresh = false,
    dry_run = false,
    logger = console,
    debug = false,
    command_silent = false,
    onCommandStdout,
    onCommandStderr,
  } = options;

  if (!input_path) {
    throw new Error("set_video_volume: input_path is required.");
  }

  const resolved_audio_codec = `${audio_codec ?? ""}`.trim();
  if (!resolved_audio_codec) {
    throw new Error("Audio codec must not be empty.");
  }
  if (resolved_audio_codec.toLowerCase() === "copy") {
    throw new Error(
      "Audio codec cannot be copy when applying a volume filter. Use a real codec such as aac or libopus.",
    );
  }

  const absolute_input_path = path.resolve(input_path);
  emit_debug_log(logger, debug, `Checking source video: ${absolute_input_path}`);
  try {
    await fs.promises.access(absolute_input_path, fs.constants.R_OK);
  } catch (error) {
    throw new Error(`Input file not accessible: ${absolute_input_path}`);
  }

  const requested_volume = `${volume ?? ""}`.trim();
  const volume_expression = normalize_volume_value(requested_volume);
  const volume_label = build_volume_label(requested_volume);
  const resolved_output_path = resolve_output_path({
    input_path: absolute_input_path,
    output_path,
    output_dir,
    volume_label,
  });

  if (absolute_input_path === resolved_output_path) {
    throw new Error("Output path must be different from the input path.");
  }

  emit_debug_log(logger, debug, `Resolved volume output path: ${resolved_output_path}`);

  if (!refresh) {
    try {
      await fs.promises.access(resolved_output_path, fs.constants.F_OK);
      return {
        input_path: absolute_input_path,
        output_path: resolved_output_path,
        volume_expression,
        volume_label,
        skipped: true,
        skip_reason: "output_exists",
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  if (dry_run) {
    return {
      input_path: absolute_input_path,
      output_path: resolved_output_path,
      volume_expression,
      volume_label,
      audio_codec: resolved_audio_codec,
      audio_bitrate,
      dry_run: true,
    };
  }

  emit_debug_log(logger, debug, "Stage 1/3: resolving ffmpeg executable.");
  const ffmpeg_bin = await ensureExecutable(ffmpeg_path, "ffmpeg");
  emit_debug_log(
    logger,
    debug,
    `Stage 2/3: preparing output directory ${path.dirname(resolved_output_path)}.`,
  );
  await ensure_parent_directory(resolved_output_path);
  ensure_cleanup_registered();
  await cleanup_interrupted_volume_output(resolved_output_path, {
    logger,
    debug,
  });
  const temp_output_path = create_temporary_output_path(resolved_output_path);
  temporary_outputs.add(temp_output_path);

  const ffmpeg_args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    absolute_input_path,
    "-map",
    "0",
    "-c",
    "copy",
    "-filter:a",
    `volume=${volume_expression}`,
    "-c:a",
    resolved_audio_codec,
  ];

  if (audio_bitrate) {
    ffmpeg_args.push("-b:a", `${audio_bitrate}`);
  }

  ffmpeg_args.push(temp_output_path);

  if (logger && typeof logger.log === "function") {
    logger.log(
      `Setting video volume to ${volume_expression} for ${path.basename(absolute_input_path)}`,
    );
  }

  try {
    emit_debug_log(logger, debug, "Stage 3/3: running ffmpeg volume filter.");
    await runCommand(ffmpeg_bin, ffmpeg_args, {
      label: "ffmpeg (set video volume)",
      silent: command_silent,
      onStdout: onCommandStdout,
      onStderr: onCommandStderr,
      logger,
      debug,
    });
    await finalize_temporary_output(temp_output_path, resolved_output_path, {
      logger,
      debug,
    });

    return {
      input_path: absolute_input_path,
      output_path: resolved_output_path,
      volume_expression,
      volume_label,
      audio_codec: resolved_audio_codec,
      audio_bitrate,
    };
  } catch (error) {
    await remove_if_exists(temp_output_path);
    throw error;
  } finally {
    temporary_outputs.delete(temp_output_path);
  }
}

module.exports = {
  DEFAULT_AUDIO_BITRATE,
  DEFAULT_AUDIO_CODEC,
  GENERATED_OUTPUT_MARKER,
  build_volume_label,
  looks_like_volume_output,
  normalize_volume_value,
  resolve_output_path,
  set_video_volume,
};
