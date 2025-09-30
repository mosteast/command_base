"use strict";

function create_openrouter_adapter(support_context) {
  const support = support_context || {};

  return {
    platform: "openrouter",
    async invoke(request) {
      const api_key = process.env.OPENROUTER_API_KEY;
      if (!api_key) {
        throw new Error("OPENROUTER_API_KEY is required for openrouter platform");
      }

      const base_url =
        process.env.OPENROUTER_API_BASE &&
        process.env.OPENROUTER_API_BASE.length > 0
          ? support.trim_trailing_slash(process.env.OPENROUTER_API_BASE)
          : "https://openrouter.ai/api";
      const endpoint = `${support.trim_trailing_slash(
        base_url,
      )}/v1/chat/completions`;

      const payload = {
        model:
          request.model ||
          process.env.OPENROUTER_DEFAULT_MODEL ||
          "openai/gpt-4o-mini",
        messages: support.build_messages(
          request.system_prompt,
          request.user_prompt,
        ),
      };

      if (typeof request.temperature === "number") {
        payload.temperature = request.temperature;
      }
      if (typeof request.max_tokens === "number") {
        payload.max_tokens = request.max_tokens;
      }

      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${api_key}`,
        "HTTP-Referer":
          process.env.OPENROUTER_HTTP_REFERER ||
          "https://github.com/mosteast/command_base",
        "X-Title": process.env.OPENROUTER_APP_TITLE || "command_base",
      };

      const response = await support.fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      return support.handle_openai_like_response(response);
    },
  };
}

module.exports = {
  create_openrouter_adapter,
};
