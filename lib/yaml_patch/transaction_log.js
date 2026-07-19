"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  canonical_digest,
  clone_json_value,
  validate_artifact_version,
} = require("./artifact_version");
const { Yaml_patch_error } = require("./error");
const { assert_known_fields, assert_object } = require("./schema");

const JOURNAL_FORMAT = "yaml_patch-transaction-journal";
const JOURNAL_STATES = Object.freeze([
  "planned",
  "prepared",
  "committing",
  "committed",
  "rolling_back",
  "rolled_back",
  "recovery_required",
]);

const JOURNAL_FIELDS = Object.freeze([
  "format",
  "version",
  "transaction_id",
  "state",
  "created_at",
  "updated_at",
  "commit_order",
  "files",
  "manifest_digest",
  "recovery_direction",
  "committed_files",
  "uncommitted_files",
  "next_action",
]);

const JOURNAL_FILE_FIELDS = Object.freeze([
  "file_id",
  "source_path",
  "realpath",
  "original_digest",
  "candidate_digest",
  "candidate_path",
  "recovery_path",
  "progress",
  "original_mode",
  "original_uid",
  "original_gid",
]);

function journal_error(message, details = {}) {
  throw new Yaml_patch_error("VALIDATION_FAILED", message, { details });
}

function recovery_required_error(journal, message) {
  throw new Yaml_patch_error("RECOVERY_REQUIRED", message, {
    recoverable: true,
    next_action:
      journal.next_action ||
      "inspect the journal and run an explicit recovery command",
    details: {
      journal_path: journal.journal_path,
      transaction_id: journal.transaction_id,
      state: journal.state,
      committed_files: journal.committed_files || [],
      uncommitted_files: journal.uncommitted_files || [],
      next_action: journal.next_action,
    },
  });
}

function journal_path_for_directory(directory_path, transaction_id) {
  return path.join(
    directory_path,
    `.yaml_patch-transaction-${transaction_id}.journal`,
  );
}

function create_transaction_journal(input) {
  assert_object(input, "transaction journal input");
  const transaction_id = input.transaction_id || crypto.randomUUID();
  const now = new Date().toISOString();
  const files = (input.files || []).map((file) => {
    assert_object(file, "transaction journal file");
    assert_known_fields(file, JOURNAL_FILE_FIELDS, "transaction journal file");
    return {
      file_id: file.file_id,
      source_path: file.source_path,
      realpath: file.realpath,
      original_digest: file.original_digest,
      candidate_digest: file.candidate_digest,
      candidate_path: file.candidate_path || null,
      recovery_path: file.recovery_path || null,
      progress: file.progress || "planned",
      original_mode:
        file.original_mode === undefined ? null : file.original_mode,
      original_uid: file.original_uid === undefined ? null : file.original_uid,
      original_gid: file.original_gid === undefined ? null : file.original_gid,
    };
  });
  const commit_order = input.commit_order || files.map((file) => file.file_id);
  return {
    format: JOURNAL_FORMAT,
    version: 1,
    transaction_id,
    state: input.state || "planned",
    created_at: input.created_at || now,
    updated_at: input.updated_at || now,
    commit_order,
    files,
    manifest_digest: input.manifest_digest || null,
    recovery_direction: input.recovery_direction || null,
    committed_files: input.committed_files || [],
    uncommitted_files:
      input.uncommitted_files ||
      files
        .filter((file) => file.progress !== "committed")
        .map((file) => file.file_id),
    next_action: input.next_action || null,
    journal_path: input.journal_path || null,
  };
}

function validate_transaction_journal(journal) {
  const value = clone_json_value(journal, "transaction journal");
  assert_object(value, "transaction journal");
  validate_artifact_version("journal", value.version);
  assert_known_fields(value, JOURNAL_FIELDS, "transaction journal");
  if (value.format !== JOURNAL_FORMAT) {
    journal_error("Unsupported transaction journal format", {
      format: value.format,
    });
  }
  if (!JOURNAL_STATES.includes(value.state)) {
    journal_error("Unsupported transaction journal state", {
      state: value.state,
    });
  }
  if (!Array.isArray(value.files) || !Array.isArray(value.commit_order)) {
    journal_error("Transaction journal files and commit_order must be arrays");
  }
  for (const file of value.files) {
    assert_object(file, "transaction journal file");
    assert_known_fields(file, JOURNAL_FILE_FIELDS, "transaction journal file");
  }
  return value;
}

async function persist_transaction_journal(journal_path, journal) {
  const { journal_path: _ignored, digest: _digest, ...persistable } = journal;
  const validated = validate_transaction_journal({
    ...persistable,
    updated_at: new Date().toISOString(),
  });
  const payload = `${JSON.stringify(validated, null, 2)}\n`;
  const temporary_path = `${journal_path}.${process.pid}.tmp`;
  const handle = await fs.open(temporary_path, "wx", 0o600);
  try {
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    await fs.rename(temporary_path, journal_path);
    const directory = await fs.open(path.dirname(journal_path), "r");
    try {
      if (typeof directory.sync === "function") await directory.sync();
    } catch (error) {
      if (!error || !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code)) {
        throw error;
      }
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(temporary_path).catch(() => {});
    throw error;
  }
  return {
    ...validated,
    journal_path,
    digest: canonical_digest(validated),
  };
}

async function read_transaction_journal(journal_path) {
  const text = await fs.readFile(journal_path, "utf8");
  const journal = validate_transaction_journal(JSON.parse(text));
  return { ...journal, journal_path };
}

function update_journal_file_progress(journal, file_id, progress) {
  const files = journal.files.map((file) =>
    file.file_id === file_id ? { ...file, progress } : file,
  );
  const committed_files = files
    .filter((file) => file.progress === "committed")
    .map((file) => file.file_id);
  const uncommitted_files = files
    .filter((file) => file.progress !== "committed")
    .map((file) => file.file_id);
  return {
    ...journal,
    files,
    committed_files,
    uncommitted_files,
  };
}

module.exports = {
  JOURNAL_FORMAT,
  JOURNAL_STATES,
  create_transaction_journal,
  journal_path_for_directory,
  persist_transaction_journal,
  read_transaction_journal,
  recovery_required_error,
  update_journal_file_progress,
  validate_transaction_journal,
};
