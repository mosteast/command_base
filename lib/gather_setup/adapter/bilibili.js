"use strict";

const {
  status_result,
  worst_status,
  check_repo_command,
  chrome_check_for_platform,
  runtime_browser_patch,
} = require("./common");
const { check_yt_dlp, ensure_brew_package } = require("../brew_install");
const { run_command, browser_spec_for_profile } = require("../cookie_export");
const { PLATFORM_PROBE_URLS } = require("../constants");

async function check(context) {
  const checks = [];
  checks.push(await check_repo_command("xsave_yt_dlp"));
  const yt = await check_yt_dlp(context.tool_options || {});
  checks.push({
    name: "yt-dlp",
    status: yt.ok ? "ok" : "fail",
    message: yt.message,
  });
  const chrome = chrome_check_for_platform("bilibili", context);
  checks.push(chrome.check);

  let next_command = "";
  if (!yt.present) next_command = "brew install yt-dlp";
  else if (chrome.check.status === "fail") next_command = chrome.next_command;

  if (!context.offline && yt.ok) {
    const browser_spec = chrome.selected
      ? browser_spec_for_profile(chrome.selected.directory)
      : "chrome";
    const probe_url =
      (context.probe_urls && context.probe_urls.bilibili) ||
      PLATFORM_PROBE_URLS.bilibili;
    const probe = await run_command("yt-dlp", [
      "--skip-download",
      "--no-warnings",
      "--cookies-from-browser",
      browser_spec,
      "--playlist-end",
      "1",
      probe_url,
    ]);
    const combined = `${probe.stdout}\n${probe.stderr}`;
    let probe_status = probe.ok ? "ok" : "fail";
    let probe_message = probe.ok
      ? "yt-dlp probe succeeded"
      : "yt-dlp probe failed";
    if (/sign in|login|cookie/i.test(combined)) {
      probe_status = "fail";
      probe_message = "yt-dlp auth/cookie challenge";
      next_command = "gather_setup setup --platform bilibili";
    }
    checks.push({
      name: "probe",
      status: probe_status,
      message: probe_message,
    });
  }

  return status_result({
    platform_key: "bilibili",
    status: worst_status(checks.map((item) => item.status)),
    checks,
    next_command,
    profile_matches: chrome.matches,
    selected_profile: chrome.selected,
  });
}

async function setup(context, diagnosis) {
  const actions = [];
  const yt = await check_yt_dlp(context.tool_options || {});
  if (yt.needs_install) {
    const brew_result = await ensure_brew_package({
      package_name: "yt-dlp",
      dry_run: context.dry_run,
    });
    actions.push({
      type: "brew",
      ok: brew_result.ok,
      detail: brew_result.command.join(" "),
      error: brew_result.error || "",
    });
    if (!brew_result.ok && !context.dry_run) {
      return { ok: false, actions, runtime_patch: null };
    }
  }

  const selected =
    (diagnosis && diagnosis.selected_profile) ||
    chrome_check_for_platform("bilibili", context).selected;
  if (!selected) {
    actions.push({
      type: "profile",
      ok: false,
      detail: "No Chrome profile with bilibili cookies",
    });
    return { ok: false, actions, runtime_patch: null };
  }

  const runtime_patch = runtime_browser_patch(selected);
  actions.push({
    type: "runtime",
    ok: true,
    detail: `map bilibili -> ${runtime_patch.cookies_from_browser}`,
  });
  return { ok: true, actions, runtime_patch };
}

module.exports = {
  platform_key: "bilibili",
  check,
  setup,
};
