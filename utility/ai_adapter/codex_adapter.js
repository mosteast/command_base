"use strict";

const fs = require("fs/promises");
const os = require("os");
const path = require("path");

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
          request.logger?.warn?.(
            "Ignoring legacy CODEX_CLI_NO_STREAM=1 (codex-cli no longer supports --no-stream).",
          );
        }

        const output_last_message_path =
          extract_output_last_message_path(command_args) ||
          (await create_temp_output_last_message_path());

        const should_cleanup_output_last_message =
          !has_output_last_message_flag(command_args);

        if (!has_output_last_message_flag(command_args)) {
          inject_output_last_message_flag(
            command_args,
            output_last_message_path,
          );
        }

        ensure_stdin_placeholder(command_args);

        try {
          const stdout_payload = await context.run_cli_command(
            cli_command,
            command_args,
            context.combine_prompts(request.system_prompt, request.user_prompt),
            {
              logger: request.logger,
              system_prompt: request.system_prompt,
            },
          );
          try {
            const last_message = await fs.readFile(
              output_last_message_path,
              "utf8",
            );
            const trimmed_message = last_message.trim();
            if (trimmed_message.length > 0) {
              return trimmed_message;
            }
          } catch (error) {
            // fall back to parsing stdout payload
          }

          const fallback_message =
            extract_last_codex_message_from_stdout(stdout_payload);
          if (fallback_message) {
            return fallback_message;
          }

          throw new Error("codex-cli returned an empty last message");
        } catch (error) {
          request.logger?.warn?.(
            `codex CLI invocation failed (${error.message}), falling back to OpenAI API`,
          );
        } finally {
          if (should_cleanup_output_last_message) {
            await safe_cleanup_output_last_message(output_last_message_path);
          }
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

function has_output_last_message_flag(command_args) {
  if (!Array.isArray(command_args)) {
    return false;
  }

  const double_dash_index = command_args.indexOf("--");
  const search_limit =
    double_dash_index === -1 ? command_args.length : double_dash_index;

  for (let index = 0; index < search_limit; index += 1) {
    const token = command_args[index];
    if (token === "--output-last-message") {
      return true;
    }
    if (
      typeof token === "string" &&
      token.startsWith("--output-last-message=")
    ) {
      return true;
    }
  }

  return false;
}

function extract_output_last_message_path(command_args) {
  if (!Array.isArray(command_args)) {
    return null;
  }

  const double_dash_index = command_args.indexOf("--");
  const search_limit =
    double_dash_index === -1 ? command_args.length : double_dash_index;

  for (let index = 0; index < search_limit; index += 1) {
    const token = command_args[index];
    if (token === "--output-last-message") {
      const candidate_path = command_args[index + 1];
      if (typeof candidate_path === "string" && candidate_path.length > 0) {
        return candidate_path;
      }
      return null;
    }
    if (
      typeof token === "string" &&
      token.startsWith("--output-last-message=")
    ) {
      const candidate_path = token.slice("--output-last-message=".length);
      return candidate_path.length > 0 ? candidate_path : null;
    }
  }

  return null;
}

function inject_output_last_message_flag(
  command_args,
  output_last_message_path,
) {
  if (
    !Array.isArray(command_args) ||
    typeof output_last_message_path !== "string" ||
    output_last_message_path.length === 0
  ) {
    return;
  }

  const double_dash_index = command_args.indexOf("--");
  const insertion_index =
    double_dash_index === -1 ? command_args.length : double_dash_index;

  command_args.splice(
    insertion_index,
    0,
    "--output-last-message",
    output_last_message_path,
  );
}

function extract_last_codex_message_from_stdout(stdout_payload) {
  if (
    typeof stdout_payload !== "string" ||
    stdout_payload.trim().length === 0
  ) {
    return null;
  }

  const normalized_payload = stdout_payload.replace(/\r\n/g, "\n");
  const lines = normalized_payload.split("\n");

  let last_marker_index = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s+codex\s*$/u.test(line)) {
      last_marker_index = index;
    }
  }

  if (last_marker_index === -1) {
    return null;
  }

  let content_start_index = last_marker_index + 1;
  while (
    content_start_index < lines.length &&
    lines[content_start_index].trim().length === 0
  ) {
    content_start_index += 1;
  }

  if (content_start_index >= lines.length) {
    return null;
  }

  const content_lines = [];
  for (let index = content_start_index; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\[\d{4}-\d{2}-\d{2}T[^\]]+\]/u.test(line)) {
      break;
    }
    content_lines.push(line);
  }

  const trimmed_content = content_lines.join("\n").trim();
  return trimmed_content.length > 0 ? trimmed_content : null;
}

async function create_temp_output_last_message_path() {
  const temp_dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "command_base_codex_last_message_"),
  );
  return path.join(temp_dir, "last_message.txt");
}

