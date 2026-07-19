import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import source_module from "../lib/yaml_patch/source";
import recovery_module from "../lib/yaml_patch/recovery";
import transaction_log_module from "../lib/yaml_patch/transaction_log";

const { sha256_digest } = source_module;
const { inspect_transaction_status, recover_transaction } = recovery_module;
const { persist_transaction_journal } = transaction_log_module;

const temp_directories = [];

afterEach(async () => {
  await Promise.all(
    temp_directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function create_recovery_fixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "yaml-patch-recovery-"),
  );
  temp_directories.push(directory);
  const source_path = path.join(directory, "a.yaml");
  const original = "value: old\n";
  const candidate = "value: new\n";
  await fs.writeFile(source_path, original);
  const candidate_path = path.join(directory, ".a.yaml.candidate.tmp");
  const recovery_path = path.join(directory, ".a.yaml.recovery.tmp");
  await fs.writeFile(candidate_path, candidate);
  await fs.writeFile(recovery_path, original);
  const journal_path = path.join(directory, ".tx.journal");
  await persist_transaction_journal(journal_path, {
    format: "yaml_patch-transaction-journal",
    version: 1,
    transaction_id: "tx-1",
    state: "prepared",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    commit_order: ["a"],
    files: [
      {
        file_id: "a",
        source_path,
        realpath: source_path,
        original_digest: sha256_digest(Buffer.from(original)),
        candidate_digest: sha256_digest(Buffer.from(candidate)),
        candidate_path,
        recovery_path,
        progress: "prepared",
        original_mode: 0o644,
        original_uid: 0,
        original_gid: 0,
      },
    ],
    manifest_digest: null,
    recovery_direction: null,
    committed_files: [],
    uncommitted_files: ["a"],
    next_action: "begin committing prepared candidates",
  });
  return {
    directory,
    source_path,
    journal_path,
    original,
    candidate,
  };
}

describe("YAML transaction recovery", () => {
  it("inspects journal status and completes an explicit commit", async () => {
    const fixture = await create_recovery_fixture();
    const status = await inspect_transaction_status(fixture.journal_path);
    expect(status).toMatchObject({
      state: "prepared",
      transaction_id: "tx-1",
      uncommitted_files: ["a"],
    });

    const recovered = await recover_transaction(fixture.journal_path, {
      direction: "commit",
    });
    expect(recovered.state).toBe("committed");
    expect(recovered.recovered).toBe(true);
    expect(await fs.readFile(fixture.source_path, "utf8")).toBe(
      fixture.candidate,
    );
    await expect(fs.access(fixture.journal_path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("completes an explicit rollback and is idempotent for terminal states", async () => {
    const fixture = await create_recovery_fixture();
    const rolled_back = await recover_transaction(fixture.journal_path, {
      direction: "rollback",
    });
    expect(rolled_back.state).toBe("rolled_back");
    expect(await fs.readFile(fixture.source_path, "utf8")).toBe(
      fixture.original,
    );

    const terminal_path = path.join(fixture.directory, ".terminal.journal");
    await persist_transaction_journal(terminal_path, {
      format: "yaml_patch-transaction-journal",
      version: 1,
      transaction_id: "tx-terminal",
      state: "rolled_back",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      commit_order: ["a"],
      files: [
        {
          file_id: "a",
          source_path: fixture.source_path,
          realpath: fixture.source_path,
          original_digest: sha256_digest(Buffer.from(fixture.original)),
          candidate_digest: sha256_digest(Buffer.from(fixture.candidate)),
          candidate_path: null,
          recovery_path: null,
          progress: "rolled_back",
          original_mode: 0o644,
          original_uid: 0,
          original_gid: 0,
        },
      ],
      manifest_digest: null,
      recovery_direction: "rollback",
      committed_files: [],
      uncommitted_files: ["a"],
      next_action: null,
    });
    const again = await recover_transaction(terminal_path, {
      direction: "rollback",
    });
    expect(again).toMatchObject({
      state: "rolled_back",
      idempotent: true,
      recovered: false,
    });
  });

  it("refuses recovery when source digests disagree with the journal", async () => {
    const fixture = await create_recovery_fixture();
    await fs.writeFile(fixture.source_path, "value: unexpected\n");
    await expect(
      recover_transaction(fixture.journal_path, { direction: "rollback" }),
    ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });
});
