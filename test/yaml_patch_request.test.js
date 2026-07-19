import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import request_module from "../lib/yaml_patch/request";
import capability_module from "../lib/yaml_patch/capability";
import source_module from "../lib/yaml_patch/source";
import cli_module from "../lib/yaml_patch/cli";

const { execute_request, read_request_input } = request_module;
const { list_capabilities } = capability_module;
const { sha256_digest } = source_module;
const { run_cli } = cli_module;

const temp_directories = [];

afterEach(async () => {
  await Promise.all(
    temp_directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function create_workspace(files) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "yaml-patch-request-"),
  );
  temp_directories.push(directory);
  for (const [name, text] of Object.entries(files)) {
    await fs.writeFile(path.join(directory, name), text);
  }
  return directory;
}

describe("yaml patch request dispatcher", () => {
  it("lists capabilities including artifact versions and recovery", () => {
    const capabilities = list_capabilities();
    expect(capabilities).toMatchObject({
      protocol_version: 1,
      capability_protocol_version: 2,
      artifact_versions: expect.objectContaining({
        query: [1, 2],
        transaction: [1],
        journal: [1],
      }),
      writer: expect.objectContaining({
        simultaneous_multi_file_visibility: false,
        recovery: expect.anything(),
      }),
    });
  });

  it("rejects a second stdin JSON consumer", async () => {
    await expect(
      read_request_input("-", {
        stdin: (async function* () {
          yield Buffer.from("{}");
        })(),
        stdin_consumed: true,
      }),
    ).rejects.toMatchObject({ code: "REQUEST_ERROR" });
  });

  it("executes a query v2 request through the shared library path", async () => {
    const directory = await create_workspace({
      "config.yaml": "enabled: true\n",
    });
    const file_path = path.join(directory, "config.yaml");
    const buffer = await fs.readFile(file_path);
    const response = await execute_request(
      {
        kind: "query",
        version: 2,
        files: [
          {
            id: "main",
            path: file_path,
            digest: sha256_digest(buffer),
          },
        ],
        where: { predicate: "node_type", equals: "mapping" },
        select: { kind: "self" },
        projection: { fields: ["path"], missing: "error" },
        expect_matches: { min: 1, max: 10 },
      },
      { sources: { main: buffer } },
    );
    expect(response.ok).toBe(true);
    expect(response.result.kind).toBe("query");
    expect(response.result.matches.length).toBeGreaterThan(0);
  });

  it("plans a dry-run transaction through library and CLI equally", async () => {
    const directory = await create_workspace({
      "config.yaml": "value: old\n",
    });
    const file_path = path.join(directory, "config.yaml");
    const buffer = await fs.readFile(file_path);
    const operations_path = path.join(directory, "tx.json");
    const request = {
      version: 1,
      files: [
        {
          id: "main",
          path: file_path,
          digest: sha256_digest(buffer),
          document_count: 1,
        },
      ],
      operations: [
        {
          id: "change",
          type: "replace_scalar_raw",
          file: "main",
          target: {
            selector: { version: 1, path: [{ mapping_key: "value" }] },
          },
          raw: "new",
        },
      ],
    };
    await fs.writeFile(operations_path, `${JSON.stringify(request)}\n`);

    const library = await execute_request(
      { kind: "transaction", ...request },
      {
        sources: { main: buffer },
        capability_digest: "c".repeat(64),
        tool_version: "1.0.1",
      },
    );
    expect(library.ok).toBe(true);
    expect(library.result.no_op).toBe(false);
    expect(library.result.written).toBeUndefined();

    const memory = {
      stdout: {
        chunks: [],
        write(value) {
          this.chunks.push(value);
        },
      },
      stderr: {
        chunks: [],
        write(value) {
          this.chunks.push(value);
        },
      },
      stdin: process.stdin,
    };
    const exit_code = await run_cli(
      ["transaction", "--operations", operations_path, "--json"],
      memory,
    );
    expect(exit_code).toBe(0);
    const cli_response = JSON.parse(memory.stdout.chunks.join(""));
    expect(cli_response.ok).toBe(true);
    expect(cli_response.result.no_op).toBe(library.result.no_op);
    expect(cli_response.result.operation_order).toEqual(
      library.result.operation_order,
    );
    expect(await fs.readFile(file_path, "utf8")).toBe("value: old\n");
  });
});
