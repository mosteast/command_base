import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import isolated_module from "../lib/yaml_patch/isolated";

const { run_isolated_yaml_action } = isolated_module;
const temp_directories = [];

afterEach(async () => {
  await Promise.all(
    temp_directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function create_source(text) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yaml-isolated-"));
  temp_directories.push(directory);
  const file_path = path.join(directory, "source.yaml");
  await fs.writeFile(file_path, text);
  return file_path;
}

describe("isolated YAML actions", () => {
  it("parses and indexes a file in a bounded worker", async () => {
    const file_path = await create_source("value: 中文😀\n");

    const result = await run_isolated_yaml_action("inspect", { file_path });

    expect(result).toMatchObject({
      path: file_path,
      parser_version: "2.8.0",
      document_count: 1,
      error_count: 0,
      node_count: 3,
    });
  });

  it("enforces node limits inside the worker", async () => {
    const file_path = await create_source("root:\n  child: value\n");

    await expect(
      run_isolated_yaml_action("inspect", {
        file_path,
        index_options: { max_node_count: 2 },
      }),
    ).rejects.toMatchObject({ code: "CHANGE_LIMIT_EXCEEDED" });
  });

  it("terminates a worker that exceeds its wall-clock budget", async () => {
    const file_path = await create_source("value: one\n");

    await expect(
      run_isolated_yaml_action("inspect", { file_path }, { timeout_ms: 1 }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("paginates broad find results and enforces serialized output limits", async () => {
    const file_path = await create_source("one: first\ntwo: second\n");

    const page = await run_isolated_yaml_action("find", {
      file_path,
      query: { version: 1, node_type: "scalar" },
      result_offset: 0,
      result_limit: 1,
      max_output_bytes: 64 * 1024,
    });

    expect(page.matches).toHaveLength(1);
    expect(page.total_match_count).toBeGreaterThan(1);
    expect(page.next_offset).toBe(1);
    await expect(
      run_isolated_yaml_action("find", {
        file_path,
        query: { version: 1 },
        result_offset: 0,
        result_limit: 10,
        max_output_bytes: 1,
      }),
    ).rejects.toMatchObject({ code: "CHANGE_LIMIT_EXCEEDED" });
  });
});
