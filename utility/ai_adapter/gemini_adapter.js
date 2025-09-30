"use strict";

function create_gemini_adapter(support_context) {
  const support = support_context || {};

  return {
    platform: "gemini",
    async invoke(request) {
      const api_key = process.env.GEMINI_API_KEY;
      if (!api_key) {
        throw new Error("GEMINI_API_KEY is required for gemini platform");
      }

      const base_url =
        process.env.GEMINI_API_BASE && process.env.GEMINI_API_BASE.length > 0
          ? support.trim_trailing_slash(process.env.GEMINI_API_BASE)
          : "https://generativelanguage.googleapis.com";

      const model_name =
        request.model ||
        process.env.GEMINI_DEFAULT_MODEL ||
        "gemini-2.0-flash-exp";
      const endpoint = `${support.trim_trailing_slash(
        base_url,
      )}/v1beta/models/${encodeURIComponent(model_name)}:generateContent?key=${encodeURIComponent(
        api_key,
      )}`;

      const payload = {
        contents: [
          {
            role: "user",
            parts: [
              {
                text: request.user_prompt,
              },
            ],
          },
        ],
      };

      if (request.system_prompt && request.system_prompt.trim().length > 0) {
        payload.system_instruction = {
          role: "system",
          parts: [
            {
              text: request.system_prompt,
            },
          ],
        };
      }
      if (typeof request.temperature === "number") {
        payload.generation_config = {
          temperature: request.temperature,
        };
      }
      if (typeof request.max_tokens === "number") {
        payload.generation_config = payload.generation_config || {};
        payload.generation_config.max_output_tokens = request.max_tokens;
      }

      const response = await support.fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error_payload = await support.safe_read_json(response);
        throw new Error(
          `Gemini API error ${response.status}: ${JSON.stringify(error_payload)}`,
        );
      }

      const data = await response.json();
      const candidates = Array.isArray(data.candidates) ? data.candidates : [];
      const first_candidate = candidates.find((candidate) => candidate.content);
      if (!first_candidate || !first_candidate.content) {
        throw new Error("Gemini API returned no content");
      }

      const parts = Array.isArray(first_candidate.content.parts)
        ? first_candidate.content.parts
        : [];
      const combined_text = parts
        .map((part) => (part && typeof part.text === "string" ? part.text : ""))
        .join("")
        .trim();

      if (!combined_text) {
        throw new Error("Gemini API returned an empty response");
      }

      return combined_text;
    },
  };
}

module.exports = {
  create_gemini_adapter,
};
