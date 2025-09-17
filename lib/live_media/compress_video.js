const fs = require("fs");
const path = require("path");

const { runCommand, ensureExecutable } = require("./process_utils");

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

  let resolvedOutput = outputPath ? path.resolve(outputPath) : "";
  if (!resolvedOutput) {
    const dirName = path.dirname(absoluteInput);
    const baseName = path.basename(absoluteInput, path.extname(absoluteInput));
    resolvedOutput = path.join(dirName, `${baseName}.compressed.mp4`);
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

  const args = [
    force ? "-y" : "-n",
    "-i",
    absoluteInput,
    "-c:v",
    videoCodec,
    "-preset",
    preset,
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

  args.push(resolvedOutput);

  logger.log(
    `Compressing video to ${path.basename(resolvedOutput)} (CRF ${crf}, preset ${preset})`,
  );
  await runCommand(ffmpegBin, args, { label: "ffmpeg (compress video)" });

  return {
    outputPath: resolvedOutput,
    crf,
    preset,
    codec: videoCodec,
  };
}

module.exports = {
  compressVideo,
};
