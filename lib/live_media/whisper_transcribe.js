const fs = require("fs");
const path = require("path");

const {
  runCommand,
  ensureExecutable,
  resolveExecutable,
} = require("./process_utils");

const DEFAULT_FORMATS = ["srt", "vtt"];
const ALL_FORMATS = ["txt", "vtt", "srt", "tsv", "json"];
const SPEAKER_PREFIX = "Speaker 1: ";

function detectFlavor(resolvedPath) {
  const name = path.basename(resolvedPath);
  if (name === "whisper" || name === "whisper.py") return "openai-whisper";
  if (name.includes("ctranslate") || name.includes("faster"))
    return "ctranslate2";
  return "openai-whisper";
}

async function resolveWhisperBinary(options = {}) {
  const {
    whisperPath,
    candidates = ["whisper", "whisper-ctranslate2", "faster-whisper"],
  } = options;

  if (whisperPath) {
    const resolved = await ensureExecutable(whisperPath, "whisper");
    return { binary: resolved, flavor: detectFlavor(resolved) };
  }

  for (const candidate of candidates) {
    const resolved = await resolveExecutable(candidate);
    if (resolved) {
      return { binary: resolved, flavor: detectFlavor(resolved) };
    }
  }

  const err = new Error(
    "No whisper-compatible executable found. Install openai-whisper (pip install git+https://github.com/openai/whisper.git) or faster-whisper, or provide --whisper-bin.",
  );
  err.code = "WHISPER_NOT_FOUND";
  throw err;
}

function buildArgsForFlavor(flavor, opts) {
  const args = [];
  const {
    inputPath,
    model,
    language,
    task,
    temperature,
    beamSize,
    bestOf,
    device,
    outputFormat,
    outputDir,
    extraArgs = [],
    computeType,
  } = opts;

  if (flavor === "ctranslate2") {
    if (task) {
      args.push("--task", task);
    }
    if (language) {
      args.push("--language", language);
    }
    if (model) {
      args.push("--model", model);
    }
    if (outputDir) {
      args.push("--output_dir", outputDir);
    }
    if (outputFormat) {
      args.push("--output_format", outputFormat);
    }
    if (temperature !== undefined) {
      args.push("--temperature", String(temperature));
    }
    if (beamSize) {
      args.push("--beam_size", String(beamSize));
    }
    if (device) {
      args.push("--device", device);
    }
    if (computeType) {
      args.push("--compute_type", computeType);
    }
    args.push(...extraArgs, inputPath);
    return args;
  }

  // Default: openai-whisper CLI
  if (model) {
    args.push("--model", model);
  }
  if (outputDir) {
    args.push("--output_dir", outputDir);
  }
  if (outputFormat) {
    args.push("--output_format", outputFormat);
  }
  if (language) {
    args.push("--language", language);
  }
  if (task) {
    args.push("--task", task);
  }
  if (temperature !== undefined) {
    args.push("--temperature", String(temperature));
  }
  if (beamSize) {
    args.push("--beam_size", String(beamSize));
  }
  if (bestOf) {
    args.push("--best_of", String(bestOf));
  }
  if (device) {
    args.push("--device", device);
  }
  args.push(...extraArgs, inputPath);
  return args;
}

function defaultOutputForFormat(audioPath, outputDir, outputFormat) {
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const targetDir = outputDir || path.dirname(audioPath);
  const extension = outputFormat || "txt";
  return path.join(targetDir, `${baseName}.${extension}`);
}

function normalizeFormats(rawFormats) {
  if (!rawFormats) return [...DEFAULT_FORMATS];
  const list = Array.isArray(rawFormats) ? rawFormats : [rawFormats];
  const flattened = list
    .filter(
      (val) => val !== undefined && val !== null && `${val}`.trim() !== "",
    )
    .flatMap((val) => `${val}`.split(",").map((part) => part.trim()))
    .filter((part) => part.length);
  if (!flattened.length) return [...DEFAULT_FORMATS];
  const lower = flattened.map((part) => part.toLowerCase());
  const unique = Array.from(new Set(lower));
  if (unique.includes("all")) {
    return [...ALL_FORMATS];
  }
  return unique;
}

async function fileExists(candidate) {
  try {
    await fs.promises.access(candidate, fs.constants.F_OK);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

function addSpeakerLabels(content) {
  if (!content) return content;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes("-->")) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) {
        j += 1;
      }
      if (
        j < lines.length &&
        lines[j].trim() &&
        !lines[j].startsWith("Speaker")
      ) {
        lines[j] = `${SPEAKER_PREFIX}${lines[j]}`;
      }
    }
  }
  return lines.join("\n");
}

async function ensureSpeakerLabels(filePath, format) {
  const normalized = (format || "").toLowerCase();
  if (!["srt", "vtt"].includes(normalized)) return;
  try {
    const original = await fs.promises.readFile(filePath, "utf8");
    const withSpeakers = addSpeakerLabels(original);
    if (withSpeakers !== original) {
      await fs.promises.writeFile(filePath, withSpeakers, "utf8");
    }
  } catch (err) {
    // If the file is missing, surface error to caller for clarity
    throw new Error(
      `Unable to add speaker labels to ${filePath}: ${err.message}`,
    );
  }
}

