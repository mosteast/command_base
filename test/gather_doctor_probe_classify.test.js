import { describe, it, expect, vi } from "vitest";

const {
  classify_yt_dlp_probe,
  classify_gallery_dl_probe,
} = require("../lib/gather_doctor/probe_classify");
const bilibili = require("../lib/gather_doctor/adapter/bilibili");
const x_gallery_dl = require("../lib/gather_doctor/adapter/x_gallery_dl");
const brew_install = require("../lib/gather_doctor/brew_install");
const cookie_export = require("../lib/gather_doctor/cookie_export");
const { load_probe_urls_from_config } = require("../lib/gather_doctor/check_runner");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const YAML = require("yaml");

describe("gather_doctor probe_classify", () => {
  it("does not treat cookie extraction logs as auth failure", () => {
    const classified = classify_yt_dlp_probe(
      [
        "Extracting cookies from chrome",
        "Extracted 42 cookies from chrome",
        "ERROR: [BiliBili] BV1xx: Unable to download webpage: HTTP Error 412: Precondition Failed",
      ].join("\n"),
      { ok: false },
    );
    expect(classified.reason).toBe("blocked");
    expect(classified.status).toBe("warn");
    expect(classified.message).toMatch(/412/);
    expect(classified.message).not.toMatch(/auth\/cookie/i);
  });

  it("detects youtube-style auth challenges", () => {
    const classified = classify_yt_dlp_probe(
      "ERROR: Sign in to confirm you’re not a bot",
      { ok: false },
    );
    expect(classified.reason).toBe("auth");
    expect(classified.status).toBe("fail");
  });

  it("treats unsupported gallery-dl URL as warn not auth", () => {
    const classified = classify_gallery_dl_probe(
      "[twitter][error] Unsupported URL 'https://x.com/'",
      { ok: false },
    );
    expect(classified.reason).toBe("bad_url");
    expect(classified.status).toBe("warn");
    expect(classified.message).not.toMatch(/auth\/cookie/i);
  });
});

describe("gather_doctor probe url loading", () => {
  it("normalizes bare x handles to profile URLs", async () => {
    const temp_root = await fs.mkdtemp(
      path.join(os.tmpdir(), "gather-doctor-probe-url-"),
    );
    const config_path = path.join(temp_root, "gather.config.yaml");
    await fs.writeFile(
      config_path,
      YAML.stringify({
        source: {
          x_gallery_dl: [{ handle: "LiuZhongjing" }],
        },
      }),
      "utf8",
    );
    const loaded = await load_probe_urls_from_config(config_path, {
      debug() {},
    });
    expect(loaded.ok).toBe(true);
    expect(loaded.probe_urls.x_gallery_dl).toBe("https://x.com/LiuZhongjing");
  });
});

describe("gather_doctor adapter probe classification", () => {
  it("bilibili probe maps HTTP 412 to warn without auth next_command", async () => {
    vi.spyOn(brew_install, "check_yt_dlp").mockResolvedValue({
      ok: true,
      present: true,
      needs_install: false,
      message: "yt-dlp present",
    });
    vi.spyOn(brew_install, "which_command").mockResolvedValue(
      "/tmp/xsave_yt_dlp",
    );
    vi.spyOn(cookie_export, "run_command").mockResolvedValue({
      ok: false,
      stdout: "Extracting cookies from chrome\nExtracted 10 cookies from chrome\n",
      stderr:
        "ERROR: [BiliBili] BV1xx: Unable to download webpage: HTTP Error 412: Precondition Failed\n",
    });

    const result = await bilibili.check({
      offline: false,
      chrome_scans: [
        {
          ok: true,
          directory: "Default",
          name: "Default",
          active_time: 1,
          hosts: ["bilibili.com"],
        },
      ],
    });
    const probe = result.checks.find((item) => item.name === "probe");
    expect(probe.status).toBe("warn");
    expect(probe.message).toMatch(/412/);
    expect(result.next_command).not.toMatch(/fix --platform bilibili/);
    vi.restoreAllMocks();
  });

  it("gallery-dl uses profile probe URL and classifies unsupported site root", async () => {
    const temp_root = await fs.mkdtemp(
      path.join(os.tmpdir(), "gather-doctor-gallery-probe-"),
    );
    const cookies_file = path.join(temp_root, "cookies.txt");
    await fs.writeFile(
      cookies_file,
      "# Netscape\n.x.com\tTRUE\t/\tFALSE\t0\tauth_token\tvalue\n",
      "utf8",
    );

    vi.spyOn(brew_install, "which_command").mockImplementation(async (name) =>
      name === "xsave_gallery_dl" ? "/tmp/xsave_gallery_dl" : "",
    );
    vi.spyOn(brew_install, "check_gallery_dl").mockResolvedValue({
      ok: true,
      present: true,
      version: "1.31.10",
      message: "gallery-dl 1.31.10",
      needs_install: false,
      needs_upgrade: false,
    });
    vi.spyOn(cookie_export, "run_command").mockImplementation(
      async (command, args) => {
        expect(command).toBe("gallery-dl");
        expect(args).toEqual(
          expect.arrayContaining(["--simulate", "--no-input", "--range", "1", "--post-range", "1"]),
        );
        expect(args.at(-1)).toBe("https://x.com/X");
        return {
          ok: false,
          stdout: "",
          stderr: "[twitter][error] Unsupported URL 'https://x.com/'\n",
        };
      },
    );

    const result = await x_gallery_dl.check({
      offline: false,
      runtime_data: {
        platform: {
          x_gallery_dl: { cookies_file },
        },
      },
      chrome_scans: [
        {
          ok: true,
          directory: "Default",
          name: "Default",
          active_time: 1,
          hosts: ["x.com"],
        },
      ],
    });
    const probe = result.checks.find((item) => item.name === "probe");
    expect(probe.status).toBe("warn");
    expect(probe.message).toMatch(/unsupported/i);
    expect(probe.message).not.toMatch(/auth\/cookie/i);
    vi.restoreAllMocks();
  });
});
