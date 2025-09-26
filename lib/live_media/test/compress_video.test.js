const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const { create_temporary_output_path } = require("../compress_video");

function hidden_prefix(base_name) {
  const extension = path.extname(base_name);
  const stem =
    extension && base_name.length > extension.length
      ? base_name.slice(0, -extension.length)
      : base_name;
  return stem.startsWith(".") ? stem : `.${stem}`;
}

test("temporary output keeps media extension", () => {
  const final_path = path.join("/tmp", "sample.video.compressed.medium.mp4");
  const temp_path = create_temporary_output_path(final_path);
  const temp_base = path.basename(temp_path);
  const expected_prefix = `${hidden_prefix(path.basename(final_path))}.tmp-`;

  assert.ok(
    temp_base.startsWith(expected_prefix),
    `temporary name should start with ${expected_prefix}, got ${temp_base}`,
  );
  assert.ok(
    temp_base.endsWith(".mp4"),
    `temporary name should keep .mp4 extension, got ${temp_base}`,
  );
});

test("temporary output handles extensionless targets", () => {
  const final_path = path.join("/tmp", "archive", "video_output");
  const temp_path = create_temporary_output_path(final_path);
  const temp_base = path.basename(temp_path);
  const expected_prefix = `${hidden_prefix(path.basename(final_path))}.tmp-`;

  assert.ok(
    temp_base.startsWith(expected_prefix),
    `temporary name should start with ${expected_prefix}, got ${temp_base}`,
  );
  assert.ok(
    !temp_base.endsWith(".tmp"),
    "extensionless temporary names should not include trailing .tmp",
  );
});
