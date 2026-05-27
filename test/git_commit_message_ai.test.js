import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  default_ai_commit_attempts,
  generate_ai_commit_message,
  normalize_commit_message,
} = require("../utility/git_commit_message_ai");

describe("git commit message ai helper", () => {
  it("tries codex, cursor, then claude with the configured fast models", async () => {
    const calls = [];
    const invoke_adapter = vi.fn(async (platform, request) => {
      calls.push({ platform, request });
      if (platform === "codex") {
        throw new Error("codex unavailable");
      }
      if (platform === "cursor-cli") {
        return "```markdown\nAdd AI commit message support\n```";
      }
      throw new Error("should not reach claude");
    });

    const result = await generate_ai_commit_message(
      {
        status: "M bin/g\nM bin/ggg",
        stat: "bin/g | 10 ++++++++++",
        diff: "diff --git a/bin/g b/bin/g\n+--ai",
      },
      {
        invoke_adapter,
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      },
    );

    expect(result).toEqual({
      message: "Add AI commit message support",
      platform: "cursor-cli",
      model: "composer-2.5-fast",
      label: "cursor-cli",
    });
    expect(calls.map((call) => call.platform)).toEqual(["codex", "cursor-cli"]);
    expect(calls[0].request.model).toBe("gpt-5.5");
    expect(calls[0].request.reasoning).toBe("low");
    expect(calls[0].request.disable_fallback).toBe(true);
    expect(calls[1].request.model).toBe("composer-2.5-fast");
    expect(calls[1].request.disable_fallback).toBe(true);
  });

  it("normalizes fenced, quoted, and prefixed commit message output", () => {
    expect(
      normalize_commit_message(
        '```text\ngit commit -m "Improve AI fallback"\n```',
      ),
    ).toBe("Improve AI fallback");
  });

  it("keeps the requested default fallback order explicit", () => {
    expect(default_ai_commit_attempts).toEqual([
      {
        label: "codex-cli",
        platform: "codex",
        model: "gpt-5.5",
        reasoning: "low",
      },
      {
        label: "cursor-cli",
        platform: "cursor-cli",
        model: "composer-2.5-fast",
      },
      {
        label: "claude-code",
        platform: "claude-code",
        model: "auto",
      },
    ]);
  });
});
