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
const {
  export_netscape_cookies,
  netscape_to_cookie_header,
} = require("../cookie_export");
const {
  read_f2_cookie_presence,
  write_f2_cookie,
  resolve_f2_app_config_path,
} = require("../f2_config");
const { run_command } = require("../cookie_export");

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
    if (!f2.present) next_command = f2.fix;
    else if (!cookie_info.present || chrome.check.status === "fail") {
      next_command = `gather_doctor fix --platform ${platform_key}`;
    }

    if (!context.offline && f2.ok) {
      const probe = await run_command(f2.path || "f2", [f2_app_arg, "-h"]);
      checks.push({
        name: "probe",
        status: probe.ok || /使用方法|Usage|mode/i.test(`${probe.stdout}\n${probe.stderr}`)
          ? "ok"
          : "warn",
        message:
          probe.ok || /使用方法|Usage|mode/i.test(`${probe.stdout}\n${probe.stderr}`)
            ? `f2 ${f2_app_arg} help reachable`
            : `f2 ${f2_app_arg} probe failed`,
      });
    }

    return status_result({
      platform_key,
      status: worst_status(checks.map((item) => item.status)),
      checks,
      next_command,
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
