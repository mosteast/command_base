"use strict";

const fs = require("fs/promises");
const path = require("path");

const DEFAULT_TIMEOUT_MS = 120_000;

function normalize_headers(headers) {
  const normalized = {};
  if (!headers) {
    return normalized;
  }
  const entries = Object.entries(headers);
  for (const [key, value] of entries) {
    if (value === undefined || value === null) {
      continue;
    }
    normalized[key.toLowerCase()] = `${value}`;
  }
  return normalized;
}

function pick_header(headers, name) {
  if (!headers) {
    return null;
  }
  const lower_name = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower_name) {
      return value;
    }
  }
  return null;
}

async function ensure_directory_exists(file_path) {
  const directory_path = path.dirname(file_path);
  await fs.mkdir(directory_path, { recursive: true });
}

async function write_audio_file(file_path, audio_buffer) {
  if (!Buffer.isBuffer(audio_buffer)) {
    throw new Error("Audio buffer must be a Node.js Buffer instance.");
  }
  await ensure_directory_exists(file_path);
  await fs.writeFile(file_path, audio_buffer);
}

async function fetch_with_timeout(url, request_options) {
  const controller = new AbortController();
  const timeout_ms = request_options?.timeout_ms || DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeout_ms);
  try {
    const response = await fetch(url, {
      method: request_options?.method || "POST",
      headers: request_options?.headers,
      body: request_options?.body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    if (error?.name === "AbortError") {
      throw new Error(`Request to ${url} timed out after ${timeout_ms} ms.`);
    }
    throw error;
  }
}

async function read_audio_buffer_from_response(response) {
  const response_headers = normalize_headers(
    Object.fromEntries(response.headers.entries()),
  );
  const content_type = pick_header(response_headers, "content-type") || "";
  const lower_content_type = content_type.toLowerCase();

  if (
    lower_content_type.startsWith("audio/") ||
    lower_content_type === "application/octet-stream"
  ) {
    const raw_audio = await response.arrayBuffer();
    return Buffer.from(raw_audio);
  }

  const response_text = await response.text();
  let parsed_json = null;

  try {
    parsed_json = JSON.parse(response_text);
  } catch (parse_error) {
    throw new Error(
      `Unexpected response format (content-type: ${content_type}): ${parse_error.message}`,
    );
  }

  const candidate_fields = [
    "audio",
    "audio_base64",
    "audioContent",
    "audio_data",
    "voice",
  ];

  for (const field_name of candidate_fields) {
    const field_value = parsed_json[field_name];
    if (typeof field_value === "string" && field_value.length > 0) {
      try {
        return Buffer.from(field_value, "base64");
      } catch (error) {
        throw new Error(
          `Failed to decode base64 audio from field \"${field_name}\": ${error.message}`,
        );
      }
    }
  }

  throw new Error(
    `No audio data found in JSON response. Payload keys: ${Object.keys(parsed_json).join(", ")}`,
  );
}

async function perform_http_tts_request(options) {
  if (!options || typeof options !== "object") {
    throw new Error("HTTP TTS request options must be a non-null object.");
  }

  const { url, method, headers, body, timeout_ms } = options;

  if (!url || typeof url !== "string") {
    throw new Error("A non-empty URL is required for HTTP TTS requests.");
  }

  const request_headers = { ...headers };
  if (
    body &&
    typeof body === "object" &&
    !(body instanceof Buffer) &&
    !ArrayBuffer.isView(body)
  ) {
    request_headers["content-type"] =
      request_headers["content-type"] || "application/json";
  }

  let request_body = body;
  if (request_headers["content-type"] === "application/json" && body) {
    request_body = JSON.stringify(body);
  }

  const response = await fetch_with_timeout(url, {
    method,
    headers: request_headers,
    body: request_body,
    timeout_ms,
  });

  if (!response.ok) {
    const error_text = await response
      .text()
      .catch(() => "(failed to read body)");
    throw new Error(
      `HTTP ${response.status} ${response.statusText} from ${url}: ${error_text}`,
    );
  }

  const audio_buffer = await read_audio_buffer_from_response(response);
  return { audio_buffer };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  perform_http_tts_request,
  write_audio_file,
};
