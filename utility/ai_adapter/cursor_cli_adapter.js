"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function create_cursor_cli_adapter(support_context) {
  const support = support_context || {};

  return {
    platform: "cursor-cli",
    async invoke(request, runtime_context) {
      const context = create_execution_context(support, runtime_context);
      const cli_command = resolve_cursor_cli_command();
      const cli_args = context.parse_cli_arg_string(
        process.env.CURSOR_CLI_ARGS,
      );
      const model_flag =
        process.env.CURSOR_CLI_MODEL_FLAG === ""
          ? null
          : process.env.CURSOR_CLI_MODEL_FLAG || "--model";

      if (!(await context.command_exists(cli_command))) {
        throw new Error(
          `cursor CLI command '${cli_command}' is not installed or not on PATH.`,
        );
      }

      const command_args = [
        ...cli_args,
        "--print",
        "--output-format",
        "json",
        "--mode",
        "ask",
        "--trust",
      ];

      if (model_flag && request.model) {
        command_args.push(model_flag, request.model);
      }

      const stdout_payload = await context.run_cli_command(
        cli_command,
        command_args,
        context.combine_prompts(request.system_prompt, request.user_prompt),
        {
          logger: request.logger,
          system_prompt: request.system_prompt,
        },
      );

      return parse_cursor_cli_response(stdout_payload);
    },
  };
}

function resolve_cursor_cli_command() {
  const explicit_command =
    process.env.CURSOR_CLI_COMMAND || process.env.CURSOR_BIN || "";
  if (explicit_command.trim().length > 0) {
    return explicit_command.trim();
  }

  const local_agent_path = path.join(os.homedir(), ".local", "bin", "agent");
  if (fs.existsSync(local_agent_path)) {
    return local_agent_path;
  }

  return "agent";
}

function parse_cursor_cli_response(stdout_payload) {
  const trimmed_payload =
    typeof stdout_payload === "string" ? stdout_payload.trim() : "";
  if (trimmed_payload.length === 0) {
    throw new Error("cursor CLI returned an empty response");
  }

  let parsed_payload;
  try {
    parsed_payload = JSON.parse(trimmed_payload);
  } catch (error) {
    throw new Error(`cursor CLI returned invalid JSON: ${error.message}`);
  }

  if (typeof parsed_payload.result !== "string") {
    throw new Error("cursor CLI response did not include a string result");
  }

  const result = parsed_payload.result.trim();
  if (result.length === 0) {
    throw new Error("cursor CLI result was empty");
  }

  return result;
}

function create_execution_context(base_context, runtime_context) {
  if (!runtime_context) {
    return base_context;
  }
  return { ...base_context, ...runtime_context };
}

module.exports = {
  create_cursor_cli_adapter,
  parse_cursor_cli_response,
  resolve_cursor_cli_command,
};
