const util = require("util");

function normalize_error_text(value) {
  if (value === undefined || value === null) return "";

  const text =
    typeof value === "string" ? value.trim() : String(value || "").trim();

  if (!text) return "";
  if (text === "[object Object]") return "";
  if (text === "{}") return "";
  if (text === "[]") return "";

  return text;
}

function inspect_error_object(error) {
  if (!error || typeof error !== "object") return "";

  return normalize_error_text(
    util.inspect(error, {
      depth: 2,
      breakLength: 120,
      maxArrayLength: 20,
      maxStringLength: 1000,
    }),
  );
}

function has_meaningful_error_detail(value, seen = new Set(), depth = 0) {
  if (value === undefined || value === null) return false;

  if (typeof value === "string") {
    return Boolean(normalize_error_text(value));
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (typeof value !== "object") {
    return Boolean(normalize_error_text(value));
  }

  if (seen.has(value) || depth > 2) {
    return false;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) =>
      has_meaningful_error_detail(item, seen, depth + 1),
    );
  }

  return Object.values(value).some((item) =>
    has_meaningful_error_detail(item, seen, depth + 1),
  );
}

function resolve_error_message(error, fallback = "Unknown error") {
  if (!error) return fallback;

  if (typeof error === "string") {
    return normalize_error_text(error) || fallback;
  }

  const candidates = [
    error.stderr,
    error.stdout,
    error.message,
    error.shortMessage,
    error.cause && error.cause.stderr,
    error.cause && error.cause.stdout,
    error.cause && error.cause.message,
    error.originalError && error.originalError.stderr,
    error.originalError && error.originalError.stdout,
    error.originalError && error.originalError.message,
  ];

  for (const candidate of candidates) {
    const normalized = normalize_error_text(candidate);
    if (normalized) {
      return normalized;
    }
  }

  const inspected = inspect_error_object(error);
  if (inspected && has_meaningful_error_detail(error)) {
    return inspected;
  }

  return fallback;
}

function format_stage_failure_message(stage_label, display_path, detail) {
  const normalized_stage = normalize_error_text(stage_label) || "Step";
  const normalized_path = normalize_error_text(display_path);
  const normalized_detail = normalize_error_text(detail) || "Unknown error";
  const path_segment = normalized_path ? ` for ${normalized_path}` : "";

  return `${normalized_stage} failed${path_segment}: ${normalized_detail}`;
}

module.exports = {
  format_stage_failure_message,
  normalize_error_text,
  resolve_error_message,
};
