"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const {
  status_result,
  worst_status,
  check_repo_command,
  chrome_check_for_platform,
  runtime_browser_patch,
} = require("./common");
const cookie_export = require("../cookie_export");
const { PLATFORM_PROBE_URLS } = require("../constants");

async function check(context) {
  const checks = [];
  checks.push(await check_repo_command("xsave_instagram"));
  const chrome = chrome_check_for_platform("instagram", context);
  checks.push(chrome.check);
  let next_command = "";
  if (checks.some((entry) => entry.status === "fail"))
    next_command = "gather doctor fix --platform instagram";
  if (!context.offline && chrome.selected) {
    checks.push({
      name: "probe",
      status: "ok",
      message: `probe url ${
        (context.probe_urls && context.probe_urls.instagram) ||
        PLATFORM_PROBE_URLS.instagram
      }`,
    });
  }
  return status_result({
    platform_key: "instagram",
    status: worst_status(checks.map((entry) => entry.status)),
    checks,
    next_command,
    selected_profile: chrome.selected,
    profile_matches: chrome.matches,
  });
}

async function fix(context, diagnosis) {
  const actions = [];
  const selected =
    (context && context.selected_profile) ||
    (diagnosis && diagnosis.selected_profile) ||
    chrome_check_for_platform("instagram", context).selected;
  if (!selected) {
    actions.push({
      type: "profile",
      ok: false,
      detail: "No Chrome profile with cookies for instagram",
    });
    return { ok: false, actions, runtime_patch: null };
  }
  const temp_cookies = path.join(
    os.tmpdir(),
    "gather_doctor_instagram_cookies.txt",
  );
  const export_result = await cookie_export.export_netscape_cookies({
    chrome_profile: selected.directory,
    output_path: temp_cookies,
    platform_key: "instagram",
    dry_run: context && context.dry_run,
  });
  actions.push({
    type: "cookie_export",
    ok: export_result.ok,
    detail: "export instagram cookies via yt-dlp",
    error: export_result.error || "",
  });
  if (!export_result.ok && !(context && context.dry_run))
    return { ok: false, actions, runtime_patch: null };
  if (!(context && context.dry_run)) {
    const header = await cookie_export.netscape_to_cookie_header(
      temp_cookies,
      "instagram",
    );
    try {
      await fs.unlink(temp_cookies);
    } catch (_error) {
      /* ignore */
    }
    if (!header) {
      actions.push({
        type: "cookie_convert",
        ok: false,
        detail: "Netscape export had no matching hosts",
      });
      return { ok: false, actions, runtime_patch: null };
    }
  }
  const runtime_patch = runtime_browser_patch(selected);
  actions.push({
    type: "runtime",
    ok: true,
    detail: `map instagram -> ${selected.directory}`,
  });
  return { ok: true, actions, runtime_patch };
}

module.exports = {
  platform_key: "instagram",
  check,
  fix,
};
