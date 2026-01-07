import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const { create_codex_adapter } = require("../utility/ai_adapter/codex_adapter");

function extract_output_last_message_path(args) {
  const double_dash_index = args.indexOf("--");
  const search_limit =
    double_dash_index === -1 ? args.length : double_dash_index;
  for (let index = 0; index < search_limit; index += 1) {
    if (args[index] === "--output-last-message") {
      return args[index + 1] || null;
    }
    if (
      typeof args[index] === "string" &&
      args[index].startsWith("--output-last-message=")
    ) {
      return args[index].slice("--output-last-message=".length) || null;
    }
  }
  return null;
}

function create_support_context({ on_run_cli_command, logger }) {
  return {
    parse_cli_arg_string: (raw_value) =>
      raw_value ? raw_value.trim().split(/\s+/).filter(Boolean) : [],
    command_exists: async () => true,
    combine_prompts: (_system_prompt, user_prompt) => user_prompt,
    run_cli_command: async (command, args, prompt_text) => {
      on_run_cli_command({ command, args, prompt_text });
      const output_last_message_path = extract_output_last_message_path(args);
      if (output_last_message_path) {
        await mkdir(path.dirname(output_last_message_path), {
          recursive: true,
        });
        await writeFile(output_last_message_path, "ok\n", "utf8");
      }
      return "ok";
    },
    pick_number: () => undefined,
    ...logger,
  };
}

describe("codex adapter CLI arg normalization", () => {
  const original_env = { ...process.env };

  beforeEach(() => {
    process.env = { ...original_env };
  });

  afterEach(() => {
    process.env = { ...original_env };
  });

  it("rewrites legacy --override model_reasoning_effort=xhigh to --config ...=high", async () => {
    process.env.CODEX_CLI_ARGS =
      "--override model_reasoning_effort=xhigh --skip-git-repo-check";

    const on_run_cli_command = vi.fn();
    const logger = { warn: vi.fn() };
    const adapter = create_codex_adapter(
      create_support_context({ on_run_cli_command, logger }),
    );

    const result = await adapter.invoke({
      model: null,
      system_prompt: "",
      user_prompt: "hello",
      logger,
    });

    expect(result).toBe("ok");

    expect(on_run_cli_command).toHaveBeenCalledTimes(1);
    const { args } = on_run_cli_command.mock.calls[0][0];

    expect(args).not.toContain("--override");
    expect(args).toContain("--config");
    expect(args).toContain("model_reasoning_effort=high");
  });

  it("inserts exec after flags that take values", async () => {
    process.env.CODEX_CLI_ARGS = "-c model_reasoning_effort=xhigh";

    const on_run_cli_command = vi.fn();
    const logger = { warn: vi.fn() };
    const adapter = create_codex_adapter(
      create_support_context({ on_run_cli_command, logger }),
    );

    const result = await adapter.invoke({
      model: null,
      system_prompt: "",
      user_prompt: "hello",
      logger,
    });

    expect(result).toBe("ok");

    const { args } = on_run_cli_command.mock.calls[0][0];
    const exec_index = args.indexOf("exec");
    expect(exec_index).toBeGreaterThan(-1);
    expect(args.slice(0, exec_index)).toEqual([
      "-c",
      "model_reasoning_effort=high",
    ]);
  });
});
