import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  build_smart_commit_prompt,
  expand_group_paths,
  extract_json_object,
  generate_smart_commit_plan,
  parse_confirm_selection,
  parse_porcelain_status,
  parse_smart_commit_plan,
  resolve_commit_plan,
  resolve_single_commit_plan,
} = require("../utility/git_smart_commit_ai");

const change_context = {
  status: "M bin/g\nA README.md",
  stat: "bin/g | 10 ++++++++++",
  diff: "diff --git a/bin/g b/bin/g\n+--smart",
};

const valid_plan_json = JSON.stringify({
  groups: [
    { message: "Add smart commit support", files: ["bin/g"] },
    { message: "Document smart commit", files: ["README.md"] },
  ],
});

describe("git smart commit plan", () => {
  it("tries codex, then cursor, returning a validated multi-group plan", async () => {
    const calls = [];
    const invoke_adapter = vi.fn(async (platform, request) => {
      calls.push({ platform, request });
      if (platform === "codex") {
        throw new Error("codex unavailable");
      }
      if (platform === "cursor-cli") {
        return "```json\n" + valid_plan_json + "\n```";
      }
      throw new Error("should not reach claude");
    });

    const plan = await generate_smart_commit_plan(
      change_context,
      ["bin/g", "README.md"],
      {
        invoke_adapter,
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      },
    );

    expect(plan.groups).toEqual([
      { message: "Add smart commit support", files: ["bin/g"] },
      { message: "Document smart commit", files: ["README.md"] },
    ]);
    expect(plan.platform).toBe("cursor-cli");
    expect(calls.map((call) => call.platform)).toEqual(["codex", "cursor-cli"]);
    expect(calls[0].request.model).toBe("gpt-5.5");
    expect(calls[0].request.disable_fallback).toBe(true);
  });

  it("validates that every changed file is covered exactly once", () => {
    const plan = parse_smart_commit_plan(valid_plan_json, [
      "bin/g",
      "README.md",
    ]);
    expect(plan.groups).toHaveLength(2);
  });

  it("rejects a plan that references an unknown path", () => {
    const json = JSON.stringify({
      groups: [{ message: "Touch", files: ["does/not/exist"] }],
    });
    expect(() => parse_smart_commit_plan(json, ["bin/g"])).toThrow(
      /unknown path/u,
    );
  });

  it("rejects a plan that assigns a path to multiple groups", () => {
    const json = JSON.stringify({
      groups: [
        { message: "First", files: ["bin/g"] },
        { message: "Second", files: ["bin/g"] },
      ],
    });
    expect(() => parse_smart_commit_plan(json, ["bin/g"])).toThrow(
      /multiple groups/u,
    );
  });

  it("rejects a plan that does not cover every changed file", () => {
    const json = JSON.stringify({
      groups: [{ message: "Only one", files: ["bin/g"] }],
    });
    expect(() => parse_smart_commit_plan(json, ["bin/g", "README.md"])).toThrow(
      /does not cover/u,
    );
  });

  it("falls back to a single commit when the plan JSON is invalid", async () => {
    const invoke_adapter = vi.fn(async (_platform, request) => {
      if (request.user_prompt.includes("Group the changed files")) {
        return "this is not json at all";
      }
      return "Apply combined changes";
    });

    const plan = await resolve_commit_plan(
      change_context,
      ["bin/g", "README.md"],
      {
        invoke_adapter,
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      },
    );

    expect(plan.fallback).toBe(true);
    expect(plan.groups).toEqual([
      { message: "Apply combined changes", files: ["bin/g", "README.md"] },
    ]);
  });
});

describe("porcelain parsing", () => {
  it("parses statuses and expands renames to both paths", () => {
    const output =
      [" M bin/g", "R  new.txt", "old.txt", "?? a.js"].join("\0") + "\0";

    const { display_paths, expansion } = parse_porcelain_status(output);

    expect(display_paths).toEqual(["bin/g", "new.txt", "a.js"]);
    expect(expansion["new.txt"]).toEqual(["new.txt", "old.txt"]);
    expect(expand_group_paths(["new.txt"], expansion)).toEqual([
      "new.txt",
      "old.txt",
    ]);
  });
});

