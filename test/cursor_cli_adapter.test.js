import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  create_cursor_cli_adapter,
} = require("../utility/ai_adapter/cursor_cli_adapter");

function create_support_context(on_run_cli_command) {
  return {
    parse_cli_arg_string: (raw_value) =>
      raw_value ? raw_value.trim().split(/\s+/).filter(Boolean) : [],
    command_exists: async () => true,
    combine_prompts: (system_prompt, user_prompt) =>
      system_prompt ? `${system_prompt}\n\n${user_prompt}` : user_prompt,
    run_cli_command: async (command, args, prompt_text) => {
      on_run_cli_command({ command, args, prompt_text });
      return JSON.stringify({ result: "Add AI commit message support" });
    },
  };
}

describe("cursor cli adapter", () => {
  const original_env = { ...process.env };

  beforeEach(() => {
    process.env = { ...original_env };
  });

  afterEach(() => {
    process.env = { ...original_env };
  });

  it("invokes cursor CLI in ask/json mode and returns the result field", async () => {
    process.env.CURSOR_CLI_COMMAND = "cursor-agent";

    const on_run_cli_command = vi.fn();
    const adapter = create_cursor_cli_adapter(
      create_support_context(on_run_cli_command),
    );

    const result = await adapter.invoke({
      model: "composer-2.5-fast",
      system_prompt: "Write commit messages.",
      user_prompt: "Summarize this diff.",
      logger: { warn: vi.fn() },
    });

    expect(result).toBe("Add AI commit message support");
    expect(on_run_cli_command).toHaveBeenCalledTimes(1);
    expect(on_run_cli_command.mock.calls[0][0]).toEqual({
      command: "cursor-agent",
      args: [
        "--print",
        "--output-format",
        "json",
        "--mode",
        "ask",
        "--trust",
        "--model",
        "composer-2.5-fast",
      ],
      prompt_text: "Write commit messages.\n\nSummarize this diff.",
    });
  });
});
