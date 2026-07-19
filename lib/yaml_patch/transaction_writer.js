"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { canonical_digest } = require("./artifact_version");
const { Yaml_patch_error } = require("./error");
const { plan_transaction } = require("./transaction");
const {
  create_transaction_journal,
  journal_path_for_directory,
  persist_transaction_journal,
  read_transaction_journal,
  recovery_required_error,
  update_journal_file_progress,
} = require("./transaction_log");
const {
  acquire_file_lock,
  assert_write_target,
  debug_log,
  get_writer_capabilities,
  release_file_lock,
  sync_parent_directory,
  verify_source_unchanged,
} = require("./writer");
const { read_bounded_file, sha256_digest } = require("./source");

function writer_error(code, message, details = {}) {
  throw new Yaml_patch_error(code, message, { details });
}

async function realpath_or_resolve(file_path) {
  try {
    return await fs.realpath(file_path);
  } catch (error) {
    if (error && error.code === "ENOENT") return path.resolve(file_path);
    throw error;
  }
}

function compare_realpath(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function lock_participants(files, options = {}) {
  const ordered = [...files].sort((left, right) =>
    compare_realpath(left.realpath, right.realpath),
  );
  const locks = [];
  try {
    for (const file of ordered) {
      debug_log(options, `io: acquire transaction lock ${file.source_path}`);
      const lock = await acquire_file_lock(file.source_path, {
        tool_version: options.tool_version,
        operation: "transaction-write",
      });
      locks.push({ ...lock, file_id: file.file_id, realpath: file.realpath });
      if (typeof options.on_lock_acquired === "function") {
        await options.on_lock_acquired({
          file,
          lock,
          acquired: locks.map((entry) => entry.realpath),
        });
      }
    }
    return locks;
  } catch (error) {
    for (const lock of locks.reverse()) {
      await release_file_lock(lock).catch(() => {});
    }
    throw error;
  }
}

async function release_locks(locks, options = {}) {
  for (const lock of [...locks].reverse()) {
    debug_log(options, `io: release transaction lock ${lock.lock_path}`);
    await release_file_lock(lock);
  }
}

async function prepare_participant_artifacts(file, candidate_buffer, options) {
  const target = await assert_write_target(file.source_path, options);
  const directory_path = path.dirname(target.absolute_path);
  const stem = path.basename(target.absolute_path);
  const candidate_path = path.join(
    directory_path,
    `.${stem}.yaml_patch-candidate-${options.transaction_id}.tmp`,
  );
  const recovery_path = path.join(
    directory_path,
    `.${stem}.yaml_patch-recovery-${options.transaction_id}.tmp`,
  );

  const original = await read_bounded_file(target.absolute_path, {
    allow_symbolic_link: false,
  });
  if (sha256_digest(original.buffer) !== file.original_digest) {
    writer_error("SOURCE_CHANGED", "Source digest changed under lock", {
      file_id: file.file_id,
      expected_digest: file.original_digest,
      actual_digest: sha256_digest(original.buffer),
    });
  }

  const recovery_handle = await fs.open(
    recovery_path,
    "wx",
    target.stats.mode & 0o7777,
  );
  try {
    await recovery_handle.writeFile(original.buffer);
    await recovery_handle.chown(target.stats.uid, target.stats.gid);
    await recovery_handle.chmod(target.stats.mode & 0o7777);
    await recovery_handle.sync();
    await recovery_handle.close();
  } catch (error) {
    await recovery_handle.close().catch(() => {});
    await fs.unlink(recovery_path).catch(() => {});
    throw error;
  }

  const candidate_handle = await fs.open(
    candidate_path,
    "wx",
    target.stats.mode & 0o7777,
  );
  try {
    await candidate_handle.writeFile(candidate_buffer);
    await candidate_handle.chown(target.stats.uid, target.stats.gid);
    await candidate_handle.chmod(target.stats.mode & 0o7777);
    await candidate_handle.sync();
    await candidate_handle.close();
  } catch (error) {
    await candidate_handle.close().catch(() => {});
    await fs.unlink(candidate_path).catch(() => {});
    await fs.unlink(recovery_path).catch(() => {});
    throw error;
  }

  return {
    ...file,
    candidate_path,
    recovery_path,
    progress: "prepared",
    original_mode: target.stats.mode & 0o7777,
    original_uid: target.stats.uid,
    original_gid: target.stats.gid,
    stats: target.stats,
    absolute_path: target.absolute_path,
  };
}

async function rename_prepared_file(file, from_path, options = {}) {
  await verify_source_unchanged(
    file.absolute_path || file.source_path,
    {
      digest: file.original_digest,
      size_bytes: file.stats.size,
      requested_path: file.source_path,
      file_path: file.source_path,
    },
    file.stats,
  );
  if (typeof options.before_rename_file === "function") {
    await options.before_rename_file({ file, from_path });
  }
  await fs.rename(from_path, file.absolute_path || file.source_path);
  await sync_parent_directory(
    path.dirname(file.absolute_path || file.source_path),
  );
  if (typeof options.after_rename_file === "function") {
    await options.after_rename_file({ file });
  }
}

async function cleanup_artifacts(files) {
  for (const file of files) {
    if (file.candidate_path)
      await fs.unlink(file.candidate_path).catch(() => {});
    if (file.recovery_path) await fs.unlink(file.recovery_path).catch(() => {});
  }
}

async function commit_planned_files(journal, files_by_id, options = {}) {
  let current = {
    ...journal,
    state: "committing",
    next_action: "complete commit or recover with --recover commit",
  };
  current = await persist_transaction_journal(journal.journal_path, current);
  if (typeof options.after_enter_committing === "function") {
    await options.after_enter_committing({ journal: current });
  }

  try {
    for (const file_id of current.commit_order) {
      const file = files_by_id.get(file_id);
      if (!file || file.progress === "committed") continue;
      await rename_prepared_file(file, file.candidate_path, options);
      file.progress = "committed";
      current = update_journal_file_progress(current, file_id, "committed");
      current = await persist_transaction_journal(
        journal.journal_path,
        current,
      );
    }
    current = {
      ...current,
      state: "committed",
      next_action: null,
      recovery_direction: "commit",
    };
    current = await persist_transaction_journal(journal.journal_path, current);
    await cleanup_artifacts([...files_by_id.values()]);
    await fs.unlink(journal.journal_path).catch(() => {});
    return { ...current, journal_path: null, written: true };
  } catch (error) {
    return rollback_committing_journal(current, files_by_id, options, error);
  }
}

async function rollback_committing_journal(
  journal,
  files_by_id,
  options = {},
  cause = null,
) {
  let current = {
    ...journal,
    state: "rolling_back",
    next_action: "complete rollback or recover with --recover rollback",
  };
  current = await persist_transaction_journal(journal.journal_path, current);
  try {
    for (const file_id of [...current.commit_order].reverse()) {
      const file = files_by_id.get(file_id);
      if (!file) continue;
      if (file.progress === "committed") {
        await fs.rename(
          file.recovery_path,
          file.absolute_path || file.source_path,
        );
        await sync_parent_directory(
          path.dirname(file.absolute_path || file.source_path),
        );
        file.progress = "rolled_back";
        current = update_journal_file_progress(current, file_id, "rolled_back");
        current = await persist_transaction_journal(
          journal.journal_path,
          current,
        );
      }
    }
    current = {
      ...current,
      state: "rolled_back",
      recovery_direction: "rollback",
      next_action: null,
      committed_files: [],
      uncommitted_files: current.files.map((file) => file.file_id),
    };
    current = await persist_transaction_journal(journal.journal_path, current);
    await cleanup_artifacts([...files_by_id.values()]);
    await fs.unlink(journal.journal_path).catch(() => {});
  } catch (error) {
    const failed = {
      ...current,
      state: "recovery_required",
      next_action: "inspect the journal and run an explicit recovery command",
    };
    await persist_transaction_journal(journal.journal_path, failed).catch(
      () => {},
    );
    recovery_required_error(
      { ...failed, journal_path: journal.journal_path },
      "Transaction commit could not converge automatically",
    );
  }
  if (cause) throw cause;
  return { ...current, journal_path: null, written: false };
}

async function write_transaction(request, options = {}) {
  const capabilities = get_writer_capabilities(options);
  if (!options.write) {
    const plan = await plan_transaction(request, options);
    return {
      ...plan,
      written: false,
      dry_run: true,
      capabilities,
    };
  }

  if (!capabilities.write) {
    writer_error(
      "ATOMIC_WRITE_UNAVAILABLE",
      "Atomic multi-file writes are unavailable on this platform",
      { platform: capabilities.platform },
    );
  }

  const initial_plan = await plan_transaction(request, options);
  if (initial_plan.no_op) {
    debug_log(options, "stage: transaction no-op skips locks and journal");
    return {
      ...initial_plan,
      written: false,
      dry_run: false,
      capabilities,
    };
  }

  const participant_files = [];
  for (const file of initial_plan.files) {
    if (file.proof.no_op) continue;
    const source_path = path.resolve(file.path);
    participant_files.push({
      file_id: file.file_id,
      source_path,
      realpath: await realpath_or_resolve(source_path),
      original_digest: file.proof.original_digest,
      candidate_digest: file.proof.candidate_digest,
      candidate_buffer: initial_plan.candidates[file.file_id].buffer,
    });
  }

  if (participant_files.length === 0) {
    return {
      ...initial_plan,
      written: false,
      dry_run: false,
      capabilities,
    };
  }

  for (const file of participant_files) {
    await assert_write_target(file.source_path, options);
  }

  const transaction_id = options.transaction_id || crypto.randomUUID();
  const journal_directory =
    options.journal_directory || path.dirname(participant_files[0].source_path);
  const journal_path =
    options.journal_path ||
    journal_path_for_directory(journal_directory, transaction_id);

  const locks = await lock_participants(participant_files, {
    ...options,
    tool_version: options.tool_version,
  });
  let journal = null;
  const prepared_by_id = new Map();
  try {
    debug_log(options, "stage: re-plan transaction under all locks");
    const plan = await plan_transaction(request, options);
    if (plan.no_op) {
      return {
        ...plan,
        written: false,
        dry_run: false,
        capabilities,
      };
    }

    for (const file of participant_files) {
      const replanned = plan.files.find(
        (entry) => entry.file_id === file.file_id,
      );
      if (
        !replanned ||
        replanned.proof.original_digest !== file.original_digest ||
        replanned.proof.candidate_digest !== file.candidate_digest
      ) {
        writer_error(
          "SOURCE_CHANGED",
          "Replanned transaction candidates changed under lock",
          { file_id: file.file_id },
        );
      }
      file.candidate_buffer = plan.candidates[file.file_id].buffer;
    }

    if (typeof options.before_prepare === "function") {
      await options.before_prepare({ files: participant_files, plan });
    }

    journal = create_transaction_journal({
      transaction_id,
      state: "planned",
      journal_path,
      manifest_digest: canonical_digest(plan.manifest),
      commit_order: participant_files
        .slice()
        .sort((left, right) => compare_realpath(left.realpath, right.realpath))
        .map((file) => file.file_id),
      files: participant_files.map((file) => ({
        file_id: file.file_id,
        source_path: file.source_path,
        realpath: file.realpath,
        original_digest: file.original_digest,
        candidate_digest: file.candidate_digest,
        progress: "planned",
      })),
    });
    journal = await persist_transaction_journal(journal_path, journal);

    for (const file_id of journal.commit_order) {
      const file = participant_files.find((entry) => entry.file_id === file_id);
      const prepared = await prepare_participant_artifacts(
        file,
        file.candidate_buffer,
        {
          ...options,
          transaction_id,
        },
      );
      prepared_by_id.set(file_id, prepared);
      journal = update_journal_file_progress(journal, file_id, "prepared");
      journal = {
        ...journal,
        files: journal.files.map((entry) =>
          entry.file_id === file_id
            ? {
                ...entry,
                candidate_path: prepared.candidate_path,
                recovery_path: prepared.recovery_path,
                original_mode: prepared.original_mode,
                original_uid: prepared.original_uid,
                original_gid: prepared.original_gid,
                progress: "prepared",
              }
            : entry,
        ),
      };
    }

    journal = {
      ...journal,
      state: "prepared",
      next_action: "begin committing prepared candidates",
    };
    journal = await persist_transaction_journal(journal_path, journal);
    if (typeof options.after_journal_prepared === "function") {
      await options.after_journal_prepared({ journal });
    }

    const result = await commit_planned_files(journal, prepared_by_id, options);
    return {
      ...plan,
      written: true,
      dry_run: false,
      capabilities,
      journal: result,
    };
  } catch (error) {
    const renamed = [...prepared_by_id.values()].some(
      (file) => file.progress === "committed",
    );
    if (renamed && journal && journal.journal_path) {
      const failed = {
        ...journal,
        state: "recovery_required",
        next_action: "inspect the journal and run an explicit recovery command",
      };
      await persist_transaction_journal(journal.journal_path, failed).catch(
        () => {},
      );
    } else {
      await cleanup_artifacts([...prepared_by_id.values()]);
      if (journal && journal.journal_path) {
        await fs.unlink(journal.journal_path).catch(() => {});
      }
    }
    throw error;
  } finally {
    await release_locks(locks, options);
  }
}

module.exports = {
  commit_planned_files,
  lock_participants,
  write_transaction,
};