describe("confirm selection parsing", () => {
  it("accepts every commit on a bare 'y'", () => {
    const result = parse_confirm_selection("y", 3);
    expect(result.ok).toBe(true);
    expect(result.verb).toBe("y");
    expect(result.accepted).toEqual([1, 2, 3]);
    expect(result.rejected).toEqual([]);
  });

  it("accepts only the listed commits and rejects the rest with 'y 1 2'", () => {
    const result = parse_confirm_selection("y 1 2", 4);
    expect(result.accepted).toEqual([1, 2]);
    expect(result.rejected).toEqual([3, 4]);
  });

  it("expands ranges and lists with 'y 2-4 6 8'", () => {
    const result = parse_confirm_selection("y 2-4 6 8", 8);
    expect(result.accepted).toEqual([2, 3, 4, 6, 8]);
    expect(result.rejected).toEqual([1, 5, 7]);
  });

  it("rejects every commit on a bare 'n'", () => {
    const result = parse_confirm_selection("n", 3);
    expect(result.verb).toBe("n");
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([1, 2, 3]);
  });

  it("rejects only the listed commits and keeps the rest with 'n 2-4 6 8'", () => {
    const result = parse_confirm_selection("n 2-4 6 8", 8);
    expect(result.rejected).toEqual([2, 3, 4, 6, 8]);
    expect(result.accepted).toEqual([1, 5, 7]);
  });

  it("treats reversed ranges leniently", () => {
    const result = parse_confirm_selection("y 4-2", 5);
    expect(result.accepted).toEqual([2, 3, 4]);
    expect(result.rejected).toEqual([1, 5]);
  });

  it("defaults empty input to accept all", () => {
    const result = parse_confirm_selection("   ", 3);
    expect(result.ok).toBe(true);
    expect(result.verb).toBe("y");
    expect(result.accepted).toEqual([1, 2, 3]);
    expect(result.rejected).toEqual([]);
  });

  it("treats 'help', 'h' and '?' as a help request", () => {
    for (const token of ["help", "HELP", "h", "?"]) {
      const result = parse_confirm_selection(token, 3);
      expect(result.ok).toBe(true);
      expect(result.help).toBe(true);
      expect(result.accepted).toBeUndefined();
    }
  });

  it("rejects an unknown verb", () => {
    const result = parse_confirm_selection("x 1", 3);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown response/u);
  });

  it("rejects out-of-range selections", () => {
    const result = parse_confirm_selection("y 9", 3);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/out of range/u);
  });

  it("rejects malformed tokens", () => {
    const result = parse_confirm_selection("y 1-", 3);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid selection token/u);
  });
});

describe("single commit plan", () => {
  it("produces one group covering every changed file", async () => {
    const invoke_adapter = vi.fn(async () => "Apply the combined change");
    const plan = await resolve_single_commit_plan(
      change_context,
      ["bin/g", "README.md"],
      {
        invoke_adapter,
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      },
    );

    expect(plan.single).toBe(true);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toEqual({
      message: "Apply the combined change",
      files: ["bin/g", "README.md"],
    });
  });
});

describe("prompt and json helpers", () => {
  it("lists the changed files in the prompt", () => {
    const prompt = build_smart_commit_prompt(change_context, [
      "bin/g",
      "README.md",
    ]);
    expect(prompt).toContain("- bin/g");
    expect(prompt).toContain("- README.md");
    expect(prompt).toContain("## changed files");
  });

  it("requires the AI to compare the diff before grouping or writing messages", () => {
    const prompt = build_smart_commit_prompt(change_context, [
      "bin/g",
      "README.md",
    ]);

    expect(prompt).toContain(
      "First compare the actual git diff, then decide groups and write messages.",
    );
    expect(prompt.indexOf("First compare the actual git diff")).toBeLessThan(
      prompt.indexOf("## git diff"),
    );
  });

  it("extracts a JSON object from fenced output", () => {
    const fenced = "```json\n" + valid_plan_json + "\n```";
    expect(JSON.parse(extract_json_object(fenced))).toHaveProperty("groups");
  });
});
