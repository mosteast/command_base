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
const { check_f2 } = require("../brew_install");
const cookie_export = require("../cookie_export");
const {
  export_netscape_cookies,
  netscape_to_cookie_header,
} = cookie_export;
const {
  read_f2_cookie_presence,
  write_f2_cookie,
  resolve_f2_app_config_path,
} = require("../f2_config");
const { get_platform_runtime } = require("../runtime_config");
const { PLATFORM_PROBE_URLS } = require("../constants");
const {
  is_douyin_user_probe_url,
  run_douyin_api_probe,
} = require("../f2_douyin_probe");

function create_f2_adapter(platform_key, f2_app_arg) {
  async function check(context) {
    const checks = [];
    checks.push(await check_repo_command("f2_compat"));
    const f2 = await check_f2(context.tool_options || {});
    checks.push({
      name: "f2",
      status: f2.ok ? "ok" : "fail",
      message: f2.message,
    });

    const chrome = chrome_check_for_platform(platform_key, context);
    checks.push(chrome.check);

    const cookie_info = await read_f2_cookie_presence(
      platform_key,
      context.f2_options || {},
    );
    checks.push({
      name: "f2_cookie",
      status: cookie_info.present ? "ok" : "fail",
      message: cookie_info.present
        ? `f2 ${platform_key} cookie present in ${cookie_info.config_path}`
        : `f2 ${platform_key} cookie missing in ${cookie_info.config_path}`,
    });

    let next_command = "";
    let detail = "";
    if (!f2.present) next_command = f2.fix;
    else if (!cookie_info.present || chrome.check.status === "fail") {
      next_command = `gather doctor fix --platform ${platform_key}`;
    }

    if (!context.offline && f2.ok) {
      if (platform_key === "douyin") {
        const probe_url =
          (context.probe_urls && context.probe_urls.douyin) ||
          PLATFORM_PROBE_URLS.douyin;
        if (!is_douyin_user_probe_url(probe_url)) {
          detail = "No Douyin user URL available for API probe";
          checks.push({
            name: "probe",
            status: "warn",
            message: detail,
          });
        } else {
          const runtime_entry = get_platform_runtime(
            context.runtime_data,
            platform_key,
          );
          const classified = await run_douyin_api_probe({
            f2_path: f2.path || "f2",
            url: probe_url,
            f2_config_path: (context.f2_options || {}).f2_config_path,
            chrome_profile:
              (runtime_entry && runtime_entry.chrome_profile) ||
              (chrome.selected &&
                (chrome.selected.name || chrome.selected.directory)) ||
              "",
          });
          detail = classified.detail;
          if (classified.next_command) next_command = classified.next_command;
          checks.push({
            name: "probe",
            status: classified.status,
            message: classified.detail,
          });
        }
      } else {
        const probe = await cookie_export.run_command(f2.path || "f2", [
          f2_app_arg,
          "-h",
        ]);
        const help_text = `${probe.stdout}\n${probe.stderr}`;
        const help_ok = probe.ok || /使用方法|Usage|mode/i.test(help_text);
        checks.push({
          name: "probe",
          status: help_ok ? "ok" : "warn",
          message: help_ok
            ? `f2 ${f2_app_arg} help reachable`
            : `f2 ${f2_app_arg} probe failed`,
        });
      }
    }

    return status_result({
      platform_key,
      status: worst_status(checks.map((item) => item.status)),
      checks,
      next_command,
      detail,
      profile_matches: chrome.matches,
      selected_profile: chrome.selected,
    });
  }

  async function fix(context, diagnosis) {
    const actions = [];
    const f2 = await check_f2(context.tool_options || {});
    if (!f2.present) {
      actions.push({
        type: "install",
        ok: false,
        detail: f2.fix,
        error: f2.message,
      });
      return { ok: false, actions, runtime_patch: null };
    }

    const selected =
      (diagnosis && diagnosis.selected_profile) ||
      chrome_check_for_platform(platform_key, context).selected;
    if (!selected) {
      actions.push({
        type: "profile",
        ok: false,
        detail: `No Chrome profile with cookies for ${platform_key}`,
      });
      return { ok: false, actions, runtime_patch: null };
    }

    const temp_cookies = path.join(
      os.tmpdir(),
      `gather_doctor_${platform_key}_cookies.txt`,
    );
    const export_result = await export_netscape_cookies({
      chrome_profile: selected.directory,
      output_path: temp_cookies,
      platform_key,
      dry_run: context.dry_run,
    });
    actions.push({
      type: "cookie_export",
      ok: export_result.ok,
      detail: `export ${platform_key} cookies via yt-dlp`,
      error: export_result.error || "",
    });
    if (!export_result.ok && !context.dry_run) {
      return { ok: false, actions, runtime_patch: null };
    }

    let cookie_header = "";
    if (!context.dry_run) {
      cookie_header = await netscape_to_cookie_header(
        temp_cookies,
        platform_key,
      );
      try {
        await fs.unlink(temp_cookies);
      } catch (_error) {
        // ignore
      }
      if (!cookie_header) {
        actions.push({
          type: "cookie_convert",
          ok: false,
          detail: "Netscape export had no matching hosts",
        });
        return { ok: false, actions, runtime_patch: null };
      }
    }

    const write_result = await write_f2_cookie(platform_key, cookie_header, {
      ...(context.f2_options || {}),
      dry_run: context.dry_run,
    });
    actions.push({
      type: "f2_config",
      ok: write_result.ok,
      detail: `write f2 cookie -> ${write_result.config_path}`,
      error: write_result.error || "",
    });
    if (!write_result.ok && !context.dry_run) {
      return { ok: false, actions, runtime_patch: null };
    }

    const f2_config = await resolve_f2_app_config_path(context.f2_options || {});
    const runtime_patch = {
      ...runtime_browser_patch(selected),
      f2_config,
    };
    actions.push({
      type: "runtime",
      ok: true,
      detail: `map ${platform_key} -> ${selected.directory}`,
    });
    return { ok: true, actions, runtime_patch };
  }

  return { platform_key, check, fix };
}

module.exports = {
  douyin: create_f2_adapter("douyin", "dy"),
  x_f2: create_f2_adapter("x_f2", "x"),
  create_f2_adapter,
};
