"use strict";

const cursor_provider = require("./provider/cursor_provider");
const { APP_KEY: CURSOR_KEY, backup, restore } = cursor_provider;

const REGISTRY = {
  [CURSOR_KEY]: {
    backup,
    restore,
    label: "cursor",
    manifest_name: cursor_provider.MANIFEST_NAME,
  },
};

function supported_apps() {
  return Object.keys(REGISTRY).sort();
}

function get_provider(app_name) {
  const key = String(app_name || "")
    .trim()
    .toLowerCase();
  const p = REGISTRY[key];
  if (!p) {
    const names = supported_apps().join(", ");
    throw new Error(`unknown app "${app_name}". Supported: ${names}`);
  }
  return { ...p, key };
}

module.exports = {
  get_provider,
  supported_apps,
  REGISTRY,
};