async function safe_cleanup_output_last_message(output_last_message_path) {
  if (typeof output_last_message_path !== "string") {
    return;
  }
  try {
    const parent_dir = path.dirname(output_last_message_path);
    await fs.rm(parent_dir, { recursive: true, force: true });
  } catch (error) {
    // ignore cleanup errors
  }
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

  const flags_without_value = new Set([
    "--oss",
    "--full-auto",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "--json",
    "--help",
    "--version",
    "-h",
    "-V",
  ]);

  const flags_with_value = new Set([
    "-c",
    "--config",
    "-m",
    "--model",
    "-p",
    "--profile",
    "-s",
    "--sandbox",
    "-a",
    "--ask-for-approval",
    "-C",
    "--cd",
    "--color",
    "--output-last-message",
    "-i",
    "--image",
  ]);

  let first_positional_index = -1;
  let scan_index = 0;
  while (scan_index < search_limit) {
    const token = args_copy[scan_index];
    if (token === "--") {
      break;
    }
    if (!token.startsWith("-")) {
      first_positional_index = scan_index;
      break;
    }
    if (token.includes("=")) {
      scan_index += 1;
      continue;
    }
    if (flags_without_value.has(token)) {
      scan_index += 1;
      continue;
    }
    if (flags_with_value.has(token)) {
      scan_index += 2;
      continue;
    }
    const next_value = args_copy[scan_index + 1];
    if (typeof next_value === "string" && !next_value.startsWith("-")) {
      scan_index += 2;
      continue;
    }
    scan_index += 1;
  }

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
  let args_adjusted = false;

  const normalize_config_override = (override_value) => {
    if (typeof override_value !== "string" || override_value.length === 0) {
      return override_value;
    }

    const [raw_key, raw_value = ""] = override_value.split("=", 2);
    const key = (raw_key || "").trim();
    const normalized_key = key.toLowerCase();
    if (normalized_key !== "model_reasoning_effort") {
      return override_value;
    }
    const canonical_key = "model_reasoning_effort";

    const trimmed_value = raw_value.trim();
    const unwrapped_value =
      (trimmed_value.startsWith('"') && trimmed_value.endsWith('"')) ||
      (trimmed_value.startsWith("'") && trimmed_value.endsWith("'"))
        ? trimmed_value.slice(1, -1)
        : trimmed_value;

    const normalized_value = unwrapped_value.trim().toLowerCase();
    if (supported_effort_values.has(normalized_value)) {
      const canonical_value = normalized_value;
      const next_override = `${canonical_key}=` + canonical_value;
      if (next_override !== override_value) {
        args_adjusted = true;
      }
      return next_override;
    }

    args_adjusted = true;
    return `${canonical_key}=high`;
  };

  for (let index = 0; index < cli_args.length; index += 1) {
    const token = cli_args[index];

    if (token === "--no-stream") {
      args_adjusted = true;
      continue;
    }

    const normalized_flag =
      token === "--override" || token === "-o" ? "--config" : token;

    const has_inline_override =
      typeof token === "string" &&
      (token.startsWith("--override=") || token.startsWith("--config="));
    if (has_inline_override) {
      const override_prefix = token.startsWith("--override=")
        ? "--override="
        : "--config=";
      const sanitized_override = normalize_config_override(
        token.slice(override_prefix.length),
      );
      if (token.startsWith("--override=")) {
        args_adjusted = true;
      }
      if (
        typeof sanitized_override === "string" &&
        sanitized_override.length > 0
      ) {
        sanitized_args.push("--config", sanitized_override);
      } else {
        sanitized_args.push(token);
      }
      continue;
    }

    const is_override_flag =
      token === "--override" ||
      token === "-o" ||
      token === "--config" ||
      token === "-c";
    if (is_override_flag) {
      const next_value = cli_args[index + 1];
      const sanitized_override = normalize_config_override(next_value);

      const normalized_override_flag =
        token === "--override" || token === "-o" ? "--config" : token;
      if (normalized_override_flag !== token) {
        args_adjusted = true;
      }

      if (
        typeof sanitized_override === "string" &&
        sanitized_override.length > 0
      ) {
        sanitized_args.push(normalized_override_flag, sanitized_override);
        index += 1;
        continue;
      }

      // Preserve original tokens when override value is missing or non-string.
      sanitized_args.push(normalized_override_flag);
      if (next_value !== undefined) {
        sanitized_args.push(next_value);
        index += 1;
      }
      continue;
    }

    sanitized_args.push(normalized_flag);
  }

  if (args_adjusted && logger?.warn) {
    logger.warn(
      "Adjusted CODEX_CLI_ARGS for codex-cli (normalized model_reasoning_effort, removed legacy flags).",
    );
  }

  return sanitized_args;
}

module.exports = {
  create_codex_adapter,
};
