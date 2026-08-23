"use strict";

const {
  status_result,
  worst_status,
  check_repo_command,
  chrome_check_for_platform,
  runtime_browser_patch,
} = require("./common");
const brew_install = require("../brew_install");
const cookie_export = require("../cookie_export");
const { PLATFORM_PROBE_URLS } = require("../constants");
const { classify_yt_dlp_probe } = require("../probe_classify");

async function check(context) {
  const checks = [];
  const repo = await check_repo_command("xsave_yt_dlp");
  checks.push(repo);
  const yt = await brew_install.check_yt_dlp(context.tool_options || {});
  checks.push({
    name: "yt-dlp",
    status: yt.ok ? "ok" : "fail",
    message: yt.message,
  });
  const chrome = chrome_check_for_platform("youtube", context);
  checks.push(chrome.check);

  let next_command = "";
  if (!yt.present) next_command = "brew install yt-dlp";
  else if (chrome.check.status === "fail") next_command = chrome.next_command;

  if (!context.offline && yt.ok) {
    const browser_spec = chrome.selected
      ? cookie_export.browser_spec_for_profile(chrome.selected.directory)
      : "chrome";
    const probe_url =
      (context.probe_urls && context.probe_urls.youtube) ||
      PLATFORM_PROBE_URLS.youtube;
    const probe = await cookie_export.run_command("yt-dlp", [
      "--skip-download",
      "--no-warnings",
      "--cookies-from-browser",
      browser_spec,
      "--playlist-end",
      "1",
      probe_url,
    ]);
    const classified = classify_yt_dlp_probe(
      `${probe.stdout}\n${probe.stderr}`,
      { ok: probe.ok },
    );
    if (classified.reason === "auth")
      next_command = "gather_doctor fix --platform youtube";
    checks.push({
      name: "probe",
      status: classified.status,
      message: classified.message,
    });
  }

  return status_result({
    platform_key: "youtube",
    status: worst_status(checks.map((item) => item.status)),
    checks,
    next_command,
    profile_matches: chrome.matches,
    selected_profile: chrome.selected,
  });
}

async function fix(context, diagnosis) {
  const actions = [];
  const yt = await brew_install.check_yt_dlp(context.tool_options || {});
  if (yt.needs_install) {
    const brew_result = await brew_install.ensure_brew_package({
      package_name: "yt-dlp",
      dry_run: context.dry_run,
      upgrade: false,
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
    (chrome_check_for_platform("youtube", context).selected);
  if (!selected) {
    actions.push({
      type: "profile",
      ok: false,
      detail: "No Chrome profile with youtube cookies",
    });
    return { ok: false, actions, runtime_patch: null };
  }

  const runtime_patch = runtime_browser_patch(selected);
  actions.push({
    type: "runtime",
    ok: true,
    detail: `map youtube -> ${runtime_patch.cookies_from_browser}`,
  });
  return { ok: true, actions, runtime_patch };
}

module.exports = {
  platform_key: "youtube",
  check,
  fix,
};
