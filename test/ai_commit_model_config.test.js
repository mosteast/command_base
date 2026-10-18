import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  invoke_ai_attempt,
  load_ai_commit_attempts,
  parse_unavailable_model_error,
  select_replacement_model,
  shorten_provider_error,
  update_attempt_model,
} = require("../utility/ai_commit_model_config");
const {
  generate_ai_commit_message,
} = require("../utility/git_commit_message_ai");
const {
  generate_smart_commit_plan,
} = require("../utility/git_smart_commit_ai");

const expired_cursor_error = [
  "Cannot use this model: cursor-grok-4.7-high-fast.",
  "Available models: grok-4.6-high-fast, grok-4.7-high-fast, grok-4.8-low, claude-opus-4-8-high",
].join(" ");

function config_text(model) {
  return [
    "# Model ids drift.",
    "version: 1",
    "attempt:",
    "  - id: cursor-cli",
    "    label: cursor-cli",
    "    platform: cursor-cli",
    `    model: ${model}`,
    "  - id: codex-cli",
    "    label: codex-cli",
    "    platform: codex",
    "    model: gpt-5.6-sol",
    "    reasoning: low",
    "",
  ].join("\n");
}

describe("ai commit model config", () => {
  it("loads attempt order and non-empty model ids", () => {
    const attempts = load_ai_commit_attempts();
    expect(attempts.map((attempt) => attempt.id)).toEqual([
      "cursor-cli",
      "codex-cli",
      "claude-code",
    ]);
    expect(attempts[1].reasoning).toBe("low");
    expect(attempts[2].model).toBe("auto");
  });

  it("drops the available-model list from provider errors", () => {
    expect(shorten_provider_error(expired_cursor_error)).toBe(
      "Cannot use this model: cursor-grok-4.7-high-fast.",
    );
    expect(shorten_provider_error("cursor unavailable")).toBe(
      "cursor unavailable",
    );
  });

  it("parses the rejected model and the available list", () => {
    expect(parse_unavailable_model_error(expired_cursor_error)).toEqual({
      rejected_model: "cursor-grok-4.7-high-fast",
      available_models: [
        "grok-4.6-high-fast",
        "grok-4.7-high-fast",
        "grok-4.8-low",
        "claude-opus-4-8-high",
      ],
    });
    expect(parse_unavailable_model_error("cursor unavailable")).toBeNull();
  });

  it("prefers the same id without the cursor- prefix", () => {
    const available = [
      "grok-4.8-high-fast",
      "grok-4.7-high-fast",
      "grok-4.8-low",
    ];
    expect(
      select_replacement_model("cursor-grok-4.7-high-fast", available),
    ).toBe("grok-4.7-high-fast");
  });

  it("picks the newest same-shape model when the id is gone", () => {
    expect(
      select_replacement_model("grok-4.7-high-fast", [
        "grok-4.6-high-fast",
        "grok-4.8-high-fast",
        "grok-4.8-low",
        "grok-4.9-high",
        "claude-opus-4-8-high",
      ]),
    ).toBe("grok-4.8-high-fast");
  });

  it("does not switch a model line or family", () => {
    expect(
      select_replacement_model("gpt-5.6-sol", [
        "gpt-5.6-terra-high",
        "gpt-5.6-sol-high",
      ]),
    ).toBe("gpt-5.6-sol-high");
    expect(
      select_replacement_model("grok-4.7-high-fast", [
        "claude-opus-4-8-high",
        "gpt-5.6-sol-high",
      ]),
    ).toBeNull();
  });

  it("rewrites only the rejected model", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-model-"));
    const config_path = path.join(root, "models.yaml");
    await fs.writeFile(
      config_path,
      config_text("cursor-grok-4.7-high-fast"),
      "utf8",
    );

    update_attempt_model(config_path, "cursor-cli", "grok-4.7-high-fast");
    const updated = await fs.readFile(config_path, "utf8");
    expect(updated).toContain("# Model ids drift.");
    expect(updated).toContain("model: grok-4.7-high-fast");
    expect(updated).toContain("model: gpt-5.6-sol");
    expect(updated).toContain("reasoning: low");
    expect(load_ai_commit_attempts(config_path)[0].model).toBe(
      "grok-4.7-high-fast",
    );
  });

  it("retries with the replacement and stores it after success", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-model-"));
    const config_path = path.join(root, "models.yaml");
    await fs.writeFile(
      config_path,
      config_text("cursor-grok-4.7-high-fast"),
      "utf8",
    );
    const warn = vi.fn();
    const models = [];
    const invoke = vi.fn(async (attempt) => {
      models.push(attempt.model);
      if (attempt.model === "cursor-grok-4.7-high-fast") {
        throw new Error(expired_cursor_error);
      }
      return "Add archived notes";
    });

    const result = await invoke_ai_attempt(
      load_ai_commit_attempts(config_path)[0],
      invoke,
      { config_path, logger: { warn, debug: vi.fn() } },
    );

    expect(result.output).toBe("Add archived notes");
    expect(result.attempt.model).toBe("grok-4.7-high-fast");
    expect(models).toEqual(["cursor-grok-4.7-high-fast", "grok-4.7-high-fast"]);
    expect(load_ai_commit_attempts(config_path)[0].model).toBe(
      "grok-4.7-high-fast",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("grok-4.7-high-fast");
    expect(warn.mock.calls[0][0]).not.toContain("Available models:");
  });

  it("leaves the config unchanged when the replacement call fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-model-"));
    const config_path = path.join(root, "models.yaml");
    await fs.writeFile(
      config_path,
      config_text("cursor-grok-4.7-high-fast"),
      "utf8",
    );

    await expect(
      invoke_ai_attempt(
        load_ai_commit_attempts(config_path)[0],
        async () => {
          throw new Error(expired_cursor_error);
        },
        { config_path, logger: { warn: vi.fn(), debug: vi.fn() } },
      ),
    ).rejects.toThrow("Cannot use this model: cursor-grok-4.7-high-fast.");
    expect(load_ai_commit_attempts(config_path)[0].model).toBe(
      "cursor-grok-4.7-high-fast",
    );
  });

  it("refreshes the configured model while generating a commit message", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-model-"));
    const config_path = path.join(root, "models.yaml");
    await fs.writeFile(
      config_path,
      config_text("cursor-grok-4.7-high-fast"),
      "utf8",
    );
    const warn = vi.fn();
    const invoke_adapter = vi.fn(async (platform, request) => {
      if (request.model === "cursor-grok-4.7-high-fast") {
        throw new Error(expired_cursor_error);
      }
      expect(platform).toBe("cursor-cli");
      return "Add archived notes";
    });

    const result = await generate_ai_commit_message(
      { status: "M README.md", stat: "README.md | 1 +", diff: "+note" },
      {
        config_path,
        invoke_adapter,
        logger: { info: vi.fn(), warn, debug: vi.fn() },
      },
    );

    expect(result).toMatchObject({
      message: "Add archived notes",
      model: "grok-4.7-high-fast",
      platform: "cursor-cli",
    });
    expect(load_ai_commit_attempts(config_path)[0].model).toBe(
      "grok-4.7-high-fast",
    );
    expect(
      warn.mock.calls.some((call) => call[0].includes("Available models:")),
    ).toBe(false);
  });

  it("refreshes the configured model while planning a split", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-commit-model-"));
    const config_path = path.join(root, "models.yaml");
    await fs.writeFile(
      config_path,
      config_text("cursor-grok-4.7-high-fast"),
      "utf8",
    );
    const plan_json = JSON.stringify({
      groups: [{ message: "Add notes", files: ["README.md"] }],
    });
    const invoke_adapter = vi.fn(async (_platform, request) => {
      if (request.model === "cursor-grok-4.7-high-fast") {
        throw new Error(expired_cursor_error);
      }
      return plan_json;
    });

    const plan = await generate_smart_commit_plan(
      { status: "M README.md", stat: "README.md | 1 +", diff: "+note" },
      ["README.md"],
      {
        config_path,
        invoke_adapter,
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      },
    );

    expect(plan.model).toBe("grok-4.7-high-fast");
    expect(plan.groups).toEqual([
      { message: "Add notes", files: ["README.md"] },
    ]);
    expect(load_ai_commit_attempts(config_path)[0].model).toBe(
      "grok-4.7-high-fast",
    );
  });
});
