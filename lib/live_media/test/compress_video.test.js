const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const { create_temporary_output_path } = require("../compress_video");
const { MAX_FILE_NAME_BYTES } = require("../output_path_utils");

test("temporary output keeps media extension", () => {
  const final_path = path.join("/tmp", "sample.video.compressed.medium.mp4");
  const temp_path = create_temporary_output_path(final_path);
  const temp_base = path.basename(temp_path);

  assert.ok(
    temp_base.startsWith(".compress-"),
    `temporary name should start with .compress-, got ${temp_base}`,
  );
  assert.ok(
    temp_base.endsWith(".mp4"),
    `temporary name should keep .mp4 extension, got ${temp_base}`,
  );
  assert.ok(
    Buffer.byteLength(temp_base, "utf8") <= MAX_FILE_NAME_BYTES,
    `temporary name should stay within ${MAX_FILE_NAME_BYTES} bytes, got ${Buffer.byteLength(
      temp_base,
      "utf8",
    )}`,
  );
});

test("temporary output handles extensionless targets", () => {
  const final_path = path.join("/tmp", "archive", "video_output");
  const temp_path = create_temporary_output_path(final_path);
  const temp_base = path.basename(temp_path);

  assert.ok(
    temp_base.startsWith(".compress-"),
    `temporary name should start with .compress-, got ${temp_base}`,
  );
  assert.ok(
    !temp_base.endsWith("."),
    "extensionless temporary names should not include a trailing dot",
  );
});
