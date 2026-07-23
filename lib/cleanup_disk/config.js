"use strict";

const fs = require("fs/promises");
const YAML = require("yaml");

function merge_rule_list(base_rules, overlay_rules) {
  const by_id = new Map();

  for (const rule of base_rules || []) {
    if (!rule || !rule.id) {
      throw new Error("Each rule must have an id.");
    }
    by_id.set(rule.id, { ...rule });
  }

  for (const rule of overlay_rules || []) {
    if (!rule || !rule.id) {
      throw new Error("Each rule must have an id.");
    }
    const previous = by_id.get(rule.id) || {};
    by_id.set(rule.id, { ...previous, ...rule });
  }

  return Array.from(by_id.values());
}

async function read_config_file(file_path) {
  const text = await fs.readFile(file_path, "utf8");
  const parsed = YAML.parse(text);

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid config file: ${file_path}`);
  }

  if (parsed.version !== 1) {
    throw new Error(`Unsupported config version in ${file_path}: ${parsed.version}`);
  }

  if (!Array.isArray(parsed.rule)) {
    throw new Error(`Config rule must be an array in ${file_path}`);
  }

  return parsed;
}

async function path_exists(file_path) {
  try {
    await fs.access(file_path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function load_config({
  defaults_path,
  local_path = "",
  extra_path = "",
} = {}) {
  if (!defaults_path) {
    throw new Error("defaults_path is required.");
  }

  const defaults = await read_config_file(defaults_path);
  let rules = merge_rule_list([], defaults.rule);

  if (local_path && (await path_exists(local_path))) {
    const local = await read_config_file(local_path);
    rules = merge_rule_list(rules, local.rule);
  }

  if (extra_path) {
    const extra = await read_config_file(extra_path);
    rules = merge_rule_list(rules, extra.rule);
  }

  return {
    version: 1,
    rule: rules,
  };
}

module.exports = {
  load_config,
  merge_rule_list,
};
