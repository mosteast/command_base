"use strict";

const brew_install = require("../brew_install");
const {
  profiles_with_platform_hosts,
  pick_best_profile,
} = require("../chrome_profile");
const { browser_spec_for_profile } = require("../cookie_export");

function status_result({
  platform_key,
  status,
  checks = [],
  next_command = "",
  detail = "",
  profile_matches = [],
  selected_profile = null,
}) {
  return {
    platform_key,
    status,
    checks,
    next_command,
    detail,
    profile_matches,
    selected_profile,
  };
}

function worst_status(statuses) {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  return "ok";
}

async function check_repo_command(command_name) {
  const resolved = await brew_install.which_command(command_name);
  if (!resolved) {
    return {
      name: command_name,
      status: "fail",
      message: `${command_name} not found on PATH`,
    };
  }
  return {
    name: command_name,
    status: "ok",
    message: `${command_name} -> ${resolved}`,
  };
}

function attach_chrome_matches(context, platform_key) {
  const matches = profiles_with_platform_hosts(
    context.chrome_scans || [],
    platform_key,
  );
  const selected = pick_best_profile(matches);
  return { matches, selected };
}

function chrome_check_for_platform(platform_key, context) {
  const { matches, selected } = attach_chrome_matches(context, platform_key);
  if (matches.length === 0) {
    return {
      check: {
        name: "chrome_cookies",
        status: "fail",
        message: `No Chrome profile has cookies for ${platform_key}`,
      },
      matches,
      selected,
      next_command: `gather doctor fix --platform ${platform_key}`,
    };
  }
  return {
    check: {
      name: "chrome_cookies",
      status: "ok",
      message: `Chrome profile ${selected.directory} (${selected.name}) has ${platform_key} cookies`,
    },
    matches,
    selected,
    next_command: "",
  };
}

function runtime_browser_patch(selected_profile) {
  if (!selected_profile) return {};
  return {
    chrome_profile: selected_profile.directory,
    cookies_from_browser: browser_spec_for_profile(selected_profile.directory),
  };
}

module.exports = {
  status_result,
  worst_status,
  check_repo_command,
  attach_chrome_matches,
  chrome_check_for_platform,
  runtime_browser_patch,
};
