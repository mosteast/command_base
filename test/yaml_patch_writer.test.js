import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import source_module from "../lib/yaml_patch/source";
import parser_module from "../lib/yaml_patch/parser";
import node_index_module from "../lib/yaml_patch/node_index";
import query_module from "../lib/yaml_patch/query";
import fragment_module from "../lib/yaml_patch/fragment";
import writer_module from "../lib/yaml_patch/writer";

const { read_source_file, sha256_digest } = source_module;
const { parse_yaml_source } = parser_module;
const { build_node_index } = node_index_module;
const { select_unique_node } = query_module;
const { build_edit_package } = fragment_module;
const {
  acquire_file_lock,
  apply_edit_package,
  assert_write_target,
  break_stale_management_guard,
  break_stale_file_lock,
  get_writer_capabilities,
  inspect_management_guard,
  inspect_file_lock,
  assert_local_file_system,
  management_guard_path_for,
  release_file_lock,
} = writer_module;

const temp_directories = [];
const exec_file = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temp_directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function create_temp_source(text = "value: old\n") {
  const temp_directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "yaml-patch-writer-"),
  );
  temp_directories.push(temp_directory);
  const file_path = path.join(temp_directory, "source with space.yaml");
  await fs.writeFile(file_path, text, { mode: 0o640 });
  return { temp_directory, file_path };
}

async function create_edit_package(file_path, replacement = "new") {
  const source = await read_source_file(file_path);
  const index = build_node_index(source, parse_yaml_source(source));
  const entry = select_unique_node(index, {
    path: [{ mapping_key: "value" }],
  });
  const edit_package = build_edit_package(index, entry, {
    edit_unit: "scalar-token",
  });
  edit_package.fragment_buffer = Buffer.from(replacement);
  return edit_package;
}

