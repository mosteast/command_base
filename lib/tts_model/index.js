"use strict";

const { xtts_v2_model, XTTS_V2_MODEL_ID } = require("./xtts_v2");
const { index_tts_model, INDEX_TTS_MODEL_ID } = require("./index_tts");
const { vibe_voice_model, VIBE_VOICE_MODEL_ID } = require("./vibe_voice");
const { resolve_audio_format, DEFAULT_AUDIO_FORMAT } = require("./shared");

const REGISTERED_MODELS = [xtts_v2_model, index_tts_model, vibe_voice_model];

const MODEL_REGISTRY = new Map();
for (const model_entry of REGISTERED_MODELS) {
  if (!model_entry || typeof model_entry !== "object") {
    continue;
  }
  const { tts_model_id, synthesize_text } = model_entry;
  if (!tts_model_id) {
    throw new Error("Encountered TTS model without tts_model_id.");
  }
  if (typeof synthesize_text !== "function") {
    throw new Error(
      `TTS model \"${tts_model_id}\" must provide a synthesize_text function.`,
    );
  }
  if (MODEL_REGISTRY.has(tts_model_id)) {
    throw new Error(`Duplicate TTS model identifier detected: ${tts_model_id}`);
  }
  MODEL_REGISTRY.set(tts_model_id, model_entry);
}

const DEFAULT_TTS_MODEL_ID = XTTS_V2_MODEL_ID;

function list_tts_models() {
  return Array.from(MODEL_REGISTRY.keys());
}

function get_tts_model(model_id) {
  const resolved_id = model_id || DEFAULT_TTS_MODEL_ID;
  const entry = MODEL_REGISTRY.get(resolved_id);
  if (!entry) {
    const available = list_tts_models().join(", ");
    throw new Error(
      `Unknown TTS model \"${model_id}\". Available models: ${available}.`,
    );
  }
  return entry;
}

module.exports = {
  list_tts_models,
  get_tts_model,
  default_tts_model_id: DEFAULT_TTS_MODEL_ID,
  resolve_audio_format,
  DEFAULT_AUDIO_FORMAT,
};
