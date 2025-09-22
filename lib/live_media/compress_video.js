const fs = require("fs");
const path = require("path");

const { runCommand, ensureExecutable } = require("./process_utils");

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
  const directory = path.dirname(final_path);
  const base_name = path.basename(final_path);
  const unique_suffix = `${process.pid}-${Date.now().toString(16)}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const temp_name = `.${base_name}.tmp-${unique_suffix}`;
  return path.join(directory, temp_name);
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
    maxHeight = 1080,
    keepResolution = false,
    tune,
    extraArgs = [],
    ffmpegPath = "ffmpeg",
    logger = console,
    commandSilent = false,
    onCommandStdout,
    onCommandStderr,
  } = options;

  if (!inputPath) {
    throw new Error("compressVideo: inputPath is required.");
  }

  const absoluteInput = path.resolve(inputPath);
  try {
    await fs.promises.access(absoluteInput, fs.constants.R_OK);
  } catch (err) {
    throw new Error(`Video file not accessible: ${absoluteInput}`);
  }

  const ffmpegBin = await ensureExecutable(ffmpegPath, "ffmpeg");

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
    resolvedOutput = path.join(
      dirName,
      `${baseName}.compressed.${presetLabel}.mp4`,
    );
  }

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
  } else {
    await remove_if_exists(resolvedOutput);
  }

  await ensure_parent_directory(resolvedOutput);
  ensure_cleanup_registered();
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
    pixFormat,
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
    });

    await finalize_temporary_output(temp_output_path, resolvedOutput);

    return {
      outputPath: resolvedOutput,
      crf,
      preset: presetValue,
      codec: videoCodec,
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
};