describe("cooperative YAML patch lock", () => {
  it("allows only one holder and removes a lock owned by its token", async () => {
    const { file_path } = await create_temp_source();
    const lock = await acquire_file_lock(file_path, { tool_version: "test" });

    await expect(acquire_file_lock(file_path)).rejects.toMatchObject({
      code: "UNSAFE_CONCURRENCY",
    });
    await release_file_lock(lock);
    await expect(fs.access(lock.lock_path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not delete a lock whose token changed", async () => {
    const { file_path } = await create_temp_source();
    const lock = await acquire_file_lock(file_path);
    const lock_data = JSON.parse(await fs.readFile(lock.lock_path, "utf8"));
    await fs.writeFile(
      lock.lock_path,
      `${JSON.stringify({ ...lock_data, token: "different" })}\n`,
    );

    await expect(release_file_lock(lock)).rejects.toMatchObject({
      code: "UNSAFE_CONCURRENCY",
    });
    await expect(fs.access(lock.lock_path)).resolves.toBeUndefined();
    await fs.unlink(lock.lock_path);
  });

  it("breaks only a token-matched same-host lock whose process is gone", async () => {
    const { file_path } = await create_temp_source();
    const live_lock = await acquire_file_lock(file_path);

    await expect(
      break_stale_file_lock(file_path, {
        expected_token: live_lock.token,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_CONCURRENCY" });
    await release_file_lock(live_lock);

    const stale_lock_path = path.join(
      path.dirname(file_path),
      `.${path.basename(file_path)}.yaml_patch.lock`,
    );
    const stale_lock = {
      source_path: file_path,
      pid: 999999,
      hostname: os.hostname(),
      token: "stale-token",
      created_at: "2020-01-01T00:00:00.000Z",
    };
    await fs.writeFile(stale_lock_path, `${JSON.stringify(stale_lock)}\n`, {
      flag: "wx",
      mode: 0o600,
    });

    await expect(inspect_file_lock(file_path)).resolves.toMatchObject({
      lock: stale_lock,
    });
    await expect(
      break_stale_file_lock(file_path, { expected_token: "wrong" }),
    ).rejects.toMatchObject({ code: "UNSAFE_CONCURRENCY" });
    await expect(
      break_stale_file_lock(file_path, {
        expected_token: stale_lock.token,
      }),
    ).resolves.toMatchObject({ removed: true, lock: stale_lock });
    await expect(fs.access(stale_lock_path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("serializes lock acquire and stale break through token quarantine", async () => {
    const { file_path } = await create_temp_source();
    const stale_lock_path = path.join(
      path.dirname(file_path),
      `.${path.basename(file_path)}.yaml_patch.lock`,
    );
    const stale_lock = {
      source_path: file_path,
      pid: 999999,
      hostname: os.hostname(),
      token: "serialized-stale-token",
      created_at: "2020-01-01T00:00:00.000Z",
    };
    await fs.writeFile(stale_lock_path, `${JSON.stringify(stale_lock)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const blocked_codes = [];

    await break_stale_file_lock(file_path, {
      expected_token: stale_lock.token,
      async on_management_guard() {
        for (const operation of [
          () =>
            break_stale_file_lock(file_path, {
              expected_token: stale_lock.token,
            }),
          () => acquire_file_lock(file_path),
        ]) {
          try {
            await operation();
          } catch (error) {
            blocked_codes.push(error.code);
          }
        }
      },
    });

    expect(blocked_codes).toEqual(["UNSAFE_CONCURRENCY", "UNSAFE_CONCURRENCY"]);
    const new_lock = await acquire_file_lock(file_path);
    await release_file_lock(new_lock);
    expect(
      (await fs.readdir(path.dirname(file_path))).filter((name) =>
        name.includes("yaml_patch.lock"),
      ),
    ).toEqual([]);
  });

  it("recovers a token-matched management guard left by a dead process", async () => {
    const { file_path } = await create_temp_source();
    const guard_path = management_guard_path_for(file_path);
    const stale_guard = {
      source_path: file_path,
      pid: 999999,
      hostname: os.hostname(),
      token: "stale-management-token",
      created_at: "2020-01-01T00:00:00.000Z",
      operation: "acquire-lock",
    };
    await fs.writeFile(guard_path, `${JSON.stringify(stale_guard)}\n`, {
      flag: "wx",
      mode: 0o600,
    });

    await expect(acquire_file_lock(file_path)).rejects.toMatchObject({
      code: "UNSAFE_CONCURRENCY",
    });
    await expect(inspect_management_guard(file_path)).resolves.toMatchObject({
      lock: stale_guard,
    });
    await expect(
      break_stale_management_guard(file_path, {
        expected_token: "wrong-token",
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_CONCURRENCY" });
    await expect(
      break_stale_management_guard(file_path, {
        expected_token: stale_guard.token,
      }),
    ).resolves.toMatchObject({ removed: true, lock: stale_guard });

    const lock = await acquire_file_lock(file_path);
    await release_file_lock(lock);
  });

  it("keeps the guard namespace occupied across concurrent stale breakers", async () => {
    const { file_path } = await create_temp_source();
    const guard_path = management_guard_path_for(file_path);
    const stale_guard = {
      source_path: file_path,
      pid: 999999,
      hostname: os.hostname(),
      token: "concurrent-stale-management-token",
      created_at: "2020-01-01T00:00:00.000Z",
      operation: "acquire-lock",
    };
    await fs.writeFile(guard_path, `${JSON.stringify(stale_guard)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    let mark_inspected;
    const inspected = new Promise((resolve) => {
      mark_inspected = resolve;
    });
    let resume_breaker;
    const breaker_gate = new Promise((resolve) => {
      resume_breaker = resolve;
    });
    const delayed_breaker = break_stale_management_guard(file_path, {
      expected_token: stale_guard.token,
      async after_recovery_inspection() {
        mark_inspected();
        await breaker_gate;
      },
    });
    await inspected;

    await expect(
      break_stale_management_guard(file_path, {
        expected_token: stale_guard.token,
      }),
    ).resolves.toMatchObject({ removed: true });
    await expect(acquire_file_lock(file_path)).rejects.toMatchObject({
      code: "UNSAFE_CONCURRENCY",
    });
    resume_breaker();
    await expect(delayed_breaker).rejects.toMatchObject({
      code: "UNSAFE_CONCURRENCY",
    });

    const lock = await acquire_file_lock(file_path);
    await release_file_lock(lock);
  });

  it("recovers an abandoned recovery-intent marker", async () => {
    const { file_path } = await create_temp_source();
    const guard_path = management_guard_path_for(file_path);
    const intent_path = `${guard_path}.recovery-abandoned`;
    const stale_intent = {
      owner_path: file_path,
      pid: 999999,
      hostname: os.hostname(),
      token: "abandoned-recovery-token",
      created_at: "2020-01-01T00:00:00.000Z",
      operation: "break-stale-guard",
    };
    await fs.writeFile(intent_path, `${JSON.stringify(stale_intent)}\n`, {
      flag: "wx",
      mode: 0o600,
    });

    await expect(inspect_management_guard(file_path)).resolves.toMatchObject({
      marker: true,
      lock: stale_intent,
    });
    await expect(
      break_stale_management_guard(file_path, {
        expected_token: stale_intent.token,
      }),
    ).resolves.toMatchObject({ removed: true, marker: true });

    const lock = await acquire_file_lock(file_path);
    await release_file_lock(lock);
  });
});

describe("atomic YAML patch writer", () => {
  it("revalidates, atomically replaces, preserves mode, and verifies digest", async () => {
    const { file_path } = await create_temp_source();
    const edit_package = await create_edit_package(file_path, "new");

    const result = await apply_edit_package(edit_package, { write: true });

    expect(await fs.readFile(file_path, "utf8")).toBe("value: new\n");
    expect((await fs.stat(file_path)).mode & 0o777).toBe(0o640);
    expect(result).toMatchObject({
      written: true,
      candidate_digest: sha256_digest(Buffer.from("value: new\n")),
      guarantees: {
        atomic_visibility: true,
        cooperative_conflict_detection: true,
      },
    });
  });

  it("restores special mode bits after owner preservation", async () => {
    const { file_path } = await create_temp_source();
    await fs.chmod(file_path, 0o6750);
    const edit_package = await create_edit_package(file_path, "new");

    await apply_edit_package(edit_package, { write: true });

    expect((await fs.stat(file_path)).mode & 0o7777).toBe(0o6750);
  });

  it("defaults to dry-run and does not rewrite an unchanged fragment", async () => {
    const { file_path } = await create_temp_source();
    const dry_run_package = await create_edit_package(file_path, "new");

    const dry_run = await apply_edit_package(dry_run_package);
    expect(dry_run.written).toBe(false);
    expect(await fs.readFile(file_path, "utf8")).toBe("value: old\n");

    const no_op_package = await create_edit_package(file_path, "old");
    const inode_before = (await fs.stat(file_path)).ino;
    const no_op = await apply_edit_package(no_op_package, { write: true });
    expect(no_op.no_op).toBe(true);
    expect(no_op.written).toBe(false);
    expect((await fs.stat(file_path)).ino).toBe(inode_before);
  });

  it("leaves the original intact and cleans temporary artifacts before rename", async () => {
    const { temp_directory, file_path } = await create_temp_source();
    const edit_package = await create_edit_package(file_path, "new");

    await expect(
      apply_edit_package(edit_package, {
        write: true,
        before_rename() {
          throw new Error("injected rename failure");
        },
      }),
    ).rejects.toThrow("injected rename failure");

    expect(await fs.readFile(file_path, "utf8")).toBe("value: old\n");
    expect(await fs.readdir(temp_directory)).toEqual([
      "source with space.yaml",
    ]);
  });

  it("rejects symlinks and files with multiple hard links", async () => {
    const { temp_directory, file_path } = await create_temp_source();
    const symbolic_path = path.join(temp_directory, "symbolic.yaml");
    const hard_link_path = path.join(temp_directory, "hard.yaml");
    await fs.symlink(file_path, symbolic_path);
    await fs.link(file_path, hard_link_path);

    await expect(assert_write_target(symbolic_path)).rejects.toMatchObject({
      code: "UNSUPPORTED_FILE_TYPE",
    });
    await expect(assert_write_target(file_path)).rejects.toMatchObject({
      code: "UNSUPPORTED_FILE_TYPE",
    });
  });

  it("rejects extended metadata when the platform adapter cannot copy it", async () => {
    const { file_path } = await create_temp_source();

    await expect(
      assert_write_target(file_path, {
        metadata_detector: async () => ({
          extended_attribute_names: ["user.example"],
          access_control_entries: [],
          copy_support: {
            extended_attributes: false,
            access_control_list: false,
          },
        }),
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_FILE_TYPE",
      details: {
        unsupported_metadata: {
          extended_attribute_names: ["user.example"],
        },
      },
    });
  });

  it.skipIf(process.platform !== "darwin")(
    "preserves macOS extended attributes across atomic replacement",
    async () => {
      const { file_path } = await create_temp_source();
      const attribute_name = "com.command-base.yaml_patch-test";
      await exec_file("xattr", ["-w", attribute_name, "preserved", file_path]);
      const edit_package = await create_edit_package(file_path, "new");

      await apply_edit_package(edit_package, { write: true });

      const result = await exec_file("xattr", [
        "-p",
        attribute_name,
        file_path,
      ]);
      expect(result.stdout.trimEnd()).toBe("preserved");
    },
  );

  it("rejects a source changed after extract while holding the lock", async () => {
    const { file_path } = await create_temp_source();
    const edit_package = await create_edit_package(file_path, "new");
    await fs.writeFile(file_path, "value: external\n", { mode: 0o640 });

    await expect(
      apply_edit_package(edit_package, { write: true }),
    ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await fs.readFile(file_path, "utf8")).toBe("value: external\n");
  });
});

describe("writer capabilities", () => {
  it("declares platform-specific write guarantees", () => {
    expect(get_writer_capabilities({ platform: "linux" })).toMatchObject({
      write: true,
      atomic_visibility: true,
      cooperative_conflict_detection: true,
      rejects_extended_metadata: true,
    });
    expect(get_writer_capabilities({ platform: "win32" })).toMatchObject({
      write: false,
      atomic_visibility: false,
    });
  });

  it("allows only verified local filesystem types", async () => {
    const { file_path } = await create_temp_source();

    await expect(
      assert_local_file_system(file_path, {
        platform: "linux",
        file_system_stats: { type: 0x794c7630 },
      }),
    ).resolves.toMatchObject({ type: 0x794c7630 });
    await expect(
      assert_local_file_system(file_path, {
        platform: "linux",
        file_system_stats: { type: 0x12345678 },
      }),
    ).rejects.toMatchObject({ code: "ATOMIC_WRITE_UNAVAILABLE" });
  });
});
