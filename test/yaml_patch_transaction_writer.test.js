import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import source_module from "../lib/yaml_patch/source";
import writer_module from "../lib/yaml_patch/writer";
import transaction_writer_module from "../lib/yaml_patch/transaction_writer";
import recovery_module from "../lib/yaml_patch/recovery";

const { sha256_digest } = source_module;
const { get_writer_capabilities, lock_path_for } = writer_module;
const { write_transaction } = transaction_writer_module;
const { inspect_transaction_status } = recovery_module;

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
    path.join(os.tmpdir(), "yaml-patch-tx-writer-"),
  );
  temp_directories.push(directory);
  const created = {};
  for (const [name, text] of Object.entries(files)) {
    const file_path = path.join(directory, name);
    await fs.writeFile(file_path, text);
    created[name] = file_path;
  }
  return { directory, files: created };
}

function file_decl(id, file_path, text) {
  return {
    id,
    path: file_path,
    digest: sha256_digest(Buffer.from(text)),
    document_count: 1,
  };
}

function replace_value_request(files, replacements) {
  return {
    version: 1,
    files: files.map((item) => item.declaration),
    operations: replacements.map((item) => ({
      id: item.id,
      type: "replace_scalar_raw",
      file: item.file_id,
      target: {
        selector: { version: 1, path: [{ mapping_key: "value" }] },
      },
      raw: item.raw,
    })),
  };
}

function sources_from(files) {
  return Object.fromEntries(
    files.map((item) => [item.declaration.id, item.source]),
  );
}

