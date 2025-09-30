"use strict";

function create_claude_code_adapter(support_context) {
  const support = support_context || {};

  return {
    platform: "claude-code",
    async invoke(request, runtime_context) {
      const context = create_execution_context(support, runtime_context);
      const cli_command = process.env.CLAUDE_CODE_COMMAND || "claude";
      const cli_args = context.parse_cli_arg_string(
        process.env.CLAUDE_CODE_ARGS,
      );
      const model_flag =
        process.env.CLAUDE_CODE_MODEL_FLAG === ""
          ? null
          : process.env.CLAUDE_CODE_MODEL_FLAG || "--model";

      if (await context.command_exists(cli_command)) {
        const command_args = [...cli_args];
        if (model_flag && request.model) {
          command_args.push(model_flag, request.model);
        }
        if (process.env.CLAUDE_CODE_JSON === "1") {
          command_args.push("--json");
        }

        try {
          return await context.run_cli_command(
            cli_command,
            command_args,
            context.combine_prompts(request.system_prompt, request.user_prompt),
            {
              logger: request.logger,
              system_prompt: request.system_prompt,
            },
          );
        } catch (error) {
          request.logger?.warn?.(
            `claude CLI invocation failed (${error.message}), falling back to Anthropic API`,
          );
        }
      }

      return request_with_anthropic(context, request);
    },
  };
}

async function request_with_anthropic(context, request) {
  const api_key =
    process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
  if (!api_key) {
    throw new Error("ANTHROPIC_API_KEY is required for claude-code platform");
  }

  const base_url =
    process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_BASE_URL.length > 0
      ? context.trim_trailing_slash(process.env.ANTHROPIC_BASE_URL)
      : "https://api.anthropic.com";
  const endpoint = `${context.trim_trailing_slash(base_url)}/v1/messages`;

  const payload = {
    model:
      request.model ||
      process.env.ANTHROPIC_DEFAULT_MODEL ||
      "claude-3-5-sonnet-20241022",
    max_tokens: context.pick_number(
      request.max_tokens,
      process.env.ANTHROPIC_MAX_TOKENS,
      4096,
    ),
    messages: [
      {
        role: "user",
        content: request.user_prompt,
      },
    ],
  };

  if (request.system_prompt && request.system_prompt.trim().length > 0) {
    payload.system = request.system_prompt;
  }
  if (typeof request.temperature === "number") {
    payload.temperature = request.temperature;
  }

  const response = await context.fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": api_key,
      "anthropic-version": process.env.ANTHROPIC_API_VERSION || "2023-06-01",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error_payload = await context.safe_read_json(response);
    throw new Error(
      `Anthropic API error ${response.status}: ${JSON.stringify(error_payload)}`,
    );
  }

  const data = await response.json();
  const content_segments = Array.isArray(data.content) ? data.content : [];
  const combined_text = content_segments
    .map((segment) => {
      if (!segment) return "";
      if (typeof segment.text === "string") {
        return segment.text;
      }
      if (Array.isArray(segment)) {
        return segment
          .map((part) => (part && typeof part.text === "string" ? part.text : ""))
          .join("");
      }
      if (segment.type === "text" && typeof segment.text === "string") {
        return segment.text;
      }
      return "";
    })
    .join("")
    .trim();

  if (!combined_text) {
    throw new Error("Anthropic API returned an empty response");
  }

  return combined_text;
}

function create_execution_context(base_context, runtime_context) {
  if (!runtime_context) {
    return base_context;
  }
  return { ...base_context, ...runtime_context };
}

module.exports = {
  create_claude_code_adapter,
};
