"use strict";

const DEFAULT_AUDIO_FORMAT = "wav";
const SUPPORTED_AUDIO_FORMATS = new Set(["wav", "mp3", "ogg", "flac", "webm"]);

function resolve_audio_format(requested_format, fallback_format) {
  const default_format = fallback_format || DEFAULT_AUDIO_FORMAT;
  if (!requested_format) {
    return default_format;
  }

  const normalized = `${requested_format}`.trim().toLowerCase();
  if (!SUPPORTED_AUDIO_FORMATS.has(normalized)) {
    const allowed = Array.from(SUPPORTED_AUDIO_FORMATS).sort().join(", ");
    throw new Error(
      `Unsupported audio format \"${requested_format}\". Allowed formats: ${allowed}.`,
    );
  }
  return normalized;
}

function trim_text(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/[\r\n\t ]+/g, " ").trim();
}

function validate_context(context) {
  if (!context || typeof context !== "object") {
    throw new Error("TTS plugin expects a non-null context object.");
  }
  if (!context.text_content || !trim_text(context.text_content)) {
    throw new Error("TTS plugin received empty text content.");
  }
  if (!context.output_file_path) {
    throw new Error("TTS plugin requires an output file path.");
  }
}

function remove_empty_fields(payload) {
  Object.keys(payload).forEach((key) => {
    if (
      payload[key] === undefined ||
      payload[key] === null ||
      payload[key] === ""
    ) {
      delete payload[key];
    }
  });
  return payload;
}

function parse_optional_json(raw_value, source_label) {
  if (!raw_value) {
    return {};
  }

  try {
    if (typeof raw_value === "string") {
      const trimmed = raw_value.trim();
      if (!trimmed) {
        return {};
      }
      return JSON.parse(trimmed);
    }
    return JSON.parse(JSON.stringify(raw_value));
  } catch (error) {
    const label = source_label ? ` from ${source_label}` : "";
    throw new Error(`Failed to parse JSON${label}: ${error.message}`);
  }
}

function normalize_additional_options(raw_options, source_label) {
  if (!raw_options) {
    return {};
  }
  if (typeof raw_options === "string" || Array.isArray(raw_options)) {
    return parse_optional_json(raw_options, source_label);
  }
  if (typeof raw_options === "object") {
    return raw_options;
  }
  throw new Error(
    `Unsupported additional options type (${typeof raw_options}) from ${source_label}.`,
  );
}

function merge_payload(base_payload, extra_payload) {
  const merged = { ...base_payload };
  const extras = extra_payload || {};
  Object.keys(extras).forEach((key) => {
    const value = extras[key];
    if (value === undefined || value === null) {
      return;
    }
    merged[key] = value;
  });
  return merged;
}

module.exports = {
  DEFAULT_AUDIO_FORMAT,
  SUPPORTED_AUDIO_FORMATS,
  resolve_audio_format,
  validate_context,
  remove_empty_fields,
  parse_optional_json,
  normalize_additional_options,
  merge_payload,
};
