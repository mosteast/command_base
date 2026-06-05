import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  build_smart_commit_prompt,
  expand_group_paths,
  extract_json_object,
  generate_smart_commit_plan,
  parse_porcelain_status,
  parse_smart_commit_plan,
  resolve_commit_plan,
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
    expect(() =>
      parse_smart_commit_plan(json, ["bin/g", "README.md"]),
    ).toThrow(/does not cover/u);
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
    const output = [" M bin/g", "R  new.txt", "old.txt", "?? a.js"].join(
      "\0",
    ) + "\0";

    const { display_paths, expansion } = parse_porcelain_status(output);

    expect(display_paths).toEqual(["bin/g", "new.txt", "a.js"]);
    expect(expansion["new.txt"]).toEqual(["new.txt", "old.txt"]);
    expect(expand_group_paths(["new.txt"], expansion)).toEqual([
      "new.txt",
      "old.txt",
    ]);
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

  it("extracts a JSON object from fenced output", () => {
    const fenced = "```json\n" + valid_plan_json + "\n```";
    expect(JSON.parse(extract_json_object(fenced))).toHaveProperty("groups");
  });
});
