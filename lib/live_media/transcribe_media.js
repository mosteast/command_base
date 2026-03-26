const fs = require("fs");
const path = require("path");

const { runCommand, resolveExecutable } = require("./process_utils");
const {
  build_bounded_output_path,
  build_bounded_stem,
  count_utf8_bytes,
} = require("./output_path_utils");
const {
  cleanup_stale_temporary_artifacts,
  create_temporary_directory_prefix,
} = require("./temporary_artifact_utils");
const {
  transcribeWithWhisper,
  resolve_model_for_flavor,
} = require("./whisper_transcribe");

const DEFAULT_FORMATS = ["vtt"];
const ALL_FORMATS = ["txt", "vtt", "srt", "tsv", "json"];
const SUPPORTED_TRANSCRIPT_PROVIDERS = ["qwen3_asr", "sensevoice", "whisper"];
const DEFAULT_TRANSCRIPT_PROVIDER =
  process.env.VIDEOS_NORMALIZE_TRANSCRIPT_PROVIDER ||
  process.env.TRANSCRIPT_DEFAULT_PROVIDER ||
  "qwen3_asr";
const DEFAULT_QWEN3_ASR_MODEL =
  process.env.VIDEOS_NORMALIZE_QWEN3_ASR_MODEL ||
  process.env.QWEN3_ASR_MODEL ||
  "Qwen/Qwen3-ASR-0.6B";
const DEFAULT_SENSEVOICE_MODEL =
  process.env.VIDEOS_NORMALIZE_SENSEVOICE_MODEL ||
  process.env.SENSEVOICE_MODEL ||
  "iic/SenseVoiceSmall";
const DEFAULT_WHISPER_MODEL =
  process.env.VIDEOS_NORMALIZE_WHISPER_MODEL ||
  process.env.WHISPER_DEFAULT_MODEL ||
  "latest";
const DEFAULT_QWEN_ALIGNER_MODEL =
  process.env.VIDEOS_NORMALIZE_QWEN_ALIGNER_MODEL ||
  process.env.QWEN3_ASR_ALIGNER_MODEL ||
  "Qwen/Qwen3-ForcedAligner-0.6B";

const temporary_directories = new Set();
let cleanup_registered = false;

const provider_alias_map = new Map([
  ["1", "qwen3_asr"],
  ["qwen", "qwen3_asr"],
  ["qwen3", "qwen3_asr"],
  ["qwen3_asr", "qwen3_asr"],
  ["qwen3-asr", "qwen3_asr"],
  ["2", "sensevoice"],
  ["sensevoice", "sensevoice"],
  ["sense-voice", "sensevoice"],
  ["sense_voice", "sensevoice"],
  ["3", "whisper"],
  ["whisper", "whisper"],
]);

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
        // ignore cleanup failures during shutdown
      }
    }
    temporary_directories.clear();
  });
}

