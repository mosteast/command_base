"use strict";

function create_codex_adapter(support_context) {
  const support = support_context || {};

  return {
    platform: "codex",
    async invoke(request, runtime_context) {
      const context = create_execution_context(support, runtime_context);
      const cli_command = process.env.CODEX_CLI_COMMAND || "codex";
      const cli_args = context.parse_cli_arg_string(process.env.CODEX_CLI_ARGS);
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

module.exports = {
  create_codex_adapter,
};
