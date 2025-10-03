"use strict";

const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const {
  DEFAULT_AUDIO_FORMAT,
  resolve_audio_format,
  validate_context,
} = require("./shared");

const XTTS_V2_MODEL_ID = "xtts-v2";
const XTTS_LOCAL_SCRIPT_PATH = path.resolve(
  __dirname,
  "..",
  "index_tts",
  "engines",
  "xtts_local.py",
);
const DEFAULT_LANGUAGE_CODE = "en";
const DEFAULT_SPEAKING_RATE = 1.0;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_DEVICE = "auto";
const SUPPORTED_VOICE_REFERENCE_EXTENSIONS = new Set([
  ".wav",
  ".flac",
  ".ogg",
  ".mp3",
]);
const COLOR_PALETTE = {
  info: (text) => `\u001b[36m${text}\u001b[0m`,
  warn: (text) => `\u001b[33m${text}\u001b[0m`,
  error: (text) => `\u001b[31m${text}\u001b[0m`,
};

function resolve_python_bin(context) {
  const candidate_bins = [
    context?.python_bin,
    context?.python_path,
    process.env.COQUI_PYTHON_BIN,
    process.env.PYTHON_BIN,
    process.env.PYTHON,
  ].filter((value, index, array) => {
    if (!value) {
      return false;
    }
    if (typeof value !== "string") {
      return false;
    }
    return array.indexOf(value) === index;
  });

  if (candidate_bins.length > 0) {
    const primary = candidate_bins.find((value) => value.trim().length > 0);
    if (primary) {
      return primary.trim();
    }
  }

  return process.platform === "win32" ? "python" : "python3";
}

function resolve_language_code(context) {
  const raw_language =
    context?.language ||
    process.env.COQUI_DEFAULT_LANGUAGE ||
    DEFAULT_LANGUAGE_CODE;
  return `${raw_language}`.trim() || DEFAULT_LANGUAGE_CODE;
}

function resolve_device_choice(context) {
  const raw_device =
    context?.device ||
    context?.execution_device ||
    process.env.COQUI_TTS_DEVICE ||
    DEFAULT_DEVICE;
  return `${raw_device}`.trim() || DEFAULT_DEVICE;
}

function resolve_speaker_id(context) {
  const raw_speaker = context?.speaker_id || context?.speaker;
  if (!raw_speaker) {
    return null;
  }
  const trimmed = `${raw_speaker}`.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolve_speaking_rate(context) {
  const raw_rate =
    context?.speaking_rate ?? context?.speed ?? process.env.COQUI_SPEAKING_RATE;
  if (raw_rate === undefined || raw_rate === null || raw_rate === "") {
    return DEFAULT_SPEAKING_RATE;
  }
  const numeric_rate = Number(raw_rate);
  if (!Number.isFinite(numeric_rate) || numeric_rate <= 0) {
    throw new Error("XTTS speaking rate must be a positive number.");
  }
  return numeric_rate;
}

function resolve_temperature_value(context) {
  const raw_temperature =
    context?.sampling_temperature ??
    context?.temperature ??
    process.env.COQUI_TEMPERATURE;
  if (
    raw_temperature === undefined ||
    raw_temperature === null ||
    raw_temperature === ""
  ) {
    return DEFAULT_TEMPERATURE;
  }
  const numeric_temperature = Number(raw_temperature);
  if (!Number.isFinite(numeric_temperature) || numeric_temperature <= 0) {
    throw new Error("XTTS sampling temperature must be greater than zero.");
  }
  return numeric_temperature;
}

function looks_like_file_path(value) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.toLowerCase().endsWith(".wav") ||
    trimmed.toLowerCase().endsWith(".mp3") ||
    trimmed.toLowerCase().endsWith(".flac")
  );
}

async function resolve_voice_reference_path(context, logger) {
  const candidate_fields = [
    context?.voice_reference_path,
    context?.voice_path,
    context?.voice_sample_path,
    context?.voice,
  ];

  let candidate = null;
  for (const field of candidate_fields) {
    if (typeof field === "string" && field.trim()) {
      candidate = field.trim();
      break;
    }
  }

  if (!candidate && typeof context?.voice_id === "string") {
    const voice_id = context.voice_id.trim();
    if (voice_id && looks_like_file_path(voice_id)) {
      candidate = voice_id;
    }
  }

  if (!candidate) {
    return null;
  }

  const resolved_path = path.resolve(process.cwd(), candidate);
  try {
    await fs.access(resolved_path);
  } catch (error) {
    throw new Error(
      `Voice reference file not accessible at ${resolved_path}: ${error.message}`,
    );
  }

  const extension = path.extname(resolved_path).toLowerCase();
  if (extension && !SUPPORTED_VOICE_REFERENCE_EXTENSIONS.has(extension)) {
    logger?.warn?.(
      COLOR_PALETTE.warn(
        `[XTTS] Voice reference ${resolved_path} uses unsupported extension "${extension}". Convert to WAV (or supported lossless format) and retry. Using default speaker instead.`,
      ),
    );
    return null;
  }
  return resolved_path;
}

