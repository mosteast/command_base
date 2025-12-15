"use strict";

function create_codex_adapter(support_context) {
  const support = support_context || {};

  return {
    platform: "codex",
    async invoke(request, runtime_context) {
      const context = create_execution_context(support, runtime_context);
      const cli_command = process.env.CODEX_CLI_COMMAND || "codex";
      const raw_cli_args = context.parse_cli_arg_string(
        process.env.CODEX_CLI_ARGS,
      );
      const cli_args = ensure_non_interactive_cli_args(
        sanitize_codex_cli_args(raw_cli_args, request.logger),
      );
      const model_flag =
        process.env.CODEX_CLI_MODEL_FLAG === ""
          ? null
          : process.env.CODEX_CLI_MODEL_FLAG || "--model";

      if (await context.command_exists(cli_command)) {
        const command_args = [...cli_args];
        if (model_flag && request.model) {
          command_args.push(model_flag, request.model);
        }
        if (process.env.CODEX_CLI_NO_STREAM === "1") {
          command_args.push("--no-stream");
        }

        ensure_stdin_placeholder(command_args);

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
            `codex CLI invocation failed (${error.message}), falling back to OpenAI API`,
          );
        }
      }

      if (!context.invoke_adapter) {
        throw new Error(
          "Codex adapter requires an invoke_adapter helper for fallback.",
        );
      }

      return context.invoke_adapter("openai", request);
    },
  };
}

function create_execution_context(base_context, runtime_context) {
  if (!runtime_context) {
    return base_context;
  }
  return { ...base_context, ...runtime_context };
}

function ensure_non_interactive_cli_args(cli_args) {
  const sanitized_args = Array.isArray(cli_args)
    ? cli_args.filter((entry) => typeof entry === "string" && entry.length > 0)
    : [];

  const args_copy = [...sanitized_args];
  const double_dash_index = args_copy.indexOf("--");
  const search_limit =
    double_dash_index === -1 ? args_copy.length : double_dash_index;
  const first_positional_index = args_copy.findIndex((arg, index) => {
    if (index >= search_limit) {
      return false;
    }
    return !arg.startsWith("-");
  });

  if (first_positional_index === -1) {
    args_copy.push("exec");
    return args_copy;
  }

  const first_positional_value = args_copy[first_positional_index];
  const preserved_subcommands = new Set(["exec", "resume", "help", "login"]);
  if (preserved_subcommands.has(first_positional_value)) {
    return args_copy;
  }

  args_copy.splice(first_positional_index, 0, "exec");
  return args_copy;
}

function ensure_stdin_placeholder(command_args) {
  if (!Array.isArray(command_args)) {
    return;
  }

  const exec_index = command_args.indexOf("exec");
  if (exec_index === -1) {
    return;
  }

  const flags_without_value = new Set([
    "--no-stream",
    "--json",
    "--oss",
    "--full-auto",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "--help",
    "--version",
    "-h",
    "-V",
  ]);

  let index = exec_index + 1;
  let double_dash_position = -1;
  let has_stdin_placeholder = false;
  let has_prompt_argument = false;

  while (index < command_args.length) {
    const token = command_args[index];
    if (token === "-") {
      has_stdin_placeholder = true;
      break;
    }
    if (token === "--") {
      double_dash_position = index;
      index += 1;
      break;
    }
    if (token.startsWith("-")) {
      if (flags_without_value.has(token) || token.includes("=")) {
        index += 1;
      } else {
        index += 2;
      }
      continue;
    }
    has_prompt_argument = true;
    break;
  }

  if (
    double_dash_position !== -1 &&
    !has_stdin_placeholder &&
    !has_prompt_argument
  ) {
    let positional_index = double_dash_position + 1;
    while (positional_index < command_args.length) {
      const positional_token = command_args[positional_index];
      if (positional_token === "-") {
        has_stdin_placeholder = true;
        break;
      }
      if (!positional_token.startsWith("-")) {
        has_prompt_argument = true;
        break;
      }
      positional_index += 1;
    }
  }

  if (has_stdin_placeholder || has_prompt_argument) {
    return;
  }

  if (double_dash_position !== -1) {
    command_args.splice(double_dash_position + 1, 0, "-");
    return;
  }

  command_args.push("--", "-");
}

function sanitize_codex_cli_args(cli_args, logger) {
  if (!Array.isArray(cli_args) || cli_args.length === 0) {
    return [];
  }

  const supported_effort_values = new Set(["minimal", "low", "medium", "high"]);
  const sanitized_args = [];
  let override_adjusted = false;

  const normalize_effort_override = (override_value) => {
    if (typeof override_value !== "string" || override_value.length === 0) {
      return override_value;
    }
    const [key, raw_value = ""] = override_value.split("=", 2);
    if (key !== "model_reasoning_effort") {
      return override_value;
    }
    const normalized_value = raw_value.trim().toLowerCase();
    if (supported_effort_values.has(normalized_value)) {
      const canonical_value = normalized_value;
      if (canonical_value !== raw_value) {
        override_adjusted = true;
      }
      return `${key}=${canonical_value}`;
    }
    override_adjusted = true;
    return `${key}=high`;
  };

  for (let index = 0; index < cli_args.length; index += 1) {
    const token = cli_args[index];
    const has_inline_override =
      typeof token === "string" && token.startsWith("--override=");
    if (has_inline_override) {
      const sanitized_override = normalize_effort_override(
        token.slice("--override=".length),
      );
      if (
        typeof sanitized_override === "string" &&
        sanitized_override.length > 0
      ) {
        sanitized_args.push("--override", sanitized_override);
      } else {
        sanitized_args.push(token);
      }
      continue;
    }

    const is_override_flag = token === "--override" || token === "-o";
    if (is_override_flag) {
      const next_value = cli_args[index + 1];
      const sanitized_override =
        typeof next_value === "string"
          ? normalize_effort_override(next_value)
          : next_value;

      if (
        typeof sanitized_override === "string" &&
        sanitized_override.length > 0
      ) {
        sanitized_args.push("--override", sanitized_override);
        index += 1;
        continue;
      }

      // Preserve original tokens when override value is missing or non-string.
      sanitized_args.push(token);
      if (next_value !== undefined) {
        sanitized_args.push(next_value);
        index += 1;
      }
      continue;
    }

    sanitized_args.push(token);
  }

  if (override_adjusted && logger?.warn) {
    logger.warn(
      "Adjusted CODEX_CLI_ARGS model_reasoning_effort to supported value (minimal|low|medium|high).",
    );
  }

  return sanitized_args;
}

module.exports = {
  create_codex_adapter,
};
