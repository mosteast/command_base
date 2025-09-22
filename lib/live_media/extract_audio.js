const fs = require("fs");
const path = require("path");

const { runCommand, ensureExecutable } = require("./process_utils");

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
    try {
      await fs.promises.unlink(resolvedOutput);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  async function attemptCopy() {
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
      resolvedOutput,
    ];
    await runCommand(ffmpegBin, args, {
      label: "ffmpeg (audio copy)",
      silent: commandSilent,
      onStdout: onCommandStdout,
      onStderr: onCommandStderr,
    });
    return { usedCopy: true, fallbackUsed: false };
  }

  async function attemptTranscode() {
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
    args.push("-movflags", "use_metadata_tags", resolvedOutput);
    await runCommand(ffmpegBin, args, {
      label: "ffmpeg (audio transcode)",
      silent: commandSilent,
      onStdout: onCommandStdout,
      onStderr: onCommandStderr,
    });
    return { usedCopy: false, fallbackUsed: true };
  }

  let result;
  if (preferCopy) {
    try {
      result = await attemptCopy();
    } catch (err) {
      if (!allowTranscodeFallback) throw err;
      logger.warn(
        "Direct audio track extraction failed, falling back to re-encoding...",
      );
      try {
        await fs.promises.unlink(resolvedOutput);
      } catch (unlinkErr) {
        if (unlinkErr.code !== "ENOENT")
          logger.warn(`Could not remove incomplete output: ${resolvedOutput}`);
      }
      result = await attemptTranscode();
    }
  } else {
    result = await attemptTranscode();
  }

  return {
    outputPath: resolvedOutput,
    codec: selectedStream.codec_name,
    streamIndex: audioStreamIndex,
    ...result,
  };
}

module.exports = {
  extractAudio,
  inferAudioExtension,
};
