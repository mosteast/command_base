"use strict";

const { perform_http_tts_request, write_audio_file } = require("./http_client");
const {
  DEFAULT_AUDIO_FORMAT,
  resolve_audio_format,
  validate_context,
  remove_empty_fields,
  parse_optional_json,
  normalize_additional_options,
  merge_payload,
} = require("./shared");

const INDEX_TTS_MODEL_ID = "index-tts";
const DEFAULT_INDEX_TTS_MODEL = "index-tts";
const DEFAULT_API_URL = "https://api.index.ai/v1/tts";

function build_request_payload(context, audio_format) {
  const base_payload = remove_empty_fields({
    text: context.text_content,
    model: process.env.INDEX_TTS_MODEL || DEFAULT_INDEX_TTS_MODEL,
    voice_id: context.voice_id || process.env.INDEX_TTS_VOICE_ID,
    language: context.language || process.env.INDEX_TTS_LANGUAGE,
    style: context.style_id || context.style,
    speed: context.speaking_rate,
    format: audio_format,
  });

  const env_options = parse_optional_json(
    process.env.INDEX_TTS_EXTRA_OPTIONS,
    "INDEX_TTS_EXTRA_OPTIONS",
  );
  const context_options = normalize_additional_options(
    context.additional_options,
    "context.additional_options",
  );

  return merge_payload(
    merge_payload(base_payload, env_options),
    context_options,
  );
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
      `[DRY-RUN] ${INDEX_TTS_MODEL_ID} would synthesize ${output_file_path}`,
    );
    return {
      model_id: INDEX_TTS_MODEL_ID,
      output_file_path,
      audio_format: resolved_format,
      bytes_written: 0,
    };
  }

  const api_key = process.env.INDEX_TTS_API_KEY;
  if (!api_key) {
    throw new Error(
      "Environment variable INDEX_TTS_API_KEY is required for index-tts synthesis.",
    );
  }

  const api_url = process.env.INDEX_TTS_API_URL || DEFAULT_API_URL;

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
    model_id: INDEX_TTS_MODEL_ID,
    output_file_path,
    audio_format: resolved_format,
    bytes_written: audio_buffer.length,
  };
}

const index_tts_model = {
  tts_model_id: INDEX_TTS_MODEL_ID,
  model_label: "Index AI TTS",
  description:
    "Text-to-speech model served by Index AI platform. Requires INDEX_TTS_API_KEY.",
  default_audio_format: DEFAULT_AUDIO_FORMAT,
  synthesize_text,
};

module.exports = {
  index_tts_model,
  INDEX_TTS_MODEL_ID,
};