async function ensure_output_directory(output_path) {
  const directory_path = path.dirname(output_path);
  await fs.mkdir(directory_path, { recursive: true });
}

function build_xtts_arguments(options) {
  const args = [
    XTTS_LOCAL_SCRIPT_PATH,
    "--text",
    options.text_content,
    "--out",
    options.output_file_path,
    "--lang",
    options.language_code,
    "--speed",
    `${options.speaking_rate}`,
    "--temperature",
    `${options.temperature_value}`,
    "--device",
    options.device_choice,
  ];

  if (options.voice_reference_path) {
    args.push("--voice", options.voice_reference_path);
  }

  if (options.speaker_id) {
    args.push("--speaker", options.speaker_id);
  }

  return args;
}

async function run_python_process(python_bin, args, spawn_options) {
  return new Promise((resolve, reject) => {
    const child = spawn(python_bin, args, {
      cwd: spawn_options.cwd || process.cwd(),
      env: spawn_options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr_buffer = "";

    child.stdout.on("data", (chunk) => {
      const trimmed = chunk.toString().trim();
      if (trimmed && spawn_options.logger?.info) {
        spawn_options.logger.info(COLOR_PALETTE.info(`[XTTS] ${trimmed}`));
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr_buffer += text;
      const trimmed = text.trim();
      if (trimmed && spawn_options.logger?.warn) {
        spawn_options.logger.warn(COLOR_PALETTE.warn(`[XTTS] ${trimmed}`));
      }
    });

    child.on("error", (error) => {
      const message = `Failed to launch Coqui XTTS process (${python_bin}): ${error.message}`;
      reject(new Error(message));
    });

    child.on("close", (exit_code) => {
      if (exit_code !== 0) {
        const stderr_message = stderr_buffer.trim();
        const fallback = `Process exited with code ${exit_code}.`;
        const message = stderr_message ? `${stderr_message}` : fallback;
        reject(new Error(`Coqui XTTS local synthesis failed: ${message}`));
        return;
      }
      resolve();
    });
  });
}

async function synthesize_text(context) {
  validate_context(context);

  const dry_run = Boolean(context?.dry_run);
  const logger = context?.logger;

  const resolved_format = resolve_audio_format(
    context.audio_format,
    DEFAULT_AUDIO_FORMAT,
  );

  const output_path = path.resolve(process.cwd(), context.output_file_path);

  if (dry_run) {
    logger?.info?.(
      COLOR_PALETTE.info(
        `[DRY-RUN] ${XTTS_V2_MODEL_ID} would synthesize ${output_path}`,
      ),
    );
    return {
      model_id: XTTS_V2_MODEL_ID,
      output_file_path: output_path,
      audio_format: resolved_format,
      bytes_written: 0,
    };
  }

  const python_bin = resolve_python_bin(context);
  const language_code = resolve_language_code(context);
  const device_choice = resolve_device_choice(context);
  const speaker_id = resolve_speaker_id(context);
  const speaking_rate = resolve_speaking_rate(context);
  const temperature_value = resolve_temperature_value(context);
  const voice_reference_path = await resolve_voice_reference_path(
    context,
    logger,
  );

  await ensure_output_directory(output_path);

  const xtts_args = build_xtts_arguments({
    text_content: context.text_content,
    output_file_path: output_path,
    language_code,
    voice_reference_path,
    speaker_id,
    speaking_rate,
    temperature_value,
    device_choice,
  });

  const spawn_env = {
    ...process.env,
    COQUI_TOS_AGREED: "1",
  };

  if (logger?.info) {
    logger.info(
      COLOR_PALETTE.info(
        `[XTTS] Launching local inference with ${python_bin} (${device_choice}).`,
      ),
    );
  }

  await run_python_process(python_bin, xtts_args, {
    env: spawn_env,
    cwd: process.cwd(),
    logger,
  });

  const audio_stats = await fs.stat(output_path);

  if (logger?.info) {
    logger.info(
      COLOR_PALETTE.info(
        `[XTTS] Wrote ${audio_stats.size} bytes to ${output_path}.`,
      ),
    );
  }

  return {
    model_id: XTTS_V2_MODEL_ID,
    output_file_path: output_path,
    audio_format: resolved_format,
    bytes_written: audio_stats.size,
  };
}

const xtts_v2_model = {
  tts_model_id: XTTS_V2_MODEL_ID,
  model_label: "Coqui XTTS v2",
  description:
    "Local Coqui XTTS v2 synthesis using the xtts_local.py engine script.",
  default_audio_format: DEFAULT_AUDIO_FORMAT,
  synthesize_text,
};

module.exports = {
  xtts_v2_model,
  XTTS_V2_MODEL_ID,
};
