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
          ? process.env.OPENAI_API_BASE
          : "https://api.openai.com/v1";

      const normalized_base_url = normalize_openai_base_url(base_url, support);

      if (request.logger?.debug && normalized_base_url !== base_url) {
        request.logger.debug(
          `Normalized OPENAI_API_BASE to ${normalized_base_url}`,
        );
      }

      const endpoint = `${support.trim_trailing_slash(normalized_base_url)}/chat/completions`;

      const payload = {
        model: request.model || process.env.OPENAI_DEFAULT_MODEL || "gpt-4o",
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

function normalize_openai_base_url(raw_base_url, support) {
  const fallback_base = "https://api.openai.com/v1";
  const trimming_helper =
    support && typeof support.trim_trailing_slash === "function"
      ? support.trim_trailing_slash
      : (value) => value.replace(/\/$/, "");

  const base_without_trailing = trimming_helper(
    raw_base_url && raw_base_url.length > 0 ? raw_base_url : fallback_base,
  );

  const version_regex = /\/v\d+$/i;
  const base_with_version = version_regex.test(base_without_trailing)
    ? base_without_trailing
    : `${base_without_trailing}/v1`;

  return trimming_helper(base_with_version);
}
