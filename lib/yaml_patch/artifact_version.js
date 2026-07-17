"use strict";

const crypto = require("node:crypto");

const { Yaml_patch_error, is_yaml_patch_error } = require("./error");

const ARTIFACT_VERSION = Object.freeze({
  envelope: Object.freeze([1, 2]),
  query: Object.freeze([1, 2]),
  operation: Object.freeze([1, 2]),
  transaction: Object.freeze([1]),
  profile: Object.freeze([1]),
  manifest: Object.freeze([1, 2]),
  proof: Object.freeze([1, 2]),
  structured_diff: Object.freeze([1]),
  cursor: Object.freeze([1]),
  locator: Object.freeze([1, 2]),
  journal: Object.freeze([1]),
  migration: Object.freeze([1]),
});

function artifact_detail_value(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") return value.toString();
  return typeof value;
}

function validate_artifact_version(kind, version) {
  const supported_versions =
    typeof kind === "string" && Object.hasOwn(ARTIFACT_VERSION, kind)
      ? ARTIFACT_VERSION[kind]
      : null;
  if (
    !supported_versions ||
    !Number.isInteger(version) ||
    !supported_versions.includes(version)
  ) {
    throw new Yaml_patch_error(
      "PROTOCOL_VERSION_UNSUPPORTED",
      "Unsupported artifact kind or version",
      {
        recoverable: false,
        next_action: "use a version reported by yaml_patch capabilities",
        details: {
          kind: artifact_detail_value(kind),
          version: artifact_detail_value(version),
          supported_versions: supported_versions
            ? Array.from(supported_versions)
            : [],
        },
      },
    );
  }
  return version;
}

function canonicalization_error(path, value, reason) {
  const value_type = value === null ? "null" : typeof value;
  return new Yaml_patch_error(
    "VALIDATION_FAILED",
    `Cannot canonicalize JSON value at ${path}: ${reason}`,
    {
      details: { path, value_type, reason },
      next_action: "provide only finite, acyclic JSON values",
    },
  );
}

function canonical_property_value(value, property, path) {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) {
    throw canonicalization_error(
      path,
      value,
      "accessor properties are not JSON data",
    );
  }
  return descriptor.value;
}

function canonical_json_value(value, path, ancestors) {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw canonicalization_error(path, value, "number must be finite");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw canonicalization_error(
      path,
      value,
      `${typeof value} is not a JSON value`,
    );
  }
  if (ancestors.has(value)) {
    throw canonicalization_error(path, value, "cycle detected");
  }

  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw canonicalization_error(path, value, "object must be a plain object");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${Array.from({ length: value.length }, (_entry, index) =>
        canonical_json_value(
          canonical_property_value(value, String(index), `${path}[${index}]`),
          `${path}[${index}]`,
          ancestors,
        ),
      ).join(",")}]`;
    }

    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        const encoded_key = JSON.stringify(key);
        const encoded_value = canonical_json_value(
          canonical_property_value(value, key, `${path}.${key}`),
          `${path}.${key}`,
          ancestors,
        );
        return `${encoded_key}:${encoded_value}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function canonical_json(value) {
  try {
    return canonical_json_value(value, "$", new WeakSet());
  } catch (error) {
    if (is_yaml_patch_error(error)) throw error;
    throw new Yaml_patch_error(
      "VALIDATION_FAILED",
      "Cannot canonicalize JSON value",
      {
        cause: error,
        details: {
          reason: error && error.message ? error.message : String(error),
        },
        next_action: "provide only finite, acyclic JSON values",
      },
    );
  }
}

function canonical_digest(value) {
  return crypto
    .createHash("sha256")
    .update(canonical_json(value), "utf8")
    .digest("hex");
}

module.exports = {
  ARTIFACT_VERSION,
  canonical_digest,
  canonical_json,
  validate_artifact_version,
};
