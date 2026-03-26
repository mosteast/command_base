const crypto = require("crypto");
const path = require("path");

const MAX_FILE_NAME_BYTES = 255;

function count_utf8_bytes(value) {
  return Buffer.byteLength(`${value ?? ""}`, "utf8");
}

function truncate_utf8_to_bytes(value, max_bytes) {
  const normalized = `${value ?? ""}`;
  if (!normalized || max_bytes <= 0) {
    return "";
  }
  if (count_utf8_bytes(normalized) <= max_bytes) {
    return normalized;
  }

  let truncated = "";
  let used_bytes = 0;
  for (const character of normalized) {
    const character_bytes = count_utf8_bytes(character);
    if (used_bytes + character_bytes > max_bytes) {
      break;
    }
    truncated += character;
    used_bytes += character_bytes;
  }
  return truncated;
}

function build_bounded_stem(options = {}) {
  const {
    stem = "",
    suffix = "",
    extension = "",
    max_bytes = MAX_FILE_NAME_BYTES,
  } = options;
  const fixed_suffix = `${suffix ?? ""}${extension ?? ""}`;
  const fixed_bytes = count_utf8_bytes(fixed_suffix);
  if (fixed_bytes > max_bytes) {
    throw new Error(
      `Filename suffix exceeds ${max_bytes} bytes: ${fixed_suffix}`,
    );
  }
  return truncate_utf8_to_bytes(`${stem ?? ""}`, max_bytes - fixed_bytes);
}

function build_bounded_file_name(options = {}) {
  const {
    stem = "",
    suffix = "",
    extension = "",
    max_bytes = MAX_FILE_NAME_BYTES,
  } = options;
  const bounded_stem = build_bounded_stem({
    stem,
    suffix,
    extension,
    max_bytes,
  });
  return `${bounded_stem}${suffix ?? ""}${extension ?? ""}`;
}

function build_bounded_output_path(options = {}) {
  const {
    directory = "",
    stem = "",
    suffix = "",
    extension = "",
    max_bytes = MAX_FILE_NAME_BYTES,
  } = options;
  return path.join(
    directory,
    build_bounded_file_name({
      stem,
      suffix,
      extension,
      max_bytes,
    }),
  );
}

function limit_output_path_length(target_path, options = {}) {
  const { suffix = "", max_bytes = MAX_FILE_NAME_BYTES } = options;
  const resolved_path = path.resolve(target_path);
  const parsed_path = path.parse(resolved_path);
  return build_bounded_output_path({
    directory: parsed_path.dir,
    stem: parsed_path.name,
    suffix,
    extension: parsed_path.ext,
    max_bytes,
  });
}

function build_temporary_artifact_reference(target_path, options = {}) {
  const resolved_path = path.resolve(target_path);
  const directory = path.dirname(resolved_path);
  const extension =
    options.include_extension === false ? "" : path.extname(resolved_path);
  const raw_label = `${options.label || "tmp"}`;
  const safe_label =
    raw_label.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "tmp";
  const unique_suffix = `${process.pid.toString(36)}-${Date.now().toString(
    36,
  )}-${Math.random().toString(36).slice(2, 8)}`;
  const digest = crypto
    .createHash("sha1")
    .update(resolved_path)
    .digest("hex")
    .slice(0, 10);
  return {
    directory,
    extension,
    name_prefix: `__in_progress-${safe_label}-${digest}-`,
    unique_suffix,
  };
}

function create_short_temporary_output_path(final_path, options = {}) {
  const { directory, extension, name_prefix, unique_suffix } =
    build_temporary_artifact_reference(final_path, options);
  return build_bounded_output_path({
    directory,
    stem: `${name_prefix}${unique_suffix}`,
    extension,
  });
}

module.exports = {
  MAX_FILE_NAME_BYTES,
  build_bounded_file_name,
  build_bounded_output_path,
  build_bounded_stem,
  build_temporary_artifact_reference,
  count_utf8_bytes,
  create_short_temporary_output_path,
  limit_output_path_length,
  truncate_utf8_to_bytes,
};