async function transcribeWithWhisper(options = {}) {
  const {
    inputPath,
    outputDir,
    outputFormats,
    outputFormat,
    model: requestedModel = process.env.WHISPER_DEFAULT_MODEL || "turbo",
    language,
    task = "transcribe",
    temperature,
    beamSize,
    bestOf,
    device,
    computeType,
    whisperPath,
    extraArgs,
    logger = console,
    commandSilent = false,
    onCommandStdout,
    onCommandStderr,
  } = options;

  if (!inputPath) {
    throw new Error("transcribeWithWhisper: inputPath is required.");
  }

  const absoluteInput = path.resolve(inputPath);
  try {
    await fs.promises.access(absoluteInput, fs.constants.R_OK);
  } catch (err) {
    throw new Error(`Audio file not accessible: ${absoluteInput}`);
  }

  const resolvedOutputDir = outputDir
    ? path.resolve(outputDir)
    : path.dirname(absoluteInput);
  await fs.promises.mkdir(resolvedOutputDir, { recursive: true });

  const requestedFormats = normalizeFormats(outputFormats ?? outputFormat);
  const baseName = path.basename(absoluteInput, path.extname(absoluteInput));

  const { binary, flavor } = await resolveWhisperBinary({ whisperPath });

  let selectedModel = requestedModel;

  if (selectedModel === "turbo") {
    selectedModel = "large-v3-turbo";
  }

  if (
    requestedModel !== selectedModel &&
    logger &&
    typeof logger.log === "function"
  ) {
    logger.log(
      `Using whisper model alias ${requestedModel} -> ${selectedModel}.`,
    );
  }
  const runs = [];
  if (requestedFormats.length > 1 && flavor === "openai-whisper") {
    runs.push({ cliFormat: "all", expectedFormats: requestedFormats });
  } else {
    for (const format of requestedFormats) {
      runs.push({ cliFormat: format, expectedFormats: [format] });
    }
  }

  const outputs = [];

  for (const run of runs) {
    let runModel = selectedModel;
    let attempt = 0;

    while (true) {
      const args = buildArgsForFlavor(flavor, {
        inputPath: absoluteInput,
        model: runModel,
        language,
        task,
        temperature,
        beamSize,
        bestOf,
        device,
        outputFormat: run.cliFormat,
        outputDir: resolvedOutputDir,
        extraArgs,
        computeType,
      });

      logger.log(
        `Running ${path.basename(binary)} with model ${runModel} (${Array.isArray(run.expectedFormats) ? run.expectedFormats.join(", ") : run.cliFormat})...`,
      );

      try {
        await runCommand(binary, args, {
          label: path.basename(binary),
          silent: commandSilent,
          onStdout: onCommandStdout,
          onStderr: onCommandStderr,
        });
        selectedModel = runModel;
        break;
      } catch (err) {
        const canFallbackToLargeV3 =
          attempt === 0 &&
          flavor === "openai-whisper" &&
          runModel === "large-v3-turbo" &&
          err &&
          typeof err.message === "string" &&
          err.message.includes("exit code 2");

        if (canFallbackToLargeV3) {
          runModel = "large-v3";
          selectedModel = runModel;
          attempt += 1;
          if (logger && typeof logger.warn === "function") {
            logger.warn(
              "Whisper CLI rejected model large-v3-turbo; falling back to large-v3. Upgrade openai-whisper to use turbo.",
            );
          }
          continue;
        }
        throw err;
      }
    }

    for (const format of run.expectedFormats) {
      const normalized = format.toLowerCase();
      if (!normalized || normalized === "all") continue;
      const candidatePath = path.join(
        resolvedOutputDir,
        `${baseName}.${normalized}`,
      );
      if (await fileExists(candidatePath)) {
        outputs.push({ format: normalized, path: candidatePath });
      }
    }

    if (run.cliFormat === "all") {
      const keepSet = new Set(requestedFormats);
      for (const format of ALL_FORMATS) {
        if (keepSet.has(format)) continue;
        const extraPath = path.join(resolvedOutputDir, `${baseName}.${format}`);
        if (await fileExists(extraPath)) {
          await fs.promises.unlink(extraPath);
        }
      }
    }
  }

  // Deduplicate outputs preserving order of requested formats
  const orderedOutputs = [];
  const seen = new Set();
  for (const format of requestedFormats) {
    const entry = outputs.find(
      (item) => item.format === format && !seen.has(item.path),
    );
    if (entry) {
      orderedOutputs.push(entry);
      seen.add(entry.path);
    }
  }

  for (const output of orderedOutputs) {
    await ensureSpeakerLabels(output.path, output.format);
  }

  const primaryOutput = orderedOutputs.length
    ? orderedOutputs[0].path
    : defaultOutputForFormat(
        absoluteInput,
        resolvedOutputDir,
        requestedFormats[0],
      );

  return {
    command: binary,
    flavor,
    outputDir: resolvedOutputDir,
    outputs: orderedOutputs,
    primaryOutput,
  };
}

module.exports = {
  transcribeWithWhisper,
};