async function create_temporary_output_directory(output_key_path) {
  const prefix = create_temporary_directory_prefix(output_key_path, {
    label: "transcribe",
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

async function file_exists(candidate) {
  try {
    await fs.promises.access(candidate, fs.constants.F_OK);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

function normalize_formats(raw_formats) {
  if (!raw_formats) return [...DEFAULT_FORMATS];
  const list = Array.isArray(raw_formats) ? raw_formats : [raw_formats];
  const flattened = list
    .filter(
      (value) =>
        value !== undefined && value !== null && `${value}`.trim() !== "",
    )
    .flatMap((value) => `${value}`.split(",").map((part) => part.trim()))
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  if (!flattened.length) return [...DEFAULT_FORMATS];
  const unique = Array.from(new Set(flattened));
  if (unique.includes("all")) {
    return [...ALL_FORMATS];
  }
  return unique;
}

async function cleanup_interrupted_transcript_outputs(output_key_path, options = {}) {
  const {
    logger = console,
    debug = false,
    runner_name = "transcription",
  } = options;
  const stale_paths = await cleanup_stale_temporary_artifacts(output_key_path, {
    label: "transcribe",
    entry_kind: "directory",
    include_extension: false,
  });
  if (!stale_paths.length) return;

  if (logger && typeof logger.warn === "function") {
    logger.warn(
      `Found interrupted ${runner_name} output; deleting ${stale_paths.length} stale temp director${stale_paths.length === 1 ? "y" : "ies"} and restarting.`,
    );
  }

  if (debug && logger && typeof logger.debug === "function") {
    stale_paths.forEach((candidate) => {
      logger.debug(`Removed stale transcript temp directory: ${candidate}`);
    });
  }
}

function build_transcript_runner_env(provider) {
  const next_env = { ...process.env };
  if (provider === "qwen3_asr" && !next_env.HF_HUB_DISABLE_XET) {
    next_env.HF_HUB_DISABLE_XET = "1";
  }
  return next_env;
}

function normalize_provider_name(value) {
  if (value === undefined || value === null) return "";
  return `${value}`.trim().toLowerCase();
}

function resolve_transcript_provider(requested_provider) {
  const normalized = normalize_provider_name(
    requested_provider || DEFAULT_TRANSCRIPT_PROVIDER,
  );
  return provider_alias_map.get(normalized) || normalized;
}

function list_transcript_providers() {
  return [...SUPPORTED_TRANSCRIPT_PROVIDERS];
}

function get_default_transcript_provider() {
  return resolve_transcript_provider(DEFAULT_TRANSCRIPT_PROVIDER);
}

function get_default_model_for_provider(provider) {
  const resolved_provider = resolve_transcript_provider(provider);
  if (resolved_provider === "qwen3_asr") {
    return DEFAULT_QWEN3_ASR_MODEL;
  }
  if (resolved_provider === "sensevoice") {
    return DEFAULT_SENSEVOICE_MODEL;
  }
  return DEFAULT_WHISPER_MODEL;
}

function resolve_model_for_provider(provider, requested_model) {
  const resolved_provider = resolve_transcript_provider(provider);
  const normalized = `${requested_model || ""}`.trim();
  if (!normalized) {
    return get_default_model_for_provider(resolved_provider);
  }
  const lowered = normalized.toLowerCase();

  if (resolved_provider === "qwen3_asr") {
    const alias_map = new Map([
      ["best", "Qwen/Qwen3-ASR-1.7B"],
      ["strongest", "Qwen/Qwen3-ASR-1.7B"],
      ["most-powerful", "Qwen/Qwen3-ASR-1.7B"],
      ["most_powerful", "Qwen/Qwen3-ASR-1.7B"],
      ["latest", DEFAULT_QWEN3_ASR_MODEL],
      ["newest", DEFAULT_QWEN3_ASR_MODEL],
      ["fast", "Qwen/Qwen3-ASR-0.6B"],
      ["default", DEFAULT_QWEN3_ASR_MODEL],
    ]);
    return alias_map.get(lowered) || normalized;
  }

  if (resolved_provider === "sensevoice") {
    const alias_map = new Map([
      ["best", DEFAULT_SENSEVOICE_MODEL],
      ["strongest", DEFAULT_SENSEVOICE_MODEL],
      ["most-powerful", DEFAULT_SENSEVOICE_MODEL],
      ["most_powerful", DEFAULT_SENSEVOICE_MODEL],
      ["latest", DEFAULT_SENSEVOICE_MODEL],
      ["newest", DEFAULT_SENSEVOICE_MODEL],
      ["fast", DEFAULT_SENSEVOICE_MODEL],
      ["default", DEFAULT_SENSEVOICE_MODEL],
    ]);
    return alias_map.get(lowered) || normalized;
  }

  return resolve_model_for_flavor(normalized);
}

function resolve_output_base_name(audio_path, output_base_name) {
  const normalized_base_name = `${output_base_name || ""}`.trim();
  if (normalized_base_name) {
    return normalized_base_name;
  }
  return path.basename(audio_path, path.extname(audio_path));
}

function default_output_for_format(
  audio_path,
  output_dir,
  output_format,
  output_base_name,
) {
  const base_name = resolve_output_base_name(audio_path, output_base_name);
  const target_dir = output_dir || path.dirname(audio_path);
  const extension = output_format || "txt";
  return build_bounded_output_path({
    directory: target_dir,
    stem: base_name,
    extension: `.${extension}`,
  });
}

function get_longest_output_extension(output_formats = []) {
  let longest_extension = "";
  for (const format of output_formats) {
    const normalized = `${format || ""}`.trim().toLowerCase();
    if (!normalized || normalized === "all") continue;
    const extension = `.${normalized}`;
    if (count_utf8_bytes(extension) > count_utf8_bytes(longest_extension)) {
      longest_extension = extension;
    }
  }
  return longest_extension || ".txt";
}

function resolve_transcript_outputs(options = {}) {
  const {
    inputPath,
    outputDir,
    outputFormats,
    outputFormat,
    outputBaseName,
  } = options;
  const absolute_input = path.resolve(inputPath);
  const resolved_output_dir = outputDir
    ? path.resolve(outputDir)
    : path.dirname(absolute_input);
  const requested_formats = normalize_formats(outputFormats ?? outputFormat);
  const base_name = resolve_output_base_name(absolute_input, outputBaseName);
  const safe_base_name = build_bounded_stem({
    stem: base_name,
    extension: get_longest_output_extension(requested_formats),
  });
  const outputs = requested_formats
    .filter((format) => {
      const normalized = `${format || ""}`.toLowerCase();
      return Boolean(normalized && normalized !== "all");
    })
    .map((format) => ({
      format: `${format}`.toLowerCase(),
      path: path.join(resolved_output_dir, `${safe_base_name}.${format}`),
    }));

  return {
    absolute_input,
    resolved_output_dir,
    requested_formats,
    safe_base_name,
    outputs,
  };
}

async function resolve_python_binary(requested_python_bin) {
  const candidates = [];
  if (requested_python_bin) {
    candidates.push(requested_python_bin);
  }
  if (process.env.PYTHON_BIN) {
    candidates.push(process.env.PYTHON_BIN);
  }
  candidates.push("python3", "python");

  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = await resolveExecutable(candidate);
    if (resolved) {
      return resolved;
    }
  }

  const err = new Error(
    "No Python interpreter found. Install python3 or provide --transcript-python-bin.",
  );
  err.code = "TRANSCRIPT_PROVIDER_NOT_FOUND";
  err.provider = "python";
  err.install_hint =
    "Install Python 3 and the provider dependencies, or provide --transcript-python-bin.";
  throw err;
}

async function probe_python_modules(python_bin, module_names) {
  const unique_modules = Array.from(
    new Set(
      (Array.isArray(module_names) ? module_names : []).filter((name) => name),
    ),
  );
  if (!unique_modules.length) {
    return { available: true };
  }

  const probe_script = unique_modules
    .map((name) => `__import__(${JSON.stringify(name)})`)
    .join("\n");
  const result = await runCommand(python_bin, ["-c", probe_script], {
    capture: true,
    allowNonZeroExit: true,
    label: "python",
  });
  return {
    available: result.code === 0,
    details:
      `${result.stderr || ""}`.trim() || `${result.stdout || ""}`.trim() || "",
  };
}

async function probe_whisper_binary(whisper_path) {
  if (whisper_path) {
    const resolved = await resolveExecutable(whisper_path);
    return { available: Boolean(resolved), binary: resolved };
  }

  for (const candidate of [
    "whisper",
    "whisper-ctranslate2",
    "faster-whisper",
  ]) {
    const resolved = await resolveExecutable(candidate);
    if (resolved) {
      return { available: true, binary: resolved };
    }
  }

  return { available: false, binary: "" };
}

async function probe_transcript_provider_availability(options = {}) {
  const provider = resolve_transcript_provider(options.provider);

  if (provider === "whisper") {
    const probe = await probe_whisper_binary(options.whisperPath);
    return {
      provider,
      available: probe.available,
      install_hint:
        "Install openai-whisper (pip install -U openai-whisper) or faster-whisper (pip install faster-whisper).",
    };
  }

  const python_bin = await resolve_python_binary(options.pythonBin);
  const module_names =
    provider === "qwen3_asr" ? ["torch", "qwen_asr"] : ["torch", "funasr"];
  const probe = await probe_python_modules(python_bin, module_names);
  return {
    provider,
    available: probe.available,
    pythonBin: python_bin,
    details: probe.details || "",
    install_hint:
      provider === "qwen3_asr"
        ? "Install qwen-asr with: pip install -U qwen-asr (or qwen-asr[vllm])."
        : "Install FunASR with: pip install -U funasr.",
  };
}

async function resolve_transcript_provider_strategy(options = {}) {
  const requested_provider = resolve_transcript_provider(options.provider);
  const explicit_provider = Boolean(options.explicitProvider);
  const candidates = [requested_provider];

  if (!explicit_provider) {
    for (const candidate of SUPPORTED_TRANSCRIPT_PROVIDERS) {
      if (!candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }
  }

  let requested_probe = null;
  for (const candidate of candidates) {
    const probe = await probe_transcript_provider_availability({
      provider: candidate,
      pythonBin: options.pythonBin,
      whisperPath: options.whisperPath,
    });
    if (candidate === requested_provider) {
      requested_probe = probe;
    }
    if (probe.available) {
      return {
        available: true,
        provider: candidate,
        requestedProvider: requested_provider,
        explicitProvider: explicit_provider,
        fallbackFrom:
          candidate !== requested_provider ? requested_provider : "",
        probe,
      };
    }
  }

  return {
    available: false,
    provider: requested_provider,
    requestedProvider: requested_provider,
    explicitProvider: explicit_provider,
    fallbackFrom: "",
    probe: requested_probe,
  };
}

function build_runner_error(error, provider, install_hint) {
  const stderr = `${error && error.stderr ? error.stderr : ""}`.trim();
  const stdout = `${error && error.stdout ? error.stdout : ""}`.trim();
  const text =
    stderr || stdout || error.message || "Transcription provider failed.";

  if (text.startsWith("TRANSCRIBE_DEPENDENCY_MISSING:")) {
    const message = text.slice("TRANSCRIBE_DEPENDENCY_MISSING:".length).trim();
    const wrapped = new Error(message || install_hint);
    wrapped.code = "TRANSCRIPT_PROVIDER_NOT_FOUND";
    wrapped.provider = provider;
    wrapped.install_hint = install_hint;
    return wrapped;
  }

  if (text.startsWith("TRANSCRIBE_TIMESTAMPS_UNAVAILABLE:")) {
    const message = text
      .slice("TRANSCRIBE_TIMESTAMPS_UNAVAILABLE:".length)
      .trim();
    const wrapped = new Error(message || "Timestamp output is unavailable.");
    wrapped.code = "TRANSCRIPT_TIMESTAMPS_UNAVAILABLE";
    wrapped.provider = provider;
    return wrapped;
  }

  if (text.startsWith("TRANSCRIBE_UNSUPPORTED_TASK:")) {
    const message = text.slice("TRANSCRIBE_UNSUPPORTED_TASK:".length).trim();
    const wrapped = new Error(message || "Unsupported transcription task.");
    wrapped.code = "TRANSCRIPT_UNSUPPORTED_TASK";
    wrapped.provider = provider;
    return wrapped;
  }

  if (text.startsWith("TRANSCRIBE_INVALID_ARGUMENT:")) {
    const message = text.slice("TRANSCRIBE_INVALID_ARGUMENT:".length).trim();
    const wrapped = new Error(message || "Invalid transcription arguments.");
    wrapped.code = "TRANSCRIPT_INVALID_ARGUMENT";
    wrapped.provider = provider;
    return wrapped;
  }

  return error;
}

async function run_python_runner(options = {}) {
  const {
    provider,
    runner_name,
    script_path,
    install_hint,
    inputPath,
    outputDir,
    outputFormats,
    outputFormat,
    outputBaseName,
    model,
    language,
    task = "transcribe",
    device,
    pythonBin,
    extraArgs = [],
    logger = console,
    debug = false,
    commandSilent = false,
    onCommandStdout,
    onCommandStderr,
    additionalArgs = [],
  } = options;

  if (!inputPath) {
    throw new Error(`${runner_name}: inputPath is required.`);
  }

  const {
    absolute_input,
    resolved_output_dir,
    requested_formats,
    safe_base_name,
  } = resolve_transcript_outputs({
    inputPath,
    outputDir,
    outputFormats,
    outputFormat,
    outputBaseName,
  });

  if (debug && logger && typeof logger.debug === "function") {
    logger.debug(`Checking transcription input: ${absolute_input}`);
  }
  try {
    await fs.promises.access(absolute_input, fs.constants.R_OK);
  } catch (err) {
    throw new Error(`Audio file not accessible: ${absolute_input}`);
  }
  await fs.promises.mkdir(resolved_output_dir, { recursive: true });
  ensure_cleanup_registered();

  const output_key_path = path.join(resolved_output_dir, safe_base_name);
  await cleanup_interrupted_transcript_outputs(output_key_path, {
    logger,
    debug,
    runner_name,
  });
  const temporary_output_dir =
    await create_temporary_output_directory(output_key_path);
  temporary_directories.add(temporary_output_dir);

  const selected_model = resolve_model_for_provider(provider, model);
  const python_bin = await resolve_python_binary(pythonBin);
  const runner_args = [
    script_path,
    "--audio",
    absolute_input,
    "--model",
    selected_model,
    "--output-dir",
    temporary_output_dir,
    "--base-name",
    safe_base_name,
    "--formats",
    requested_formats.join(","),
    "--task",
    task || "transcribe",
  ];

  if (language) {
    runner_args.push("--language", language);
  }
  if (device) {
    runner_args.push("--device", device);
  }
  if (Array.isArray(additionalArgs) && additionalArgs.length) {
    runner_args.push(...additionalArgs);
  }
  if (Array.isArray(extraArgs) && extraArgs.length) {
    runner_args.push(...extraArgs);
  }

  const committed_outputs = [];
  try {
    if (logger && typeof logger.log === "function") {
      logger.log(
        `Running ${runner_name} with model ${selected_model} (${requested_formats.join(", ")})...`,
      );
    }

    try {
      await runCommand(python_bin, runner_args, {
        label: runner_name,
        env: build_transcript_runner_env(provider),
        silent: commandSilent,
        onStdout: onCommandStdout,
        onStderr: onCommandStderr,
        logger,
        debug,
      });
    } catch (error) {
      throw build_runner_error(error, provider, install_hint);
    }

    const outputs = [];
    for (const format of requested_formats) {
      const normalized = format.toLowerCase();
      const temporary_candidate = path.join(
        temporary_output_dir,
        `${safe_base_name}.${normalized}`,
      );
      if (!(await file_exists(temporary_candidate))) {
        continue;
      }
      const final_candidate = path.join(
        resolved_output_dir,
        `${safe_base_name}.${normalized}`,
      );
      await remove_file_if_exists(final_candidate);
      await fs.promises.rename(temporary_candidate, final_candidate);
      committed_outputs.push(final_candidate);
      outputs.push({ format: normalized, path: final_candidate });
    }

    return {
      path: outputs.length
        ? outputs[0].path
        : default_output_for_format(
            absolute_input,
            resolved_output_dir,
            requested_formats[0],
            options.outputBaseName,
          ),
      outputs,
      flavor: provider,
      provider,
      model: selected_model,
    };
  } catch (error) {
    for (const created_path of committed_outputs) {
      await remove_file_if_exists(created_path);
    }
    throw error;
  } finally {
    temporary_directories.delete(temporary_output_dir);
    await remove_directory_if_exists(temporary_output_dir);
  }
}

async function transcribe_media(options = {}) {
  const provider = resolve_transcript_provider(options.provider);
  const model = resolve_model_for_provider(provider, options.model);

  if (options.dryRun) {
    const output_plan = resolve_transcript_outputs(options);
    if (options.logger && typeof options.logger.log === "function") {
      options.logger.log(
        `[dry-run] Would transcribe ${output_plan.absolute_input} -> ${output_plan.outputs
          .map((output) => output.path)
          .join(", ")} using ${provider}:${model}`,
      );
    }
    return {
      path: output_plan.outputs.length ? output_plan.outputs[0].path : "",
      outputs: output_plan.outputs,
      flavor: provider,
      provider,
      model,
      dryRun: true,
    };
  }

  if (provider === "whisper") {
    const result = await transcribeWithWhisper({
      ...options,
      model,
    });
    return {
      ...result,
      provider,
      model,
    };
  }

  if (provider === "qwen3_asr") {
    const script_path = path.join(__dirname, "qwen3_asr_runner.py");
    return await run_python_runner({
      ...options,
      provider,
      runner_name: "qwen3_asr",
      script_path,
      model,
      install_hint:
        "Install qwen-asr with: pip install -U qwen-asr (or qwen-asr[vllm]).",
      additionalArgs: [
        "--backend",
        options.qwenBackend || "transformers",
        "--aligner-model",
        options.qwenAlignerModel || DEFAULT_QWEN_ALIGNER_MODEL,
      ],
    });
  }

  if (provider === "sensevoice") {
    const script_path = path.join(__dirname, "sensevoice_runner.py");
    return await run_python_runner({
      ...options,
      provider,
      runner_name: "sensevoice",
      script_path,
      model,
      install_hint: "Install FunASR with: pip install -U funasr.",
    });
  }

  throw new Error(
    `Unsupported transcript provider '${provider}'. Supported: ${SUPPORTED_TRANSCRIPT_PROVIDERS.join(", ")}`,
  );
}

module.exports = {
  DEFAULT_QWEN_ALIGNER_MODEL,
  transcribe_media,
  list_transcript_providers,
  get_default_transcript_provider,
  get_default_model_for_provider,
  resolve_transcript_outputs,
  resolve_transcript_provider_strategy,
  resolve_transcript_provider,
  resolve_model_for_provider,
};
