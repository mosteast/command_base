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

const temporary_directories = new Set();
const pending_outputs = new Set();
let cleanup_registered = false;

function ensure_cleanup_registered() {
  if (cleanup_registered) return;
  cleanup_registered = true;
  process.on("exit", () => {
    for (const dir_path of temporary_directories) {
      if (!dir_path) continue;
      try {
        if (typeof fs.rmSync === "function") {
          fs.rmSync(dir_path, { recursive: true, force: true });
        }
      } catch (err) {
        // Ignore cleanup failures during shutdown.
      }
    }
    temporary_directories.clear();

    for (const output_path of pending_outputs) {
      if (!output_path) continue;
      try {
        if (typeof fs.rmSync === "function") {
          fs.rmSync(output_path, { force: true });
        } else {
          fs.unlinkSync(output_path);
        }
      } catch (err) {
        // Ignore cleanup failures during shutdown.
      }
    }
    pending_outputs.clear();
  });
}

async function create_temporary_output_directory(base_directory) {
  const prefix = path.join(base_directory, ".tmp_whisper_");
  return await fs.promises.mkdtemp(prefix);
}

async function remove_directory_if_exists(target_directory) {
  if (!target_directory) return;
  try {
    if (typeof fs.promises.rm === "function") {
      await fs.promises.rm(target_directory, { recursive: true, force: true });
    } else {
      await fs.promises.rmdir(target_directory, { recursive: true });
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

async function remove_file_if_exists(candidate) {
  if (!candidate) return;
  try {
    await fs.promises.unlink(candidate);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

let accelerator_info_promise;

async function detect_accelerator_info() {
  if (accelerator_info_promise) return accelerator_info_promise;

  accelerator_info_promise = (async () => {
    const python_candidates = ["python3", "python"];
    const detection_script = [
      "import json",
      "try:",
      "    import torch",
      "    has_cuda = bool(getattr(torch, 'cuda', None) and torch.cuda.is_available())",
      "    has_mps = bool(getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available())",
      "except Exception:",
      "    has_cuda = False",
      "    has_mps = False",
      "print(json.dumps({'cuda': has_cuda, 'mps': has_mps}))",
    ].join("\n");

    for (const python_command of python_candidates) {
      try {
        const result = await runCommand(
          python_command,
          ["-c", detection_script],
          {
            capture: true,
            silent: true,
          },
        );
        const raw_output = (result.stdout || "").trim();
        if (!raw_output) continue;
        try {
          const parsed = JSON.parse(raw_output);
          const has_cuda = Boolean(parsed && parsed.cuda);
          const has_mps = Boolean(parsed && parsed.mps);
          return {
            cuda: has_cuda,
            mps: has_mps,
            has_accelerator: has_cuda || has_mps,
          };
        } catch (parse_error) {
          // Ignore JSON parsing issues and fall back to next candidate.
        }
      } catch (err) {
        if (err && (err.code === "ENOENT" || err.code === 127)) {
          continue;
        }
        if (err && err.originalError && err.originalError.code === "ENOENT") {
          continue;
        }
        // Any other failure means we cannot detect accelerators; bail out.
        break;
      }
    }

    return { cuda: false, mps: false, has_accelerator: false };
  })();

  return accelerator_info_promise;
}

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

  ensure_cleanup_registered();

  for (const format of requestedFormats) {
    const normalized = format && `${format}`.toLowerCase();
    if (!normalized || normalized === "all") continue;
    const final_path = path.join(
      resolvedOutputDir,
      `${baseName}.${normalized}`,
    );
    pending_outputs.add(final_path);
  }

  const { binary, flavor } = await resolveWhisperBinary({ whisperPath });

  let selectedModel = requestedModel;
  let aliasTargetModel = selectedModel;

  if (aliasTargetModel === "turbo") {
    aliasTargetModel = "large-v3-turbo";
  }

  if (
    requestedModel !== aliasTargetModel &&
    logger &&
    typeof logger.log === "function"
  ) {
    logger.log(
      `Using whisper model alias ${requestedModel} -> ${aliasTargetModel}.`,
    );
  }

  selectedModel = aliasTargetModel;

  const normalizedDevice =
    typeof device === "string" ? device.toLowerCase() : "";
  let runningOnCpu = normalizedDevice === "cpu";

  if (!runningOnCpu && !normalizedDevice) {
    try {
      const acceleratorInfo = await detect_accelerator_info();
      runningOnCpu = !acceleratorInfo.has_accelerator;
    } catch (err) {
      runningOnCpu = true;
    }
  }

  if (
    requestedModel === "turbo" &&
    selectedModel === "large-v3-turbo" &&
    runningOnCpu
  ) {
    const fallbackCandidate =
      process.env.WHISPER_CPU_TURBO_FALLBACK ||
      process.env.WHISPER_CPU_TURBO_FALLBACK_MODEL ||
      "small";
    const fallbackModel = fallbackCandidate && fallbackCandidate.trim();
    if (fallbackModel && fallbackModel.toLowerCase() !== "large-v3-turbo") {
      if (logger && typeof logger.warn === "function") {
        const reasonLabel =
          normalizedDevice === "cpu"
            ? "CPU device requested"
            : "No GPU/MPS accelerator detected";
        logger.warn(
          `${reasonLabel}; using ${fallbackModel} for turbo alias on CPU. Override with --model large-v3-turbo to force turbo.`,
        );
      }
      selectedModel = fallbackModel;
    }
  }
  const runs = [];
  if (requestedFormats.length > 1 && flavor === "openai-whisper") {
    runs.push({ cliFormat: "all", expectedFormats: requestedFormats });
  } else {
    for (const format of requestedFormats) {
      runs.push({ cliFormat: format, expectedFormats: [format] });
    }
  }

  const temporary_output_dir =
    await create_temporary_output_directory(resolvedOutputDir);
  temporary_directories.add(temporary_output_dir);

  const outputs = [];
  const committed_outputs = [];

  try {
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
          outputDir: temporary_output_dir,
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
        const temporary_candidate = path.join(
          temporary_output_dir,
          `${baseName}.${normalized}`,
        );
        if (await fileExists(temporary_candidate)) {
          const final_candidate = path.join(
            resolvedOutputDir,
            `${baseName}.${normalized}`,
          );
          await remove_file_if_exists(final_candidate);
          await fs.promises.rename(temporary_candidate, final_candidate);
          pending_outputs.delete(final_candidate);
          outputs.push({ format: normalized, path: final_candidate });
          committed_outputs.push(final_candidate);
        }
      }

      if (run.cliFormat === "all") {
        const keep_set = new Set(requestedFormats);
        for (const format of ALL_FORMATS) {
          if (keep_set.has(format)) continue;
          const extra_path = path.join(
            temporary_output_dir,
            `${baseName}.${format}`,
          );
          await remove_file_if_exists(extra_path);
        }
      }
    }
  } catch (err) {
    for (const created_path of committed_outputs) {
      await remove_file_if_exists(created_path);
      pending_outputs.delete(created_path);
    }
    throw err;
  } finally {
    temporary_directories.delete(temporary_output_dir);
    await remove_directory_if_exists(temporary_output_dir);
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
    pending_outputs.delete(output.path);
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
