"use strict";

const crypto = require("node:crypto");
const { types } = require("node:util");

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

function canonical_object_entries(value, path, sort_keys = true) {
  const entries = Reflect.ownKeys(value).map((property) => {
    if (typeof property !== "string") {
      throw canonicalization_error(
        path,
        value,
        "symbol properties are not JSON data",
      );
    }
    const property_path = `${path}.${property}`;
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw canonicalization_error(
        property_path,
        value,
        "accessor properties are not JSON data",
      );
    }
    if (!descriptor.enumerable) {
      throw canonicalization_error(
        property_path,
        value,
        "non-enumerable properties are not JSON data",
      );
    }
    return [property, descriptor.value];
  });
  return sort_keys
    ? entries.sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )
    : entries;
}

function canonical_array_values(value, path) {
  const own_properties = Reflect.ownKeys(value);
  let expected_index = 0;
  for (const property of own_properties) {
    if (property === "length") continue;
    if (typeof property !== "string") {
      throw canonicalization_error(
        path,
        value,
        "array symbol properties are not JSON data",
      );
    }
    const index = Number(property);
    const is_array_index =
      /^(0|[1-9]\d*)$/.test(property) &&
      Number.isSafeInteger(index) &&
      index >= 0 &&
      index < value.length;
    if (!is_array_index) {
      throw canonicalization_error(
        `${path}.${property}`,
        value,
        "extra array properties are not JSON data",
      );
    }
    if (index !== expected_index) {
      throw canonicalization_error(
        `${path}[${expected_index}]`,
        value,
        "sparse arrays are not JSON data",
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw canonicalization_error(
        `${path}[${index}]`,
        value,
        "array accessor properties are not JSON data",
      );
    }
    if (!descriptor.enumerable) {
      throw canonicalization_error(
        `${path}[${index}]`,
        value,
        "non-enumerable array items are not JSON data",
      );
    }
    expected_index += 1;
  }
  if (expected_index !== value.length) {
    throw canonicalization_error(
      `${path}[${expected_index}]`,
      value,
      "sparse arrays are not JSON data",
    );
  }
  const values = [];
  for (let index = 0; index < expected_index; index += 1) {
    values.push(
      canonical_property_value(value, String(index), `${path}[${index}]`),
    );
  }
  return values;
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
  if (types.isProxy(value)) {
    throw canonicalization_error(path, value, "Proxy values are not JSON data");
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
      return `[${canonical_array_values(value, path)
        .map((entry, index) =>
          canonical_json_value(entry, `${path}[${index}]`, ancestors),
        )
        .join(",")}]`;
    }

    return `{${canonical_object_entries(value, path)
      .map(([key, entry]) => {
        const encoded_key = JSON.stringify(key);
        const encoded_value = canonical_json_value(
          entry,
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

function clone_json_value_internal(value, path, ancestors) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw canonicalization_error(path, value, "number must be finite");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw canonicalization_error(
      path,
      value,
      `${typeof value} is not a JSON value`,
    );
  }
  if (types.isProxy(value)) {
    throw canonicalization_error(path, value, "Proxy values are not JSON data");
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
      return canonical_array_values(value, path).map((entry, index) =>
        clone_json_value_internal(entry, `${path}[${index}]`, ancestors),
      );
    }

    const cloned = {};
    for (const [key, entry] of canonical_object_entries(value, path, false)) {
      Object.defineProperty(cloned, key, {
        value: clone_json_value_internal(entry, `${path}.${key}`, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return cloned;
  } finally {
    ancestors.delete(value);
  }
}

function clone_json_value(value, label = "$") {
  const path = typeof label === "string" && label.length > 0 ? label : "$";
  try {
    return clone_json_value_internal(value, path, new WeakSet());
  } catch (error) {
    if (is_yaml_patch_error(error)) throw error;
    throw new Yaml_patch_error("VALIDATION_FAILED", "Cannot clone JSON value", {
      cause: error,
      details: {
        reason: error && error.message ? error.message : String(error),
      },
      next_action: "provide only finite, acyclic JSON values",
    });
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
  clone_json_value,
  validate_artifact_version,
};
