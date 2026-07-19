import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { main as generate_fixtures, ROOT } from "../benchmark/yaml_patch/generate_fixture";
import source_module from "../lib/yaml_patch/source";
import parser_module from "../lib/yaml_patch/parser";
import node_index_module from "../lib/yaml_patch/node_index";

const { create_source_record } = source_module;
const { parse_yaml_source } = parser_module;
const { build_node_index } = node_index_module;

async function ensure_fixtures() {
  if (!fs.existsSync(path.join(ROOT, "baseline/01_plain.yaml"))) {
    await generate_fixtures();
  }
}

function parse_fixture(relative_path) {
  const file_path = path.join(ROOT, relative_path);
  const buffer = fs.readFileSync(file_path);
  const source = create_source_record(buffer, { file_path });
  const parsed = parse_yaml_source(source);
  return build_node_index(source, parsed);
}

describe("YAML patch corpus fixtures", () => {
  it("parses the 14 baseline shape fixtures", async () => {
    await ensure_fixtures();
    const baselines = fs
      .readdirSync(path.join(ROOT, "baseline"))
      .filter((name) => name.endsWith(".yaml"))
      .sort();
    expect(baselines).toHaveLength(14);
    for (const name of baselines) {
      const index = parse_fixture(path.join("baseline", name));
      expect(index.entries.length).toBeGreaterThan(0);
    }
  });

  it("covers unicode, BOM, newline variants, tags, anchors, and comments", async () => {
    await ensure_fixtures();
    const unicode = parse_fixture("baseline/09_unicode.yaml");
    expect(
      unicode.entries.some((entry) => String(entry.raw || "").includes("中文")),
    ).toBe(true);
    const bom = fs.readFileSync(path.join(ROOT, "baseline/10_bom.yaml"));
    expect(bom[0]).toBe(0xef);
    const crlf = fs.readFileSync(path.join(ROOT, "baseline/11_crlf.yaml"));
    expect(crlf.includes(Buffer.from("\r\n"))).toBe(true);
    const anchors = parse_fixture("baseline/07_anchors.yaml");
    expect(anchors.entries.some((entry) => entry.anchor || entry.alias)).toBe(
      true,
    );
  });

  it("keeps literal path fixtures with spaces, brackets, wildcards, and non-ASCII names", async () => {
    await ensure_fixtures();
    for (const name of [
      "with space.yaml",
      "with[brackets].yaml",
      "with*star.yaml",
      "unicodé.yaml",
    ]) {
      const file_path = path.join(ROOT, "path", name);
      expect(fs.existsSync(file_path)).toBe(true);
      const index = parse_fixture(path.join("path", name));
      expect(index.entries.length).toBeGreaterThan(0);
    }
  });

  it("materializes the required scale corpora", async () => {
    await ensure_fixtures();
    const nodes_64k = fs.statSync(path.join(ROOT, "scale/nodes_64k.yaml"));
    const large = fs.statSync(path.join(ROOT, "scale/large_2mib.yaml"));
    const growth = fs.statSync(path.join(ROOT, "scale/growth_10x.yaml"));
    expect(nodes_64k.size).toBeGreaterThan(500_000);
    expect(large.size).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    expect(growth.size).toBeGreaterThanOrEqual(large.size * 10);
  });
});
