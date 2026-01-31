import { execFile } from "node:child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it, expect } from "vitest";

import leaf_extract_module from "../tree/leaf_extract";

const { extract_leaf_levels } = leaf_extract_module;
const json_cli_entry = path.resolve(__dirname, "../bin/json_tree_leaf_extract");

const input_tree = [
  {
    value: "1",
    children: [
      {
        value: "1.1",
        children: [{ value: "1.1.1" }, { value: "1.1.2" }],
      },
      {
        value: "1.2",
        children: [{ value: "1.2.1" }, { value: "1.2.2" }],
      },
    ],
  },
  {
    value: "2",
    children: [{ value: "2.1" }, { value: "2.2" }],
  },
];

function run_cli(args, { stdin_text = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [json_cli_entry, ...args],
      {
        env: { ...process.env, FORCE_COLOR: "0" },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && error.code !== 0) {
          const exec_error = new Error(stderr || error.message);
          exec_error.stdout = stdout;
          exec_error.stderr = stderr;
          exec_error.exitCode = error.code || 1;
          reject(exec_error);
          return;
        }

        resolve({
          stdout,
          stderr,
          exit_code: error ? error.code || 0 : 0,
        });
      },
    );

    if (stdin_text) {
      child.stdin.end(stdin_text);
    } else {
      child.stdin.end();
    }
  });
}

async function create_temp_dir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "tree-leaf-extract-test-"));
}

describe("tree leaf extraction", () => {
  it("extracts level 1 leaves", () => {
    const { output_data } = extract_leaf_levels(input_tree, { level: 1 });

    expect(output_data).toEqual([
      { value: "1.1.1" },
      { value: "1.1.2" },
      { value: "1.2.1" },
      { value: "1.2.2" },
      { value: "2.1" },
      { value: "2.2" },
    ]);
  });

  it("extracts level 2 nodes", () => {
    const { output_data } = extract_leaf_levels(input_tree, { level: 2 });

    expect(output_data).toEqual([
      {
        value: "1.1",
        children: [{ value: "1.1.1" }, { value: "1.1.2" }],
      },
      {
        value: "1.2",
        children: [{ value: "1.2.1" }, { value: "1.2.2" }],
      },
      {
        value: "2",
        children: [{ value: "2.1" }, { value: "2.2" }],
      },
    ]);
  });

  it("keeps primitive leaf values", () => {
    const { output_data } = extract_leaf_levels(["a", "b"], { level: 1 });
    expect(output_data).toEqual(["a", "b"]);
  });
});

describe("json_tree_leaf_extract CLI", () => {
  it("writes extracted leaves next to the input file", async () => {
    const temp_root = await create_temp_dir();
    const input_file = path.join(temp_root, "tree.json");

    await fs.writeFile(input_file, JSON.stringify(input_tree), "utf8");

    try {
      const result = await run_cli([input_file]);

      expect(result.exit_code).toBe(0);

      const output_file = path.join(temp_root, "tree.leaves.1.json");
      const output_text = await fs.readFile(output_file, "utf8");
      const output_data = JSON.parse(output_text);

      expect(output_data).toEqual([
        { value: "1.1.1" },
        { value: "1.1.2" },
        { value: "1.2.1" },
        { value: "1.2.2" },
        { value: "2.1" },
        { value: "2.2" },
      ]);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
