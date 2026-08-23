"use strict";

const constants = require("./constants");
const platform = require("./platform");
const runtime_config = require("./runtime_config");
const chrome_profile = require("./chrome_profile");
const cookie_export = require("./cookie_export");
const brew_install = require("./brew_install");
const f2_config = require("./f2_config");
const check_runner = require("./check_runner");
const fix_runner = require("./fix_runner");
const adapters = require("./adapter");

module.exports = {
  ...constants,
  ...platform,
  ...runtime_config,
  chrome_profile,
  cookie_export,
  brew_install,
  f2_config,
  check_runner,
  fix_runner,
  adapters,
  get_cookies_from_browser: runtime_config.get_cookies_from_browser,
  get_cookies_file: runtime_config.get_cookies_file,
  read_runtime_config: runtime_config.read_runtime_config,
};
