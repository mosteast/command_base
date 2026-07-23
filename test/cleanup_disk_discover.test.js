import { describe, expect, it } from "vitest";
import { discover_hotspots } from "../lib/cleanup_disk/discover.js";

describe("cleanup_disk discover", () => {
  it("suggests cache rules and skips existing paths", async () => {
    const result = await discover_hotspots({
      root: "/Users/demo",
      top: 10,
      min_size_bytes: 1024,
      existing_rules: [
        {
          id: "jetbrains_cache",
          path: "~/Library/Caches/JetBrains",
        },
      ],
      run_command: async (command, args) => {
        if (command === "gdu-go") {
          return [
            "  5.0G  /Users/demo/Library/Caches/JetBrains",
            "  2.0G  /Users/demo/Library/Caches/NewTool",
            "  1.0G  /Users/demo/Movies",
          ].join("\n");
        }
        if (command === "mdfind") {
          return [
            "/Users/demo/java_error_in_idea.hprof",
            "/Applications/Xcode.app",
          ].join("\n");
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
    });

    const ids = result.items.map((item) => item.suggested_id);
    expect(ids).toContain("cache_newtool");
    expect(ids).not.toContain("jetbrains_cache");
    expect(result.yaml_snippets.join("\n")).toMatch(/id: cache_newtool/);
    expect(result.items.some((item) => item.path.endsWith("Xcode.app"))).toBe(
      false,
    );
  });

  it("classifies hprof as artifact trash", async () => {
    const result = await discover_hotspots({
      root: "/Users/demo",
      top: 5,
      min_size_bytes: 1,
      existing_rules: [],
      run_command: async (command) => {
        if (command === "gdu-go") {
          return "";
        }
        if (command === "mdfind") {
          return "/Users/demo/java_error_in_idea.hprof\n";
        }
        return "";
      },
    });

    const hprof = result.items.find((item) =>
      item.path.endsWith("java_error_in_idea.hprof"),
    );
    expect(hprof).toBeTruthy();
    expect(hprof.kind).toBe("artifact");
    expect(hprof.action).toBe("trash");
  });
});