describe("YAML multi-file transaction writer", () => {
  it("skips locks and journal artifacts for a no-op write", async () => {
    const text = "value: same\n";
    const { directory, files } = await create_workspace({ "a.yaml": text });
    const declaration = file_decl("a", files["a.yaml"], text);
    const acquired = [];
    const result = await write_transaction(
      replace_value_request(
        [{ declaration, source: Buffer.from(text) }],
        [{ id: "keep", file_id: "a", raw: "same" }],
      ),
      {
        write: true,
        sources: { a: Buffer.from(text) },
        capability_digest: "c".repeat(64),
        tool_version: "1.0.1",
        on_lock_acquired: async () => {
          acquired.push(true);
        },
      },
    );

    expect(result.no_op).toBe(true);
    expect(result.written).toBe(false);
    expect(acquired).toEqual([]);
    expect(await fs.readdir(directory)).toEqual(["a.yaml"]);
    await expect(
      fs.access(lock_path_for(files["a.yaml"])),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps dry-run available when atomic writes are unsupported", async () => {
    const text = "value: old\n";
    const { files } = await create_workspace({ "a.yaml": text });
    const declaration = file_decl("a", files["a.yaml"], text);
    const request = replace_value_request(
      [{ declaration, source: Buffer.from(text) }],
      [{ id: "change", file_id: "a", raw: "new" }],
    );
    const options = {
      sources: { a: Buffer.from(text) },
      capability_digest: "c".repeat(64),
      tool_version: "1.0.1",
      platform: "win32",
    };

    expect(get_writer_capabilities(options).write).toBe(false);
    const dry_run = await write_transaction(request, options);
    expect(dry_run.dry_run).toBe(true);
    expect(dry_run.written).toBe(false);
    expect(await fs.readFile(files["a.yaml"], "utf8")).toBe(text);

    await expect(
      write_transaction(request, { ...options, write: true }),
    ).rejects.toMatchObject({ code: "ATOMIC_WRITE_UNAVAILABLE" });
    expect(await fs.readFile(files["a.yaml"], "utf8")).toBe(text);
  });

  it("acquires locks in stable realpath order and revalidates under lock", async () => {
    const left_text = "value: left\n";
    const right_text = "value: right\n";
    const { directory, files } = await create_workspace({
      "z.yaml": left_text,
      "a.yaml": right_text,
    });
    const declarations = [
      {
        declaration: file_decl("z", files["z.yaml"], left_text),
        source: Buffer.from(left_text),
      },
      {
        declaration: file_decl("a", files["a.yaml"], right_text),
        source: Buffer.from(right_text),
      },
    ];
    const acquired = [];
    const result = await write_transaction(
      replace_value_request(declarations, [
        { id: "change-z", file_id: "z", raw: "LEFT" },
        { id: "change-a", file_id: "a", raw: "RIGHT" },
      ]),
      {
        write: true,
        sources: sources_from(declarations),
        capability_digest: "c".repeat(64),
        tool_version: "1.0.1",
        journal_directory: directory,
        on_lock_acquired: async ({ file }) => {
          acquired.push(path.basename(file.realpath));
        },
      },
    );

    expect(result.written).toBe(true);
    expect(acquired).toEqual(["a.yaml", "z.yaml"]);
    expect(await fs.readFile(files["a.yaml"], "utf8")).toBe("value: RIGHT\n");
    expect(await fs.readFile(files["z.yaml"], "utf8")).toBe("value: LEFT\n");
    expect(await fs.readdir(directory)).toEqual(["a.yaml", "z.yaml"]);
  });

  it("leaves every source intact when prepare fails before commit", async () => {
    const text = "value: old\n";
    const { directory, files } = await create_workspace({ "a.yaml": text });
    const declaration = file_decl("a", files["a.yaml"], text);
    await expect(
      write_transaction(
        replace_value_request(
          [{ declaration, source: Buffer.from(text) }],
          [{ id: "change", file_id: "a", raw: "new" }],
        ),
        {
          write: true,
          sources: { a: Buffer.from(text) },
          capability_digest: "c".repeat(64),
          tool_version: "1.0.1",
          journal_directory: directory,
          before_prepare: async () => {
            throw new Error("injected prepare failure");
          },
        },
      ),
    ).rejects.toThrow("injected prepare failure");

    expect(await fs.readFile(files["a.yaml"], "utf8")).toBe(text);
    expect(await fs.readdir(directory)).toEqual(["a.yaml"]);
  });

  it("fsyncs the journal before the first source rename", async () => {
    const text = "value: old\n";
    const { directory, files } = await create_workspace({ "a.yaml": text });
    const declaration = file_decl("a", files["a.yaml"], text);
    const events = [];
    await write_transaction(
      replace_value_request(
        [{ declaration, source: Buffer.from(text) }],
        [{ id: "change", file_id: "a", raw: "new" }],
      ),
      {
        write: true,
        sources: { a: Buffer.from(text) },
        capability_digest: "c".repeat(64),
        tool_version: "1.0.1",
        journal_directory: directory,
        after_journal_prepared: async ({ journal }) => {
          events.push(`journal:${journal.state}`);
          await fs.access(journal.journal_path);
        },
        before_rename_file: async () => {
          events.push("rename");
        },
      },
    );
    expect(events).toEqual(["journal:prepared", "rename"]);
  });

  it("rolls back automatically when a mid-commit rename fails", async () => {
    const left_text = "value: left\n";
    const right_text = "value: right\n";
    const { directory, files } = await create_workspace({
      "a.yaml": left_text,
      "b.yaml": right_text,
    });
    const declarations = [
      {
        declaration: file_decl("a", files["a.yaml"], left_text),
        source: Buffer.from(left_text),
      },
      {
        declaration: file_decl("b", files["b.yaml"], right_text),
        source: Buffer.from(right_text),
      },
    ];
    let renames = 0;
    await expect(
      write_transaction(
        replace_value_request(declarations, [
          { id: "change-a", file_id: "a", raw: "LEFT" },
          { id: "change-b", file_id: "b", raw: "RIGHT" },
        ]),
        {
          write: true,
          sources: sources_from(declarations),
          capability_digest: "c".repeat(64),
          tool_version: "1.0.1",
          journal_directory: directory,
          before_rename_file: async () => {
            renames += 1;
            if (renames === 2)
              throw new Error("injected second rename failure");
          },
        },
      ),
    ).rejects.toThrow("injected second rename failure");

    expect(await fs.readFile(files["a.yaml"], "utf8")).toBe(left_text);
    expect(await fs.readFile(files["b.yaml"], "utf8")).toBe(right_text);
    expect(await fs.readdir(directory)).toEqual(["a.yaml", "b.yaml"]);
  });

  it("exposes recovery_required details when automatic rollback cannot converge", async () => {
    const left_text = "value: left\n";
    const right_text = "value: right\n";
    const { directory, files } = await create_workspace({
      "a.yaml": left_text,
      "b.yaml": right_text,
    });
    const declarations = [
      {
        declaration: file_decl("a", files["a.yaml"], left_text),
        source: Buffer.from(left_text),
      },
      {
        declaration: file_decl("b", files["b.yaml"], right_text),
        source: Buffer.from(right_text),
      },
    ];
    let journal_path = null;
    let renames = 0;
    await expect(
      write_transaction(
        replace_value_request(declarations, [
          { id: "change-a", file_id: "a", raw: "LEFT" },
          { id: "change-b", file_id: "b", raw: "RIGHT" },
        ]),
        {
          write: true,
          sources: sources_from(declarations),
          capability_digest: "c".repeat(64),
          tool_version: "1.0.1",
          journal_directory: directory,
          before_rename_file: async ({ file }) => {
            renames += 1;
            if (renames === 2) {
              journal_path = (await fs.readdir(directory))
                .filter((name) => name.includes(".journal"))
                .map((name) => path.join(directory, name))[0];
              await fs.unlink(file.recovery_path);
              // Destroy the already-committed file's recovery copy too.
              const journal = JSON.parse(
                await fs.readFile(journal_path, "utf8"),
              );
              const first = journal.files.find(
                (entry) => entry.progress === "committed",
              );
              if (first?.recovery_path) {
                await fs.unlink(first.recovery_path).catch(() => {});
              }
              throw new Error("injected second rename failure");
            }
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: expect.objectContaining({
        journal_path: expect.any(String),
      }),
    });

    const status = await inspect_transaction_status(
      journal_path ||
        path.join(
          directory,
          (await fs.readdir(directory)).find((name) =>
            name.includes(".journal"),
          ),
        ),
    );
    expect(status.state).toBe("recovery_required");
  });
});
