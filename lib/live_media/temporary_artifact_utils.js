const fs = require("fs");
const path = require("path");

const {
  build_temporary_artifact_reference,
} = require("./output_path_utils");

function is_matching_entry(entry, reference, entry_kind) {
  if (!entry || !entry.name) return false;
  if (!entry.name.startsWith(reference.name_prefix)) return false;

  if (entry_kind === "directory") {
    return typeof entry.isDirectory === "function" && entry.isDirectory();
  }

  if (
    typeof entry.isFile === "function" &&
    entry.isFile() &&
    (!reference.extension || entry.name.endsWith(reference.extension))
  ) {
    return true;
  }

  if (
    typeof entry.isSymbolicLink === "function" &&
    entry.isSymbolicLink() &&
    (!reference.extension || entry.name.endsWith(reference.extension))
  ) {
    return true;
  }

  return false;
}

async function list_temporary_artifacts(target_path, options = {}) {
  const {
    entry_kind = "file",
    include_extension = true,
  } = options;
  const reference = build_temporary_artifact_reference(target_path, {
    ...options,
    include_extension,
  });

  let directory_entries;
  try {
    directory_entries = await fs.promises.readdir(reference.directory, {
      withFileTypes: true,
    });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  return directory_entries
    .filter((entry) => is_matching_entry(entry, reference, entry_kind))
    .map((entry) => path.join(reference.directory, entry.name))
    .sort();
}

async function remove_temporary_artifact(candidate, entry_kind) {
  if (!candidate) return;

  if (entry_kind === "directory") {
    if (typeof fs.promises.rm === "function") {
      await fs.promises.rm(candidate, { recursive: true, force: true });
      return;
    }

    try {
      await fs.promises.rmdir(candidate, { recursive: true });
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
    return;
  }

  try {
    if (typeof fs.promises.rm === "function") {
      await fs.promises.rm(candidate, { force: true });
    } else {
      await fs.promises.unlink(candidate);
    }
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
}

async function cleanup_stale_temporary_artifacts(target_path, options = {}) {
  const entry_kind = options.entry_kind || "file";
  const stale_artifacts = await list_temporary_artifacts(target_path, options);
  for (const candidate of stale_artifacts) {
    await remove_temporary_artifact(candidate, entry_kind);
  }
  return stale_artifacts;
}

function create_temporary_directory_prefix(target_path, options = {}) {
  const reference = build_temporary_artifact_reference(target_path, {
    ...options,
    include_extension: false,
  });
  return path.join(reference.directory, reference.name_prefix);
}

module.exports = {
  cleanup_stale_temporary_artifacts,
  create_temporary_directory_prefix,
  list_temporary_artifacts,
};
