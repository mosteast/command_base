"use strict";

function create_openai_adapter(support_context) {
  const support = support_context || {};

  return {
    platform: "openai",
    async invoke(request) {
      const api_key = process.env.OPENAI_API_KEY;
      if (!api_key) {
        throw new Error("OPENAI_API_KEY is required for openai platform");
      }

      const base_url =
        process.env.OPENAI_API_BASE && process.env.OPENAI_API_BASE.length > 0
          ? support.trim_trailing_slash(process.env.OPENAI_API_BASE)
          : "https://api.openai.com/v1";
      const endpoint = `${support.trim_trailing_slash(base_url)}/chat/completions`;

      const payload = {
        model:
          request.model || process.env.OPENAI_DEFAULT_MODEL || "gpt-4o",
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

      const response = await support.fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${api_key}`,
        },
        body: JSON.stringify(payload),
      });

      return support.handle_openai_like_response(response);
    },
  };
}

module.exports = {
  create_openai_adapter,
};
