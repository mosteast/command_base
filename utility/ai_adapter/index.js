"use strict";

const { create_codex_adapter } = require("./codex_adapter");
const { create_claude_code_adapter } = require("./claude_code_adapter");
const { create_openai_adapter } = require("./openai_adapter");
const { create_openrouter_adapter } = require("./openrouter_adapter");
const { create_gemini_adapter } = require("./gemini_adapter");

const adapter_factories = Object.freeze({
  codex: create_codex_adapter,
  "claude-code": create_claude_code_adapter,
  openai: create_openai_adapter,
  openrouter: create_openrouter_adapter,
  gemini: create_gemini_adapter,
});

const default_ai_platform = "codex";

function list_ai_platforms() {
  return Object.keys(adapter_factories);
}

function get_ai_adapter(platform_name, support_context) {
  const normalized = (platform_name || "").toLowerCase();
  const factory = adapter_factories[normalized];
  if (!factory) {
    return null;
  }
  const adapter = factory(support_context || {});
  if (!adapter || typeof adapter.invoke !== "function") {
    throw new Error(`Adapter for platform \"${normalized}\" does not expose an invoke method.`);
  }
  return adapter;
}

module.exports = {
  default_ai_platform,
  list_ai_platforms,
  get_ai_adapter,
};
