"use strict";

const { perform_http_tts_request, write_audio_file } = require("./http_client");
const {
  DEFAULT_AUDIO_FORMAT,
  resolve_audio_format,
  validate_context,
  remove_empty_fields,
} = require("./shared");

const XTTS_V2_MODEL_ID = "xtts-v2";

function build_request_payload(context, audio_format) {
  const payload = {
    text: context.text_content,
    model_id: "xtts_v2",
    voice_id: context.voice_id || process.env.COQUI_DEFAULT_VOICE_ID,
    language: context.language || process.env.COQUI_DEFAULT_LANGUAGE || "en",
    speaker: context.speaker_id,
    speed: context.speaking_rate,
    seed: context.random_seed,
    audio_format,
  };

  return remove_empty_fields(payload);
}

async function synthesize_text(context) {
  validate_context(context);

  const { output_file_path, dry_run, logger } = context;

  const resolved_format = resolve_audio_format(
    context.audio_format,
    DEFAULT_AUDIO_FORMAT,
  );

  if (dry_run) {
    logger?.info?.(
      `[DRY-RUN] ${XTTS_V2_MODEL_ID} would synthesize ${output_file_path}`,
    );
    return {
      model_id: XTTS_V2_MODEL_ID,
      output_file_path,
      audio_format: resolved_format,
      bytes_written: 0,
    };
  }

  const api_key = process.env.COQUI_API_KEY;
  if (!api_key) {
    throw new Error(
      "Environment variable COQUI_API_KEY is required for XTTS v2 synthesis.",
    );
  }

  const api_url =
    process.env.COQUI_API_URL || "https://app.coqui.ai/api/v2/generate-clip";

  const headers = {
    Authorization: `Bearer ${api_key}`,
    Accept: "application/json",
  };

  const request_payload = build_request_payload(context, resolved_format);

  const { audio_buffer } = await perform_http_tts_request({
    url: api_url,
    headers,
    body: request_payload,
    timeout_ms: context.request_timeout_ms,
  });

  await write_audio_file(output_file_path, audio_buffer);

  return {
    model_id: XTTS_V2_MODEL_ID,
    output_file_path,
    audio_format: resolved_format,
    bytes_written: audio_buffer.length,
  };
}

const xtts_v2_model = {
  tts_model_id: XTTS_V2_MODEL_ID,
  model_label: "Coqui XTTS v2",
  description:
    "Neural text-to-speech model provided by Coqui, supporting multilingual synthesis.",
  default_audio_format: DEFAULT_AUDIO_FORMAT,
  synthesize_text,
};

module.exports = {
  xtts_v2_model,
  XTTS_V2_MODEL_ID,
};
