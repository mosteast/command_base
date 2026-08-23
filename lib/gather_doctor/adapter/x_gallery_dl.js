"use strict";

const {
  status_result,
  worst_status,
  check_repo_command,
  chrome_check_for_platform,
  runtime_browser_patch,
} = require("./common");
const {
  check_gallery_dl,
  ensure_brew_package,
} = require("../brew_install");
const {
  cookies_file_has_hosts,
  export_netscape_cookies,
  run_command,
} = require("../cookie_export");
const { DEFAULT_GALLERY_DL_COOKIES, PLATFORM_PROBE_URLS } = require("../constants");
const {
  get_cookies_file,
} = require("../runtime_config");

async function check(context) {
  const checks = [];
  checks.push(await check_repo_command("xsave_gallery_dl"));
  const gallery = await check_gallery_dl(context.tool_options || {});
  checks.push({
    name: "gallery-dl",
    status: gallery.ok ? "ok" : "fail",
    message: gallery.message,
  });

  const chrome = chrome_check_for_platform("x_gallery_dl", context);
  checks.push(chrome.check);

  const runtime_cookies =
    get_cookies_file(context.runtime_data, "x_gallery_dl") ||
    DEFAULT_GALLERY_DL_COOKIES;
  const cookie_file_info = await cookies_file_has_hosts(
    runtime_cookies,
    "x_gallery_dl",
  );
  checks.push({
    name: "cookies_file",
    status: cookie_file_info.has_hosts ? "ok" : "fail",
    message: cookie_file_info.exists
      ? cookie_file_info.has_hosts
        ? `cookies file has x.com hosts: ${runtime_cookies}`
        : `cookies file missing x.com hosts: ${runtime_cookies}`
      : `cookies file missing: ${runtime_cookies}`,
  });

  let next_command = "";
  if (gallery.needs_install) next_command = "brew install gallery-dl";
  else if (gallery.needs_upgrade) next_command = "brew upgrade gallery-dl";
  else if (!cookie_file_info.has_hosts || chrome.check.status === "fail") {
    next_command = "gather_doctor fix --platform x_gallery_dl";
  }

  if (!context.offline && gallery.ok) {
    const probe_url =
      (context.probe_urls && context.probe_urls.x_gallery_dl) ||
      PLATFORM_PROBE_URLS.x_gallery_dl;
    const args = ["--simulate"];
    if (cookie_file_info.exists) {
      args.push("--cookies", runtime_cookies);
    }
    args.push(probe_url);
    const probe = await run_command("gallery-dl", args);
    const combined = `${probe.stdout}\n${probe.stderr}`;
    let probe_status = probe.ok ? "ok" : "fail";
    let probe_message = probe.ok
      ? "gallery-dl probe succeeded"
      : "gallery-dl probe failed";
    if (/login|cookie|unauthorized|403/i.test(combined)) {
      probe_status = "fail";
      probe_message = "gallery-dl auth/cookie challenge";
      next_command = "gather_doctor fix --platform x_gallery_dl";
    } else if (/429|rate.?limit/i.test(combined)) {
      probe_status = "warn";
      probe_message = "gallery-dl rate limited";
    }
    checks.push({
      name: "probe",
      status: probe_status,
      message: probe_message,
    });
  }

  return status_result({
    platform_key: "x_gallery_dl",
    status: worst_status(checks.map((item) => item.status)),
    checks,
    next_command,
    profile_matches: chrome.matches,
    selected_profile: chrome.selected,
  });
}

async function fix(context, diagnosis) {
  const actions = [];
  const gallery = await check_gallery_dl(context.tool_options || {});
  if (gallery.needs_install || gallery.needs_upgrade) {
    const brew_result = await ensure_brew_package({
      package_name: "gallery-dl",
      dry_run: context.dry_run,
      upgrade: Boolean(gallery.needs_upgrade && gallery.present),
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
    chrome_check_for_platform("x_gallery_dl", context).selected;
  if (!selected) {
    actions.push({
      type: "profile",
      ok: false,
      detail: "No Chrome profile with x.com cookies",
    });
    return { ok: false, actions, runtime_patch: null };
  }

  const cookies_file = DEFAULT_GALLERY_DL_COOKIES;
  const export_result = await export_netscape_cookies({
    chrome_profile: selected.directory,
    output_path: cookies_file,
    platform_key: "x_gallery_dl",
    dry_run: context.dry_run,
  });
  actions.push({
    type: "cookie_export",
    ok: export_result.ok,
    detail: `export cookies -> ${cookies_file}`,
    error: export_result.error || "",
  });
  if (!export_result.ok && !context.dry_run) {
    return { ok: false, actions, runtime_patch: null };
  }

  const runtime_patch = {
    ...runtime_browser_patch(selected),
    cookies_file,
  };
  actions.push({
    type: "runtime",
    ok: true,
    detail: `map x_gallery_dl cookies_file -> ${cookies_file}`,
  });
  return { ok: true, actions, runtime_patch };
}

module.exports = {
  platform_key: "x_gallery_dl",
  check,
  fix,
};
