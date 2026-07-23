import { describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { load_config, merge_rule_list } from "../lib/cleanup_disk/config.js";
import { filter_rules } from "../lib/cleanup_disk/filter.js";

describe("cleanup_disk config", () => {
  it("merges local rules over defaults by id", () => {
    const merged = merge_rule_list(
      [{ id: "a", risk: "low", enabled: true }],
      [
        { id: "a", risk: "high", enabled: false },
        { id: "b", risk: "medium", enabled: true },
      ],
    );
    expect(merged).toEqual([
      { id: "a", risk: "high", enabled: false },
      { id: "b", risk: "medium", enabled: true },
    ]);
  });

  it("loads yaml files from disk", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-disk-cfg-"));
    const defaults_path = path.join(root, "defaults.yaml");
    await fs.writeFile(
      defaults_path,
      'version: 1\nrule:\n  - id: x\n    path: "~/x"\n    kind: cache\n    risk: low\n    action: trash\n    enabled: true\n',
      "utf8",
    );
    const cfg = await load_config({ defaults_path });
    expect(cfg.version).toBe(1);
    expect(cfg.rule[0].id).toBe("x");
  });
});

describe("cleanup_disk filter", () => {
  const rules = [
    { id: "a", kind: "cache", risk: "low", enabled: true },
    { id: "b", kind: "cache", risk: "medium", enabled: true },
    { id: "c", kind: "large_file", risk: "high", enabled: true },
    { id: "d", kind: "cache", risk: "low", enabled: false },
  ];

  it("applies risk ceiling", () => {
    expect(filter_rules(rules, { risk_ceiling: "low" }).map((r) => r.id)).toEqual([
      "a",
    ]);
    expect(
      filter_rules(rules, { risk_ceiling: "medium" }).map((r) => r.id),
    ).toEqual(["a", "b"]);
  });

  it("filters by kind and rule id", () => {
    expect(filter_rules(rules, { kind: "large_file" }).map((r) => r.id)).toEqual([
      "c",
    ]);
    expect(filter_rules(rules, { rule_ids: ["b"] }).map((r) => r.id)).toEqual([
      "b",
    ]);
  });
});
