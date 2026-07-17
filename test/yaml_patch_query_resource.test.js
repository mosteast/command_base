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

async function create_sources(contents) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "yaml-query-resource-"),
  );
  temp_directories.push(directory);
  const file_paths = [];
  for (let index = 0; index < contents.length; index += 1) {
    const file_path = path.join(directory, `${index}.yaml`);
    await fs.writeFile(file_path, contents[index]);
    file_paths.push(file_path);
  }
  return file_paths;
}

function resource_query() {
  return {
    version: 2,
    where: {
      all: [
        { predicate: "addressable_type", equals: "scalar" },
        { predicate: "raw_regex", pattern: "^value-", flags: "" },
      ],
    },
    projection: { fields: ["source_path", "raw"], missing: "error" },
  };
}

describe("YAML query v2 worker resources", () => {
  it("loads multiple files and preserves stable query sorting", async () => {
    const file_paths = await create_sources([
      "key: value-z\n",
      "key: value-a\n",
    ]);

    const result = await run_isolated_yaml_action("query_v2", {
      file_paths: [...file_paths].reverse(),
      query: resource_query(),
      max_file_count: 2,
      max_aggregate_file_bytes: 1024,
    });

    expect(result.matches.map((match) => match.source_path)).toEqual(
      [...file_paths].sort(),
    );
  });

  it("keeps isolated raw regex execution under the worker wall timeout", async () => {
    const [file_path] = await create_sources(["key: value-one\n"]);

    await expect(
      run_isolated_yaml_action(
        "query_v2",
        { file_path, query: resource_query() },
        { timeout_ms: 1 },
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { action: "query_v2", timeout_ms: 1 },
    });
  });

  it("enforces file count and aggregate source byte limits", async () => {
    const file_paths = await create_sources([
      "key: value-one\n",
      "key: value-two\n",
    ]);

    await expect(
      run_isolated_yaml_action("query_v2", {
        file_paths,
        query: resource_query(),
        max_file_count: 1,
      }),
    ).rejects.toMatchObject({
      code: "CHANGE_LIMIT_EXCEEDED",
      details: { limit_name: "max_file_count" },
    });
    await expect(
      run_isolated_yaml_action("query_v2", {
        file_paths,
        query: resource_query(),
        max_aggregate_file_bytes: 20,
      }),
    ).rejects.toMatchObject({
      code: "CHANGE_LIMIT_EXCEEDED",
      details: { limit_name: "max_aggregate_file_bytes" },
    });

    await expect(
      run_isolated_yaml_action("query_v2", {
        file_path: file_paths[0],
        query: resource_query(),
        max_file_bytes: 1024,
        max_aggregate_file_bytes: 4,
        index_options: { max_node_count: 1 },
      }),
    ).rejects.toMatchObject({
      code: "CHANGE_LIMIT_EXCEEDED",
      details: { limit_name: "max_aggregate_file_bytes" },
    });
  });

  it.each([
    [{ file_paths: [] }, "empty path array"],
    [{ file_paths: [""] }, "empty path"],
    [{ file_paths: [false] }, "non-string path"],
    [{ file_path: null }, "null single path"],
    [{ file_paths: ["/tmp/source.yaml"], max_file_count: 0 }, "zero count"],
    [
      { file_paths: ["/tmp/source.yaml"], max_aggregate_file_bytes: "10" },
      "string byte limit",
    ],
  ])("rejects invalid query_v2 worker input: %s", async (overrides) => {
    await expect(
      run_isolated_yaml_action("query_v2", {
        ...overrides,
        query: resource_query(),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_ERROR" });
  });

  it.each(["ignored_top_level_field", "raw_regex_worker_capability"])(
    "rejects unknown query_v2 payload field: %s",
    async (field) => {
      const [file_path] = await create_sources(["key: value-one\n"]);

      await expect(
        run_isolated_yaml_action("query_v2", {
          file_path,
          query: resource_query(),
          [field]: true,
        }),
      ).rejects.toMatchObject({
        code: "REQUEST_ERROR",
        details: { field },
      });
    },
  );
});
