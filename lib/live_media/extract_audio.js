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
        // Ignore cleanup failures on exit.
      }
    }
    temporary_outputs.clear();
  });
}

function create_temporary_output_path(final_path) {
  const directory = path.dirname(final_path);
  const { name, ext } = path.parse(final_path);
  const unique_suffix = `${process.pid}-${Date.now().toString(16)}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const normalized_extension = ext || "";
  const temp_name = `.${name}.tmp-${unique_suffix}${normalized_extension}`;
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

const KNOWN_AUDIO_EXTENSIONS = new Set([
  "m4a",
  "m4b",
  "m4r",
  "mp3",
  "mp2",
  "aac",
  "ac3",
  "eac3",
  "oga",
  "ogg",
  "opus",
  "flac",
  "wav",
  "aif",
  "aiff",
  "aifc",
  "caf",
  "wv",
  "wma",
  "mka",
  "weba",
]);

function normalizeExtensionValue(value) {
  if (!value) return "";
  return String(value).trim().replace(/^[.]+/, "").toLowerCase();
}

function inferAudioExtension(codec) {
  const normalized = (codec || "").toLowerCase();
  const map = {
    aac: "m4a",
    alac: "m4a",
    mp3: "mp3",
    opus: "opus",
    vorbis: "ogg",
    flac: "flac",
    eac3: "m4a",
    ac3: "ac3",
    pcm_s16le: "wav",
    pcm_s24le: "wav",
    pcm_f32le: "wav",
  };
  return map[normalized] || "m4a";
}

async function probeAudioStreams(ffprobeBin, inputPath) {
  const args = [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_streams",
    "-select_streams",
    "a",
    inputPath,
  ];
  const { stdout } = await runCommand(ffprobeBin, args, {
    capture: true,
    label: "ffprobe (audio probe)",
  });
  const data = JSON.parse(stdout || "{}");
  return Array.isArray(data.streams) ? data.streams : [];
}

async function extractAudio(options = {}) {
  const {
    inputPath,
    outputPath,
    outputExtension,
    audioStreamIndex = 0,
    force = false,
    preferCopy = true,
    allowTranscodeFallback = true,
    fallbackCodec = "aac",
    fallbackBitrate = "192k",
    fallbackSampleRate,
    ffmpegPath = "ffmpeg",
    ffprobePath = "ffprobe",
    logger = console,
    commandSilent = false,
    onCommandStdout,
    onCommandStderr,
  } = options;

  if (!inputPath) {
    throw new Error("extractAudio: inputPath is required.");
  }

  const absoluteInput = path.resolve(inputPath);
  try {
    await fs.promises.access(absoluteInput, fs.constants.R_OK);
  } catch (err) {
    throw new Error(`Input file not accessible: ${absoluteInput}`);
  }

  const [ffmpegBin, ffprobeBin] = await Promise.all([
    ensureExecutable(ffmpegPath, "ffmpeg"),
    ensureExecutable(ffprobePath, "ffprobe"),
  ]);

  const streams = await probeAudioStreams(ffprobeBin, absoluteInput);
  if (!streams.length) {
    throw new Error("No audio streams found in source.");
  }

  if (audioStreamIndex < 0 || audioStreamIndex >= streams.length) {
    throw new Error(
      `Requested audio stream index ${audioStreamIndex} is out of range (found ${streams.length} audio streams).`,
    );
  }

  const selectedStream = streams[audioStreamIndex];
  const inferredExtension = inferAudioExtension(selectedStream.codec_name);
  const requestedExtension = normalizeExtensionValue(outputExtension);
  const fallbackExtension = normalizeExtensionValue(inferredExtension) || "m4a";
  const targetExtension = requestedExtension || fallbackExtension;

  let resolvedOutput = outputPath ? path.resolve(outputPath) : "";
  if (!resolvedOutput) {
    const baseName = path.basename(absoluteInput, path.extname(absoluteInput));
    const dirName = path.dirname(absoluteInput);
    resolvedOutput = path.join(dirName, `${baseName}.${targetExtension}`);
  } else {
    const existingExtWithDot = path.extname(resolvedOutput);
    const existingExtension = normalizeExtensionValue(existingExtWithDot);
    const hasRecognizedExtension = existingExtension
      ? KNOWN_AUDIO_EXTENSIONS.has(existingExtension)
      : false;
    if (requestedExtension) {
      if (existingExtension !== requestedExtension) {
        const basePath = existingExtWithDot
          ? resolvedOutput.slice(0, -existingExtWithDot.length)
          : resolvedOutput;
        resolvedOutput = `${basePath}.${requestedExtension}`;
      }
    } else if (!existingExtension || !hasRecognizedExtension) {
      const sanitizedBase = resolvedOutput.replace(/[.]+$/, "");
      resolvedOutput = `${sanitizedBase}.${targetExtension}`;
    }
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

  async function attempt_copy() {
    const args = [
      force ? "-y" : "-n",
      "-i",
      absoluteInput,
      "-map",
      `0:a:${audioStreamIndex}`,
      "-vn",
      "-c:a",
      "copy",
      "-movflags",
      "use_metadata_tags",
      temp_output_path,
    ];
    await runCommand(ffmpegBin, args, {
      label: "ffmpeg (audio copy)",
      silent: commandSilent,
      onStdout: onCommandStdout,
      onStderr: onCommandStderr,
    });
    return { usedCopy: true, fallbackUsed: false };
  }

  async function attempt_transcode() {
    const args = [
      force ? "-y" : "-n",
      "-i",
      absoluteInput,
      "-map",
      `0:a:${audioStreamIndex}`,
      "-vn",
      "-c:a",
      fallbackCodec,
      "-b:a",
      fallbackBitrate,
    ];
    if (fallbackSampleRate) {
      args.push("-ar", String(fallbackSampleRate));
    }
    args.push("-movflags", "use_metadata_tags", temp_output_path);
    await runCommand(ffmpegBin, args, {
      label: "ffmpeg (audio transcode)",
      silent: commandSilent,
      onStdout: onCommandStdout,
      onStderr: onCommandStderr,
    });
    return { usedCopy: false, fallbackUsed: true };
  }

  let result;
  try {
    if (preferCopy) {
      try {
        result = await attempt_copy();
      } catch (err) {
        if (!allowTranscodeFallback) throw err;
        logger.warn(
          "Direct audio track extraction failed, falling back to re-encoding...",
        );
        await remove_if_exists(temp_output_path);
        result = await attempt_transcode();
      }
    } else {
      result = await attempt_transcode();
    }

    await finalize_temporary_output(temp_output_path, resolvedOutput);

    return {
      outputPath: resolvedOutput,
      codec: selectedStream.codec_name,
      streamIndex: audioStreamIndex,
      ...result,
    };
  } catch (err) {
    await remove_if_exists(temp_output_path);
    throw err;
  } finally {
    temporary_outputs.delete(temp_output_path);
  }
}

module.exports = {
  extractAudio,
  inferAudioExtension,
};
