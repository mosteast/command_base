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

const temporary_outputs = new Set();
let cleanup_registered = false;

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
      } catch (err) {
        // Ignore cleanup failures on shutdown.
      }
    }
    temporary_outputs.clear();
  });
}

function create_temporary_output_path(final_path) {
  return create_short_temporary_output_path(final_path, {
    label: "compress",
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
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

async function finalize_temporary_output(temp_path, final_path) {
  await remove_if_exists(final_path);
  await fs.promises.rename(temp_path, final_path);
  await clear_hidden_flag_if_needed(final_path);
}

async function cleanup_interrupted_compression_output(
  resolved_output,
  options = {},
) {
  const { logger = console, debug = false } = options;
  const stale_paths = await cleanup_stale_temporary_artifacts(resolved_output, {
    label: "compress",
    entry_kind: "file",
  });
  if (!stale_paths.length) return;

  if (logger && typeof logger.warn === "function") {
    logger.warn(
      `Found interrupted compression output for ${path.basename(resolved_output)}; deleting ${stale_paths.length} stale temp file${stale_paths.length === 1 ? "" : "s"} and restarting.`,
    );
  }

  if (debug && logger && typeof logger.debug === "function") {
    stale_paths.forEach((candidate) => {
      logger.debug(`Removed stale compression temp output: ${candidate}`);
    });
  }
}

async function compressVideo(options = {}) {
  const {
    inputPath,
    outputPath,
    force = false,
    crf = 23,
    preset = "medium",
    audioBitrate = "128k",
    videoCodec = "libx264",
    audioCodec = "aac",
    pixFormat = "yuv420p",
    pixelFormat,
    maxHeight = 1080,
    keepResolution = false,
    tune,
    extraArgs = [],
    ffmpegPath = "ffmpeg",
    logger = console,
    debug = false,
    dryRun = false,
    commandSilent = false,
    onCommandStdout,
    onCommandStderr,
  } = options;

  if (!inputPath) {
    throw new Error("compressVideo: inputPath is required.");
  }

  const absoluteInput = path.resolve(inputPath);
  if (debug && logger && typeof logger.debug === "function") {
    logger.debug(`Checking video input: ${absoluteInput}`);
  }
  try {
    await fs.promises.access(absoluteInput, fs.constants.R_OK);
  } catch (err) {
    throw new Error(`Video file not accessible: ${absoluteInput}`);
  }

  let presetValue = preset;
  if (presetValue === undefined || presetValue === null) {
    presetValue = "medium";
  } else {
    presetValue = `${presetValue}`.trim() || "medium";
  }
  const presetLabel = presetValue.replace(/\s+/g, "-");
  let resolvedOutput = outputPath ? path.resolve(outputPath) : "";
  if (!resolvedOutput) {
    const dirName = path.dirname(absoluteInput);
    const baseName = path.basename(absoluteInput, path.extname(absoluteInput));
    resolvedOutput = build_bounded_output_path({
      directory: dirName,
      stem: baseName,
      suffix: `.compressed.${presetLabel}`,
      extension: ".mp4",
    });
  } else {
    resolvedOutput = limit_output_path_length(resolvedOutput);
  }
  const resolved_pix_format = `${pixelFormat || pixFormat || "yuv420p"}`;

  if (!force) {
    try {
      await fs.promises.access(resolvedOutput, fs.constants.F_OK);
      const existsError = new Error(
        `Output already exists: ${resolvedOutput}. Pass --force to overwrite.`,
      );
      existsError.code = "OUTPUT_EXISTS";
      existsError.outputPath = resolvedOutput;
      throw existsError;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  } else if (!dryRun) {
    await remove_if_exists(resolvedOutput);
  }

  if (dryRun) {
    if (logger && typeof logger.log === "function") {
      logger.log(
        `[dry-run] Would compress ${absoluteInput} -> ${resolvedOutput} (CRF ${crf}, preset ${presetValue}, pix_fmt ${resolved_pix_format})`,
      );
    }
    return {
      outputPath: resolvedOutput,
      crf,
      preset: presetValue,
      codec: videoCodec,
      pixFormat: resolved_pix_format,
      dryRun: true,
    };
  }

  const ffmpegBin = await ensureExecutable(ffmpegPath, "ffmpeg");

  if (debug && logger && typeof logger.debug === "function") {
    logger.debug(
      `Ensuring compression output directory: ${path.dirname(resolvedOutput)}`,
    );
  }
  await ensure_parent_directory(resolvedOutput);
  ensure_cleanup_registered();
  await cleanup_interrupted_compression_output(resolvedOutput, {
    logger,
    debug,
  });
  const temp_output_path = create_temporary_output_path(resolvedOutput);
  temporary_outputs.add(temp_output_path);

  const args = [
    force ? "-y" : "-n",
    "-i",
    absoluteInput,
    "-c:v",
    videoCodec,
    "-preset",
    presetValue,
    "-crf",
    String(crf),
  ];

  if (!keepResolution && maxHeight) {
    args.push("-vf", `scale=-2:min(ih\\,${maxHeight})`);
  }

  if (tune) {
    args.push("-tune", tune);
  }

  args.push(
    "-pix_fmt",
    resolved_pix_format,
    "-c:a",
    audioCodec,
    "-b:a",
    audioBitrate,
    "-movflags",
    "+faststart",
  );

  if (Array.isArray(extraArgs) && extraArgs.length) {
    args.push(...extraArgs);
  }

  args.push(temp_output_path);

  logger.log(
    `Compressing video to ${path.basename(resolvedOutput)} (CRF ${crf}, preset ${presetValue})`,
  );
  try {
    await runCommand(ffmpegBin, args, {
      label: "ffmpeg (compress video)",
      silent: commandSilent,
      onStdout: onCommandStdout,
      onStderr: onCommandStderr,
      logger,
      debug,
    });

    await finalize_temporary_output(temp_output_path, resolvedOutput);

    return {
      outputPath: resolvedOutput,
      crf,
      preset: presetValue,
      codec: videoCodec,
      pixFormat: resolved_pix_format,
    };
  } catch (err) {
    await remove_if_exists(temp_output_path);
    throw err;
  } finally {
    temporary_outputs.delete(temp_output_path);
  }
}

module.exports = {
  compressVideo,
  create_temporary_output_path,
};
