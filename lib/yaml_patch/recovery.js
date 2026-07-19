"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { Yaml_patch_error } = require("./error");
const { sha256_digest } = require("./source");
const {
  persist_transaction_journal,
  read_transaction_journal,
  recovery_required_error,
  update_journal_file_progress,
} = require("./transaction_log");
const { sync_parent_directory } = require("./writer");

function recovery_error(message, details = {}) {
  throw new Yaml_patch_error("VALIDATION_FAILED", message, { details });
}

async function inspect_transaction_status(journal_path) {
  const journal = await read_transaction_journal(journal_path);
  return {
    journal_path,
    transaction_id: journal.transaction_id,
    state: journal.state,
    commit_order: journal.commit_order,
    committed_files: journal.committed_files,
    uncommitted_files: journal.uncommitted_files,
    files: journal.files,
    next_action: journal.next_action,
    recovery_direction: journal.recovery_direction,
  };
}

async function assert_file_digest(file_path, expected_digest, label) {
  const buffer = await fs.readFile(file_path);
  const actual_digest = sha256_digest(buffer);
  if (actual_digest !== expected_digest) {
    throw new Yaml_patch_error(
      "SOURCE_CHANGED",
      `${label} digest does not match the transaction journal`,
      {
        details: {
          path: file_path,
          expected_digest,
          actual_digest,
        },
      },
    );
  }
  return buffer;
}

async function recover_transaction(journal_path, options = {}) {
  const direction = options.direction;
  if (direction !== "commit" && direction !== "rollback") {
    recovery_error("Recovery direction must be commit or rollback", {
      direction,
    });
  }

  let journal = await read_transaction_journal(journal_path);
  if (journal.state === "committed" && direction === "commit") {
    return { ...journal, recovered: false, idempotent: true };
  }
  if (journal.state === "rolled_back" && direction === "rollback") {
    return { ...journal, recovered: false, idempotent: true };
  }

  const files_by_id = new Map(
    journal.files.map((file) => [file.file_id, { ...file }]),
  );

  if (direction === "commit") {
    journal = {
      ...journal,
      state: "committing",
      recovery_direction: "commit",
      next_action: "complete recovery commit",
    };
    journal = await persist_transaction_journal(journal_path, journal);
    for (const file_id of journal.commit_order) {
      const file = files_by_id.get(file_id);
      if (!file) continue;
      if (file.progress === "committed") {
        await assert_file_digest(
          file.source_path,
          file.candidate_digest,
          "Committed source",
        );
        continue;
      }
      if (!file.candidate_path) {
        recovery_required_error(
          journal,
          "Recovery commit is missing a candidate artifact",
        );
      }
      await assert_file_digest(
        file.candidate_path,
        file.candidate_digest,
        "Candidate artifact",
      );
      if (file.recovery_path) {
        await assert_file_digest(
          file.recovery_path,
          file.original_digest,
          "Recovery artifact",
        );
      }
      await fs.rename(file.candidate_path, file.source_path);
      await sync_parent_directory(path.dirname(file.source_path));
      file.progress = "committed";
      journal = update_journal_file_progress(journal, file_id, "committed");
      journal = await persist_transaction_journal(journal_path, journal);
    }
    journal = {
      ...journal,
      state: "committed",
      recovery_direction: "commit",
      next_action: null,
    };
    journal = await persist_transaction_journal(journal_path, journal);
  } else {
    journal = {
      ...journal,
      state: "rolling_back",
      recovery_direction: "rollback",
      next_action: "complete recovery rollback",
    };
    journal = await persist_transaction_journal(journal_path, journal);
    for (const file_id of [...journal.commit_order].reverse()) {
      const file = files_by_id.get(file_id);
      if (!file) continue;
      const current = await fs.readFile(file.source_path);
      const current_digest = sha256_digest(current);
      if (current_digest === file.original_digest) {
        file.progress = "rolled_back";
        journal = update_journal_file_progress(journal, file_id, "rolled_back");
        journal = await persist_transaction_journal(journal_path, journal);
        continue;
      }
      if (current_digest !== file.candidate_digest) {
        throw new Yaml_patch_error(
          "SOURCE_CHANGED",
          "Source identity does not match journal original or candidate digests",
          {
            details: {
              path: file.source_path,
              actual_digest: current_digest,
              original_digest: file.original_digest,
              candidate_digest: file.candidate_digest,
            },
          },
        );
      }
      if (!file.recovery_path) {
        recovery_required_error(
          journal,
          "Recovery rollback is missing a recovery artifact",
        );
      }
      await assert_file_digest(
        file.recovery_path,
        file.original_digest,
        "Recovery artifact",
      );
      await fs.rename(file.recovery_path, file.source_path);
      await sync_parent_directory(path.dirname(file.source_path));
      file.progress = "rolled_back";
      journal = update_journal_file_progress(journal, file_id, "rolled_back");
      journal = await persist_transaction_journal(journal_path, journal);
    }
    journal = {
      ...journal,
      state: "rolled_back",
      recovery_direction: "rollback",
      next_action: null,
      committed_files: [],
      uncommitted_files: journal.files.map((file) => file.file_id),
    };
    journal = await persist_transaction_journal(journal_path, journal);
  }

  for (const file of files_by_id.values()) {
    if (file.candidate_path)
      await fs.unlink(file.candidate_path).catch(() => {});
    if (file.recovery_path) await fs.unlink(file.recovery_path).catch(() => {});
  }
  await fs.unlink(journal_path).catch(() => {});
  return {
    ...journal,
    journal_path: null,
    recovered: true,
    idempotent: false,
  };
}

module.exports = {
  inspect_transaction_status,
  recover_transaction,
};
