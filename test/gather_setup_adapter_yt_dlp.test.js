import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it, expect, vi } from "vitest";

const youtube = require("../lib/gather_setup/adapter/youtube");
const bilibili = require("../lib/gather_setup/adapter/bilibili");
const brew_install = require("../lib/gather_setup/brew_install");
const cookie_export = require("../lib/gather_setup/cookie_export");

describe("gather_setup yt-dlp adapters", () => {
  it("youtube check fails when yt-dlp is missing", async () => {
    vi.spyOn(brew_install, "check_yt_dlp").mockResolvedValue({
      ok: false,
      present: false,
      message: "yt-dlp not found on PATH",
      needs_install: true,
    });
    vi.spyOn(brew_install, "which_command").mockResolvedValue("");
    vi.spyOn(cookie_export, "run_command").mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "",
    });

    const result = await youtube.check({
      offline: true,
      chrome_scans: [],
    });
    expect(result.platform_key).toBe("youtube");
    expect(result.status).toBe("fail");
    expect(
      result.next_command === "brew install yt-dlp" ||
        result.checks.some(
          (item) => item.name === "yt-dlp" && item.status === "fail",
        ),
    ).toBe(true);
    vi.restoreAllMocks();
  });

  it("bilibili setup writes runtime chrome profile mapping", async () => {
    vi.spyOn(brew_install, "check_yt_dlp").mockResolvedValue({
      ok: true,
      present: true,
      needs_install: false,
      message: "yt-dlp present",
    });
    const result = await bilibili.setup(
      { dry_run: true, chrome_scans: [] },
      {
        selected_profile: {
          directory: "Profile 2",
          name: "Work",
          active_time: 10,
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.runtime_patch.cookies_from_browser).toBe("chrome:Profile 2");
    vi.restoreAllMocks();
  });
});

describe("gather_setup version helpers", () => {
  it("detects gallery-dl versions below the minimum", () => {
    expect(brew_install.version_is_less_than("1.31.2", "1.31.10")).toBe(true);
    expect(brew_install.version_is_less_than("1.31.10", "1.31.10")).toBe(false);
    expect(brew_install.version_is_less_than("1.32.0", "1.31.10")).toBe(false);
  });
});
