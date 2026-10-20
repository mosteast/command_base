import { describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  discover_hotspots,
  classify_path,
  enrich_mdfind_sizes,
} from "../lib/cleanup_disk/discover.js";

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

  it("only treats real cache containers as low-risk", () => {
    expect(classify_path("/Users/demo/Library/Caches/NewTool").action).toBe(
      "trash",
    );
    expect(classify_path("/Users/demo/.cache/hyperframes").action).toBe("trash");
    expect(classify_path("/Users/demo/Documents/cache").action).toBe("report");
    expect(classify_path("/Users/demo/project/cache").action).toBe("report");
  });

  it("replaces the mdfind threshold with the real file size", async () => {
    const items = [
      { path: "/data/big.bin", size_bytes: 1024 },
      { path: "/data/missing.bin", size_bytes: 1024 },
    ];

    await enrich_mdfind_sizes(items, {
      min_size_bytes: 1024,
      read_file_bytes: async (target_path) => {
        if (target_path === "/data/big.bin") return 4096;
        throw new Error("ENOENT");
      },
    });

    expect(items[0].size_bytes).toBe(4096);
    expect(items[1].size_bytes).toBe(1024);
  });

  it("scans Application Support and Containers for hotspots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-disk-disc-"));
    const app_support = path.join(root, "Library", "Application Support");
    await fs.mkdir(app_support, { recursive: true });

    const scanned = [];
    try {
      const result = await discover_hotspots({
        root,
        home: root,
        top: 5,
        min_size_bytes: 1024,
        run_command: async (command, args) => {
          if (command === "gdu-go") {
            scanned.push(args[args.length - 1]);
            return `  5.0G  ${path.join(args[args.length - 1], "HotApp")}`;
          }
          return "";
        },
        read_file_bytes: async () => null,
      });

      expect(scanned.some((entry) => entry.includes("Application Support"))).toBe(
        true,
      );
      expect(result.items.some((item) => item.path.endsWith("HotApp"))).toBe(
        true,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
