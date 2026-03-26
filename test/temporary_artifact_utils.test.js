import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import output_path_utils_module from "../lib/live_media/output_path_utils";
import temporary_artifact_utils_module from "../lib/live_media/temporary_artifact_utils";

const { create_short_temporary_output_path } = output_path_utils_module;
const {
  cleanup_stale_temporary_artifacts,
  create_temporary_directory_prefix,
} = temporary_artifact_utils_module;

const temporary_directories = [];

async function create_temp_directory() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "temporary-artifact-utils-"),
  );
  temporary_directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporary_directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("temporary artifact recovery", () => {
  it("removes stale temporary files for the same final output", async () => {
    const directory = await create_temp_directory();
    const final_path = path.join(directory, "sample.compressed.medium.mp4");
    const stale_a_path = create_short_temporary_output_path(final_path, {
      label: "compress",
    });
    const stale_b_path = create_short_temporary_output_path(final_path, {
      label: "compress",
    });
    const unrelated_path = create_short_temporary_output_path(final_path, {
      label: "audio",
    });

    await fs.writeFile(stale_a_path, "partial-a");
    await fs.writeFile(stale_b_path, "partial-b");
    await fs.writeFile(unrelated_path, "keep");

    const removed_paths = await cleanup_stale_temporary_artifacts(final_path, {
      label: "compress",
      entry_kind: "file",
    });

    expect(removed_paths).toEqual([stale_a_path, stale_b_path].sort());
    await expect(fs.access(stale_a_path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(stale_b_path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(unrelated_path, "utf8")).resolves.toBe("keep");
  });

  it("removes stale temporary directories for interrupted transcript runs", async () => {
    const directory = await create_temp_directory();
    const output_key_path = path.join(directory, "sample");
    const prefix = create_temporary_directory_prefix(output_key_path, {
      label: "transcribe",
    });
    const stale_a_path = `${prefix}old_a`;
    const stale_b_path = `${prefix}old_b`;
    const unrelated_path = path.join(directory, ".whisper-other");

    await fs.mkdir(stale_a_path, { recursive: true });
    await fs.mkdir(stale_b_path, { recursive: true });
    await fs.mkdir(unrelated_path, { recursive: true });

    const removed_paths = await cleanup_stale_temporary_artifacts(
      output_key_path,
      {
        label: "transcribe",
        entry_kind: "directory",
        include_extension: false,
      },
    );

    expect(removed_paths).toEqual([stale_a_path, stale_b_path].sort());
    await expect(fs.access(stale_a_path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(stale_b_path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(unrelated_path)).resolves.toBeUndefined();
  });
});
