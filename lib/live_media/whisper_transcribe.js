const fs = require("fs");
const path = require("path");

const {
  runCommand,
  ensureExecutable,
  resolveExecutable,
} = require("./process_utils");
const {
  MAX_FILE_NAME_BYTES,
  build_bounded_output_path,
  build_bounded_stem,
  count_utf8_bytes,
} = require("./output_path_utils");
const {
  cleanup_stale_temporary_artifacts,
  create_temporary_directory_prefix,
} = require("./temporary_artifact_utils");
const { clear_hidden_flag_if_needed } = require("./file_visibility_utils");

const DEFAULT_FORMATS = ["vtt"];
const ALL_FORMATS = ["txt", "vtt", "srt", "tsv", "json"];
const SPEAKER_PREFIX = "Speaker 1: ";
const TURBO_MODEL_NAMES = new Set(["turbo", "large-v3-turbo"]);
const MOST_POWERFUL_LOCAL_MODEL = "large-v3";
const LATEST_LOCAL_MODEL = "turbo";
const MODEL_ALIAS_MAP = new Map([
  ["best", MOST_POWERFUL_LOCAL_MODEL],
  ["strongest", MOST_POWERFUL_LOCAL_MODEL],
  ["most-powerful", MOST_POWERFUL_LOCAL_MODEL],
  ["most_powerful", MOST_POWERFUL_LOCAL_MODEL],
  ["latest", LATEST_LOCAL_MODEL],
  ["newest", LATEST_LOCAL_MODEL],
  ["fast", LATEST_LOCAL_MODEL],
  ["large-v3-turbo", LATEST_LOCAL_MODEL],
  ["turbo", LATEST_LOCAL_MODEL],
]);

const temporary_directories = new Set();
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
  });
}

