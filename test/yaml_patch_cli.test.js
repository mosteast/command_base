import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import package_json from "../package.json";
import yaml_patch_cli from "../lib/yaml_patch/cli";

const { run_cli: run_cli_library } = yaml_patch_cli;

const cli_path = path.resolve(__dirname, "../bin/yaml_patch");
const temp_directories = [];

afterEach(async () => {
  await Promise.all(
    temp_directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function run_cli(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli_path, ...args],
      {
        env: { ...process.env, FORCE_COLOR: "0" },
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          exit_code: error ? error.code || 1 : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function create_workspace(files = { "source.yaml": "value: old\n" }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yaml_patch-cli-"));
  temp_directories.push(directory);
  await Promise.all(
    Object.entries(files).map(async ([relative_path, content]) => {
      const file_path = path.join(directory, relative_path);
      await fs.mkdir(path.dirname(file_path), { recursive: true });
      await fs.writeFile(file_path, content);
    }),
  );
  return directory;
}

async function write_json(file_path, value) {
  await fs.writeFile(file_path, `${JSON.stringify(value, null, 2)}\n`);
}

function create_memory_io() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    },
    read() {
      return { stdout, stderr };
    },
  };
}

describe("yaml_patch general CLI", () => {
  it("prints only the package version", async () => {
    const result = await run_cli(["--version"]);

    expect(result).toEqual({
      exit_code: 0,
      stdout: `${package_json.version}\n`,
      stderr: "",
    });
  });

  it("publishes the core library and yaml_patch executable", () => {
    expect(package_json.main).toBe("lib/yaml_patch/index.js");
    expect(package_json.bin).toEqual({ yaml_patch: "bin/yaml_patch" });
  });

  it("documents usage, commands, options, edit-unit values, and examples", async () => {
    const result = await run_cli(["--help"]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("Usage");
    expect(result.stdout).toContain("Description");
    expect(result.stdout).toContain("Options");
    expect(result.stdout).toContain("scalar-token");
    expect(result.stdout).toContain("node-value");
    expect(result.stdout).toContain("mapping-value");
    expect(result.stdout).toContain("lock-info");
    expect(result.stdout).toContain("break-stale-lock");
    expect(result.stdout).toContain("guard-info");
    expect(result.stdout).toContain("break-stale-guard");
    expect(result.stdout).toContain("extract-lock-info");
    expect(result.stdout).toContain("break-stale-extract-lock");
    expect(result.stdout).toContain("--max-result");
    expect(result.stdout).toContain("--max-output-byte");
    expect(result.stdout).toContain("--offset");
    expect(result.stdout).toContain("Examples");
    expect(result.stdout).toContain("# Inspect all YAML files");
    expect(result.stderr).toBe("");
  });

  it("inspects and explicitly breaks a proven stale cooperative lock", async () => {
    const directory = await create_workspace();
    const source_path = path.join(directory, "source.yaml");
    const lock_path = path.join(directory, ".source.yaml.yaml_patch.lock");
    const lock = {
      source_path,
      pid: 999999,
      hostname: os.hostname(),
      token: "cli-stale-token",
      created_at: "2020-01-01T00:00:00.000Z",
    };
    await fs.writeFile(lock_path, `${JSON.stringify(lock)}\n`, {
      flag: "wx",
      mode: 0o600,
    });

    const inspected = await run_cli(["lock-info", source_path, "--json"]);
    expect(inspected.exit_code).toBe(0);
    expect(JSON.parse(inspected.stdout).result.lock).toMatchObject(lock);

    const broken = await run_cli([
      "break-stale-lock",
      source_path,
      "--lock-token",
      lock.token,
      "--json",
    ]);
    expect(broken.exit_code).toBe(0);
    expect(JSON.parse(broken.stdout).result).toMatchObject({
      removed: true,
      lock,
    });
    await expect(fs.access(lock_path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers stale management and extract guards through explicit commands", async () => {
    const directory = await create_workspace();
    const source_path = path.join(directory, "source.yaml");
    const guard_path = path.join(
      directory,
      ".source.yaml.yaml_patch.lock.guard",
    );
    const guard = {
      source_path,
      pid: 999999,
      hostname: os.hostname(),
      token: "cli-stale-guard-token",
      created_at: "2020-01-01T00:00:00.000Z",
    };
    await fs.writeFile(guard_path, `${JSON.stringify(guard)}\n`, {
      flag: "wx",
      mode: 0o600,
    });

    const inspected_guard = await run_cli(["guard-info", source_path]);
    expect(inspected_guard.exit_code).toBe(0);
    expect(JSON.parse(inspected_guard.stdout).result.lock).toMatchObject(guard);
    const broken_guard = await run_cli([
      "break-stale-guard",
      source_path,
      "--lock-token",
      guard.token,
    ]);
    expect(broken_guard.exit_code).toBe(0);

    const session_path = path.join(directory, "missing session");
    const extract_lock_path = path.join(
      directory,
      ".missing session.yaml_patch-extract.lock",
    );
    const extract_lock = {
      output_directory: session_path,
      pid: 999999,
      hostname: os.hostname(),
      token: "cli-stale-extract-token",
      created_at: "2020-01-01T00:00:00.000Z",
    };
    await fs.writeFile(extract_lock_path, `${JSON.stringify(extract_lock)}\n`, {
      flag: "wx",
      mode: 0o600,
    });

    const inspected_extract = await run_cli([
      "extract-lock-info",
      session_path,
    ]);
    expect(inspected_extract.exit_code).toBe(0);
    expect(JSON.parse(inspected_extract.stdout).result.lock).toMatchObject(
      extract_lock,
    );
    const broken_extract = await run_cli([
      "break-stale-extract-lock",
      session_path,
      "--lock-token",
      extract_lock.token,
    ]);
    expect(broken_extract.exit_code).toBe(0);
    await expect(fs.access(extract_lock_path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("returns a stable JSON error for unknown options", async () => {
    const result = await run_cli(["capabilities", "--unknown"]);
    const response = JSON.parse(result.stdout);

    expect(result.exit_code).toBe(2);
    expect(response).toMatchObject({
      ok: false,
      protocol_version: 1,
      code: "REQUEST_ERROR",
      recoverable: false,
    });
    expect(response.message).toContain("unknown");
  });

  it.each(["--version", "--help"])(
    "validates unknown options before handling %s",
    async (option) => {
      const result = await run_cli([option, "--unknown"]);
      const response = JSON.parse(result.stdout);

      expect(result.exit_code).toBe(2);
      expect(response).toMatchObject({
        ok: false,
        protocol_version: 1,
        code: "REQUEST_ERROR",
      });
      expect(response.message).toContain("unknown");
      expect(result.stderr).toBe("");
    },
  );

  it("classifies incomplete and unreadable request inputs as exit 2", async () => {
    const directory = await create_workspace();
    const source_path = path.join(directory, "source.yaml");
    const query_path = path.join(directory, "query.json");
    const invalid_query_path = path.join(directory, "invalid-query.json");
    await write_json(query_path, { version: 1 });
    await fs.writeFile(invalid_query_path, "{not-json\n");

    const request_args = [
      ["inspect"],
      ["find", source_path],
      ["find", "--query", query_path],
      ["find", source_path, "--query", invalid_query_path],
      [
        "find",
        source_path,
        "--query",
        path.join(directory, "missing-query.json"),
      ],
      ["extract", source_path, "--query", query_path],
      ["patch", source_path],
    ];

    for (const args of request_args) {
      const result = await run_cli(args);
      expect(result.exit_code, args.join(" ")).toBe(2);
      expect(JSON.parse(result.stdout), args.join(" ")).toMatchObject({
        ok: false,
        code: "REQUEST_ERROR",
      });
    }
  });

  it("classifies valid JSON request schema errors without masking YAML validation", async () => {
    const directory = await create_workspace();
    const source_path = path.join(directory, "source.yaml");
    const requests = [
      {
        name: "query version",
        option: "--query",
        command: "find",
        document: { version: 99 },
        code: "PROTOCOL_VERSION_UNSUPPORTED",
      },
      {
        name: "query field",
        option: "--query",
        command: "find",
        document: { version: 1, unexpected: true },
        code: "REQUEST_ERROR",
      },
      {
        name: "query structure",
        option: "--query",
        command: "find",
        document: {
          version: 1,
          path: [{ mapping_key: "value", sequence_index: 0 }],
        },
        code: "REQUEST_ERROR",
      },
      {
        name: "operation version",
        option: "--operations",
        command: "patch",
        document: { version: 99, operations: [] },
        code: "PROTOCOL_VERSION_UNSUPPORTED",
      },
      {
        name: "operation field",
        option: "--operations",
        command: "patch",
        document: { version: 1, operations: [], unexpected: true },
        code: "REQUEST_ERROR",
      },
    ];

    for (const request of requests) {
      const request_path = path.join(directory, `${request.name}.json`);
      await write_json(request_path, request.document);
      const result = await run_cli([
        request.command,
        source_path,
        request.option,
        request_path,
      ]);

      expect(result.exit_code, request.name).toBe(2);
      expect(JSON.parse(result.stdout), request.name).toMatchObject({
        ok: false,
        code: request.code,
      });
    }
  });

  it("normalizes thrown values once for both the envelope and exit code", async () => {
    const thrown_values = [
      Object.assign(new Error("plain failure"), { code: "NO_MATCH" }),
      { ok: true, code: "NO_MATCH", message: "not an Error" },
    ];

    for (const thrown_value of thrown_values) {
      const args = new Proxy([], {
        get() {
          throw thrown_value;
        },
      });
      const memory = create_memory_io();

      const exit_code = await run_cli_library(args, memory.io);
      const output = memory.read();

      expect(exit_code).toBe(70);
      expect(JSON.parse(output.stdout)).toMatchObject({
        ok: false,
        code: "INTERNAL_ERROR",
      });
      expect(output.stderr).toBe("");
    }
  });

  it("reports deterministic platform capabilities as JSON", async () => {
    const result = await run_cli(["capabilities", "--json", "--quiet"]);
    const response = JSON.parse(result.stdout);

    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(response).toMatchObject({
      ok: true,
      protocol_version: 1,
      result: {
        protocol_version: 1,
        parser_version: "2.8.0",
        edit_units: ["scalar-token", "node-value", "mapping-value"],
      },
    });
  });
});

describe("yaml_patch inspect and find", () => {
  it("expands glob patterns and inspects YAML streams in stable path order", async () => {
    const directory = await create_workspace({
      "b.yaml": "enabled: false\n",
      "a file.yaml": "---\nvalue: one\n---\nvalue: two\n",
    });
    const result = await run_cli([
      "inspect",
      path.join(directory, "*.yaml"),
      "--json",
    ]);
    const response = JSON.parse(result.stdout);

    expect(result.exit_code).toBe(0);
    expect(response.result.items).toHaveLength(2);
    expect(
      response.result.items.map((item) => path.basename(item.path)),
    ).toEqual(["a file.yaml", "b.yaml"]);
    expect(response.result.items[0]).toMatchObject({
      document_count: 2,
      error_count: 0,
      parser_version: "2.8.0",
    });
  });

  it("treats an existing path with glob metacharacters as a literal file", async () => {
    const directory = await create_workspace({
      "literal [one].yaml": "value: exact\n",
    });
    const file_path = path.join(directory, "literal [one].yaml");

    const result = await run_cli(["inspect", file_path, "--json"]);

    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout).result.items[0].path).toBe(file_path);
  });

  it("finds one exact structural target without exposing its raw scalar", async () => {
    const directory = await create_workspace({
      "source.yaml": "service:\n  timeout: 30\n",
    });
    const query_path = path.join(directory, "query.json");
    await write_json(query_path, {
      version: 1,
      document: 0,
      path: [{ mapping_key: "service" }, { mapping_key: "timeout" }],
      node_type: "scalar",
      raw_equals: "30",
    });

    const result = await run_cli([
      "find",
      path.join(directory, "source.yaml"),
      "--query",
      query_path,
      "--json",
    ]);
    const response = JSON.parse(result.stdout);

    expect(result.exit_code).toBe(0);
    expect(response.result.matches).toHaveLength(1);
    expect(response.result.matches[0]).toMatchObject({
      node_type: "scalar",
      document: 0,
      size_bytes: 2,
    });
    expect(response.result.matches[0].locator).toBeTruthy();
    expect(response.result.matches[0].raw).toBeUndefined();
  });

  it("keeps a valid query with no results in the query-conflict category", async () => {
    const directory = await create_workspace();
    const source_path = path.join(directory, "source.yaml");
    const query_path = path.join(directory, "query.json");
    await write_json(query_path, {
      version: 1,
      path: [{ mapping_key: "missing" }],
    });

    const result = await run_cli(["find", source_path, "--query", query_path]);

    expect(result.exit_code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: "NO_MATCH",
    });
  });

  it("paginates broad find queries with an explicit result limit", async () => {
    const directory = await create_workspace({
      "source.yaml": "one: first\ntwo: second\n",
    });
    const query_path = path.join(directory, "query.json");
    await write_json(query_path, { version: 1, node_type: "scalar" });

    const first = await run_cli([
      "find",
      path.join(directory, "source.yaml"),
      "--query",
      query_path,
      "--max-result",
      "1",
      "--json",
    ]);
    const first_result = JSON.parse(first.stdout).result;
    expect(first.exit_code).toBe(0);
    expect(first_result.matches).toHaveLength(1);
    expect(first_result.total_match_count).toBeGreaterThan(1);
    expect(first_result.next_offset).toBe(1);

    const second = await run_cli([
      "find",
      path.join(directory, "source.yaml"),
      "--query",
      query_path,
      "--max-result",
      "1",
      "--offset",
      String(first_result.next_offset),
    ]);
    expect(second.exit_code).toBe(0);
    expect(JSON.parse(second.stdout).result.matches).toHaveLength(1);
  });

  it("enforces the serialized find budget while aggregating files", async () => {
    const directory = await create_workspace({
      "a.yaml": "value: first\n",
      "b.yaml": "value: second\n",
    });
    const query_path = path.join(directory, "query.json");
    await write_json(query_path, {
      version: 1,
      path: [{ mapping_key: "value" }],
    });
    const one_file = await run_cli([
      "find",
      path.join(directory, "a.yaml"),
      "--query",
      query_path,
    ]);
    const all_files = await run_cli([
      "find",
      path.join(directory, "*.yaml"),
      "--query",
      query_path,
    ]);
    const one_result_bytes = Buffer.byteLength(
      JSON.stringify(JSON.parse(one_file.stdout).result),
      "utf8",
    );
    const all_result_bytes = Buffer.byteLength(
      JSON.stringify(JSON.parse(all_files.stdout).result),
      "utf8",
    );
    const aggregate_limit = Math.floor(
      (one_result_bytes + all_result_bytes) / 2,
    );

    const limited = await run_cli([
      "find",
      path.join(directory, "*.yaml"),
      "--query",
      query_path,
      "--max-output-byte",
      String(aggregate_limit),
    ]);

    expect(limited.exit_code).toBe(6);
    expect(JSON.parse(limited.stdout)).toMatchObject({
      ok: false,
      code: "CHANGE_LIMIT_EXCEEDED",
    });
  });

  it("accepts an exact-fit page while collecting later file counts", async () => {
    const directory = await create_workspace({
      "a.yaml": "value: first\n",
      "b.yaml": "value: second\n",
    });
    const query_path = path.join(directory, "query.json");
    await write_json(query_path, {
      version: 1,
      path: [{ mapping_key: "value" }],
    });
    const args = [
      "find",
      path.join(directory, "*.yaml"),
      "--query",
      query_path,
      "--max-result",
      "1",
    ];
    const baseline = await run_cli(args);
    const baseline_result = JSON.parse(baseline.stdout).result;
    const exact_result_bytes = Buffer.byteLength(
      JSON.stringify(baseline_result),
      "utf8",
    );

    const exact_fit = await run_cli([
      ...args,
      "--max-output-byte",
      String(exact_result_bytes),
    ]);

    expect(exact_fit.exit_code).toBe(0);
    expect(JSON.parse(exact_fit.stdout).result).toEqual(baseline_result);
  });
});

describe("yaml_patch extract and apply", () => {
  it("extracts with refresh protection, dry-runs by default, then writes explicitly", async () => {
    const directory = await create_workspace({
      "source.yaml": "before: same\nvalue: old # tail\nafter: same\n",
    });
    const source_path = path.join(directory, "source.yaml");
    const query_path = path.join(directory, "query.json");
    const session_path = path.join(directory, "session with space");
    await write_json(query_path, {
      version: 1,
      path: [{ mapping_key: "value" }],
    });

    const extracted = await run_cli([
      "extract",
      source_path,
      "--query",
      query_path,
      "--edit-unit",
      "scalar-token",
      "--output",
      session_path,
      "--json",
    ]);
    expect(extracted.exit_code).toBe(0);
    expect(
      await fs.readFile(path.join(session_path, "fragment.yaml"), "utf8"),
    ).toBe("old");

    const duplicate = await run_cli([
      "extract",
      source_path,
      "--query",
      query_path,
      "--edit-unit",
      "scalar-token",
      "--output",
      session_path,
    ]);
    expect(JSON.parse(duplicate.stdout).code).toBe("OUTPUT_EXISTS");

    const refreshed = await run_cli([
      "extract",
      source_path,
      "--query",
      query_path,
      "--edit-unit",
      "scalar-token",
      "--output",
      session_path,
      "--refresh",
    ]);
    expect(refreshed.exit_code).toBe(0);

    await fs.writeFile(path.join(session_path, "fragment.yaml"), "'new value'");
    const dry_run = await run_cli(["apply", session_path, "--json"]);
    expect(dry_run.exit_code).toBe(0);
    expect(JSON.parse(dry_run.stdout).result).toMatchObject({
      written: false,
      dry_run: true,
      proof: { verified: true },
    });
    expect(await fs.readFile(source_path, "utf8")).toContain("value: old");

    const written = await run_cli([
      "apply",
      session_path,
      "--write",
      "--debug",
      "--json",
    ]);
    expect(written.exit_code).toBe(0);
    expect(JSON.parse(written.stdout).result.written).toBe(true);
    expect(written.stderr).toContain("[DEBUG]");
    expect(written.stderr).toContain("stage:");
    expect(written.stderr).toContain("io: acquire cooperative lock");
    expect(written.stderr).toContain(
      "io: create same-directory temporary file",
    );
    expect(written.stderr).toContain("io: atomically rename temporary file");
    expect(await fs.readFile(source_path, "utf8")).toContain(
      "value: 'new value' # tail",
    );
  });
});

describe("yaml_patch patch and validate", () => {
  it("dry-runs and writes one declarative mapping-value operation", async () => {
    const directory = await create_workspace({
      "source.yaml": "service:\n  timeout: 30\n  enabled: true\n",
    });
    const source_path = path.join(directory, "source.yaml");
    const root_query_path = path.join(directory, "root-query.json");
    await write_json(root_query_path, {
      version: 1,
      document: 0,
      path: [{ mapping_key: "service" }],
      node_type: "mapping",
    });
    const found = await run_cli([
      "find",
      source_path,
      "--query",
      root_query_path,
    ]);
    const root = JSON.parse(found.stdout).result.matches[0];
    const operation_path = path.join(directory, "operation.json");
    await write_json(operation_path, {
      version: 1,
      operations: [
        {
          target: {
            locator: root.locator,
            expected_digest: root.raw_digest,
          },
          operation: { type: "set_mapping_value", key: "timeout", value: 45 },
        },
      ],
    });

    const dry_run = await run_cli([
      "patch",
      source_path,
      "--operations",
      operation_path,
    ]);
    expect(dry_run.exit_code).toBe(0);
    expect(JSON.parse(dry_run.stdout).result.written).toBe(false);
    expect(await fs.readFile(source_path, "utf8")).toContain("timeout: 30");

    const written = await run_cli([
      "patch",
      source_path,
      "--operations",
      operation_path,
      "--write",
    ]);
    expect(written.exit_code).toBe(0);
    expect(await fs.readFile(source_path, "utf8")).toContain("timeout: 45");
  });

  it("returns a stable validation failure for invalid YAML", async () => {
    const directory = await create_workspace({
      "invalid.yaml": "items: [one,\n",
    });
    const result = await run_cli([
      "validate",
      path.join(directory, "invalid.yaml"),
      "--json",
    ]);
    const response = JSON.parse(result.stdout);

    expect(result.exit_code).toBe(4);
    expect(response).toMatchObject({
      ok: false,
      code: "VALIDATION_FAILED",
      recoverable: false,
    });
  });
});
