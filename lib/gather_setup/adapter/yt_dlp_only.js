"use strict";

const {
  status_result,
  worst_status,
  check_repo_command,
} = require("./common");
const { check_yt_dlp, ensure_brew_package } = require("../brew_install");
const { run_command } = require("../cookie_export");
const { PLATFORM_PROBE_URLS } = require("../constants");

function create_yt_dlp_only_adapter(platform_key) {
  async function check(context) {
    const checks = [];
    checks.push(await check_repo_command("xsave_yt_dlp"));
    const yt = await check_yt_dlp(context.tool_options || {});
    checks.push({
      name: "yt-dlp",
      status: yt.ok ? "ok" : "fail",
      message: yt.message,
    });

    let next_command = yt.present ? "" : "brew install yt-dlp";

    if (!context.offline && yt.ok) {
      const probe_url =
        (context.probe_urls && context.probe_urls[platform_key]) ||
        PLATFORM_PROBE_URLS[platform_key];
      const probe = await run_command("yt-dlp", [
        "--skip-download",
        "--no-warnings",
        "--playlist-end",
        "1",
        probe_url,
      ]);
      checks.push({
        name: "probe",
        status: probe.ok ? "ok" : "warn",
        message: probe.ok
          ? "yt-dlp probe succeeded"
          : "yt-dlp probe failed (browser cookies not injected for this platform in v1)",
      });
    }

    return status_result({
      platform_key,
      status: worst_status(checks.map((item) => item.status)),
      checks,
      next_command,
      profile_matches: [],
      selected_profile: null,
    });
  }

  async function setup(context) {
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
    actions.push({
      type: "note",
      ok: true,
      detail: `${platform_key}: v1 only ensures yt-dlp; no Chrome cookie injection`,
    });
    return { ok: true, actions, runtime_patch: {} };
  }

  return {
    platform_key,
    check,
    setup,
  };
}

module.exports = {
  rumble: create_yt_dlp_only_adapter("rumble"),
  bitchute: create_yt_dlp_only_adapter("bitchute"),
  create_yt_dlp_only_adapter,
};