async function create_temporary_output_directory(output_key_path) {
  const prefix = create_temporary_directory_prefix(output_key_path, {
    label: "whisper",
  });
  await fs.promises.mkdir(path.dirname(prefix), { recursive: true });
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

async function cleanup_interrupted_whisper_outputs(
  output_key_path,
  options = {},
) {
  const { logger = console } = options;
  const stale_paths = await cleanup_stale_temporary_artifacts(output_key_path, {
    label: "whisper",
    entry_kind: "directory",
    include_extension: false,
  });
  if (!stale_paths.length) return;

  if (logger && typeof logger.warn === "function") {
    logger.warn(
      `Found interrupted whisper output; deleting ${stale_paths.length} stale temp director${stale_paths.length === 1 ? "y" : "ies"} and restarting.`,
    );
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

function normalize_model_name(value) {
  if (value === undefined || value === null) return "";
  return `${value}`.trim();
}

function get_default_whisper_model() {
  return process.env.WHISPER_DEFAULT_MODEL || MOST_POWERFUL_LOCAL_MODEL;
}

function is_turbo_model(value) {
  const normalized = resolve_model_for_flavor(value);
  if (!normalized) return false;
  return TURBO_MODEL_NAMES.has(normalized.toLowerCase());
}

function resolve_model_for_flavor(requested_model) {
  const normalized = normalize_model_name(requested_model);
  if (!normalized) return normalized;
  const lowered = normalized.toLowerCase();
  const aliased_model = MODEL_ALIAS_MAP.get(lowered);
  if (aliased_model) {
    return aliased_model;
  }

  return normalized;
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
    "No whisper-compatible executable found. Install openai-whisper (pip install -U openai-whisper) or faster-whisper (pip install faster-whisper), or provide --whisper-bin.",
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

function resolveOutputBaseName(audioPath, outputBaseName) {
  const normalizedBaseName = `${outputBaseName || ""}`.trim();
  if (normalizedBaseName) {
    return normalizedBaseName;
  }
  return path.basename(audioPath, path.extname(audioPath));
}

function defaultOutputForFormat(
  audioPath,
  outputDir,
  outputFormat,
  outputBaseName,
) {
  const baseName = resolveOutputBaseName(audioPath, outputBaseName);
  const targetDir = outputDir || path.dirname(audioPath);
  const extension = outputFormat || "txt";
  return build_bounded_output_path({
    directory: targetDir,
    stem: baseName,
    extension: `.${extension}`,
  });
}

function get_longest_output_extension(outputFormats = []) {
  let longestExtension = "";
  for (const format of outputFormats) {
    const normalized = `${format || ""}`.trim().toLowerCase();
    if (!normalized || normalized === "all") continue;
    const extension = `.${normalized}`;
    if (count_utf8_bytes(extension) > count_utf8_bytes(longestExtension)) {
      longestExtension = extension;
    }
  }
  return longestExtension || ".txt";
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

function resolve_produced_output_candidates(options = {}) {
  const {
    temporary_output_dir,
    requested_safe_base_name,
    absolute_input,
    format,
  } = options;
  const normalized_format = `${format || ""}`.toLowerCase();
  if (!temporary_output_dir || !normalized_format) return [];

  const candidate_names = [];
  const add_candidate_name = (base_name) => {
    if (!base_name) return;
    const file_name = `${base_name}.${normalized_format}`;
    if (count_utf8_bytes(file_name) > MAX_FILE_NAME_BYTES) return;
    if (!candidate_names.includes(file_name)) {
      candidate_names.push(file_name);
    }
  };

  add_candidate_name(requested_safe_base_name);

  const input_base_name = path.basename(
    absolute_input,
    path.extname(absolute_input),
  );
  add_candidate_name(input_base_name);
  add_candidate_name(
    build_bounded_stem({
      stem: input_base_name,
      extension: `.${normalized_format}`,
    }),
  );

  return candidate_names.map((file_name) =>
    path.join(temporary_output_dir, file_name),
  );
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
    outputBaseName,
    model: requestedModel = get_default_whisper_model(),
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
    debug = false,
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
  const baseName = resolveOutputBaseName(absoluteInput, outputBaseName);
  const safeBaseName = build_bounded_stem({
    stem: baseName,
    extension: get_longest_output_extension(requestedFormats),
  });

  ensure_cleanup_registered();

  const { binary, flavor } = await resolveWhisperBinary({ whisperPath });

  const requested_model_label = normalize_model_name(requestedModel);
  let selectedModel = resolve_model_for_flavor(requestedModel);
  const selected_model_label = normalize_model_name(selectedModel);
  const turbo_requested = is_turbo_model(requestedModel);
  const normalized_task = typeof task === "string" ? task.toLowerCase() : "";

  if (
    requested_model_label &&
    requested_model_label !== selected_model_label &&
    logger &&
    typeof logger.log === "function"
  ) {
    logger.log(
      `Using whisper model alias ${requested_model_label} -> ${selected_model_label}.`,
    );
  }

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

  if (turbo_requested && runningOnCpu) {
    const fallbackCandidate =
      process.env.WHISPER_CPU_TURBO_FALLBACK ||
      process.env.WHISPER_CPU_TURBO_FALLBACK_MODEL ||
      "small";
    const fallbackModel = fallbackCandidate && fallbackCandidate.trim();
    if (fallbackModel && !is_turbo_model(fallbackModel)) {
      if (logger && typeof logger.warn === "function") {
        const reasonLabel =
          normalizedDevice === "cpu"
            ? "CPU device requested"
            : "No GPU/MPS accelerator detected";
        logger.warn(
          `${reasonLabel}; using ${fallbackModel} for turbo alias on CPU. Override with --model turbo to force turbo.`,
        );
      }
      selectedModel = fallbackModel;
    }
  }

  if (
    normalized_task === "translate" &&
    is_turbo_model(selectedModel) &&
    logger &&
    typeof logger.warn === "function"
  ) {
    logger.warn(
      "Whisper turbo is not trained for translation; use a multilingual model (medium or large) for --task translate.",
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

  const output_key_path = path.join(resolvedOutputDir, safeBaseName);
  await cleanup_interrupted_whisper_outputs(output_key_path, {
    logger,
  });
  const temporary_output_dir =
    await create_temporary_output_directory(output_key_path);
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
            logger,
            debug,
          });
          selectedModel = runModel;
          break;
        } catch (err) {
          const canFallbackToLargeV3 =
            attempt === 0 &&
            flavor === "openai-whisper" &&
            is_turbo_model(runModel) &&
            err &&
            typeof err.message === "string" &&
            err.message.includes("exit code 2");

          if (canFallbackToLargeV3) {
            const rejected_model = runModel;
            runModel = "large-v3";
            selectedModel = runModel;
            attempt += 1;
            if (logger && typeof logger.warn === "function") {
              logger.warn(
                `Whisper CLI rejected model ${requested_model_label || rejected_model}; falling back to large-v3. Upgrade openai-whisper to use turbo.`,
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
        const produced_candidates = resolve_produced_output_candidates({
          temporary_output_dir,
          requested_safe_base_name: safeBaseName,
          absolute_input: absoluteInput,
          format: normalized,
        });
        let produced_candidate = "";
        for (const candidate of produced_candidates) {
          if (await fileExists(candidate)) {
            produced_candidate = candidate;
            break;
          }
        }
        if (!produced_candidate) {
          throw new Error(
            `Whisper did not produce expected ${normalized} output. Checked: ${produced_candidates.join(
              ", ",
            )}`,
          );
        }

        await ensureSpeakerLabels(produced_candidate, normalized);
        const final_candidate = path.join(
          resolvedOutputDir,
          `${safeBaseName}.${normalized}`,
        );
        await remove_file_if_exists(final_candidate);
        await fs.promises.rename(produced_candidate, final_candidate);
        await clear_hidden_flag_if_needed(final_candidate, {
          logger,
          debug,
        });
        outputs.push({ format: normalized, path: final_candidate });
        committed_outputs.push(final_candidate);
      }

      if (run.cliFormat === "all") {
        const keep_set = new Set(requestedFormats);
        for (const format of ALL_FORMATS) {
          if (keep_set.has(format)) continue;
          const extra_path = path.join(
            temporary_output_dir,
            `${safeBaseName}.${format}`,
          );
          await remove_file_if_exists(extra_path);
        }
      }
    }
  } catch (err) {
    for (const created_path of committed_outputs) {
      await remove_file_if_exists(created_path);
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

  const primaryOutput = orderedOutputs.length
    ? orderedOutputs[0].path
    : defaultOutputForFormat(
        absoluteInput,
        resolvedOutputDir,
        requestedFormats[0],
        outputBaseName,
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
  get_default_whisper_model,
  resolve_model_for_flavor,
};
