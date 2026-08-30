import { describe, expect, it, vi } from "vitest";

const { get_adapter } = require("../lib/gather_doctor/adapter");
const brew_install = require("../lib/gather_doctor/brew_install");
const cookie_export = require("../lib/gather_doctor/cookie_export");
const { PLATFORM_KEYS, HOST_PATTERNS } = require("../lib/gather_doctor/constants");

describe("gather_doctor instagram adapter", () => {
  it("is registered and uses instagram hosts", () => {
    expect(PLATFORM_KEYS).toContain("instagram");
    expect(HOST_PATTERNS.instagram).toEqual([
      "instagram.com",
      "cdninstagram.com",
    ]);
    expect(get_adapter("instagram").platform_key).toBe("instagram");
  });

  it("fails when xsave_instagram is missing and points at doctor fix", async () => {
    vi.spyOn(brew_install, "which_command").mockResolvedValue("");
    const adapter = get_adapter("instagram");
    const result = await adapter.check({
      offline: true,
      chrome_scans: [],
    });
    expect(result.status).toBe("fail");
    expect(result.next_command).toMatch(
      /gather doctor fix --platform instagram/,
    );
    expect(JSON.stringify(result)).not.toMatch(/sessionid=/i);
    vi.restoreAllMocks();
  });

  it("writes runtime chrome_profile on fix without an f2 cookie", async () => {
    const adapter = get_adapter("instagram");
    vi.spyOn(cookie_export, "export_netscape_cookies").mockResolvedValue({
      ok: true,
      output_path: "/tmp/ig-cookies.txt",
    });
    vi.spyOn(cookie_export, "netscape_to_cookie_header").mockResolvedValue(
      "sessionid=secret",
    );
    const result = await adapter.fix({
      dry_run: false,
      chrome_scans: [
        {
          ok: true,
          directory: "Profile 3",
          name: "Profile 3",
          active_time: 1,
          hosts: ["instagram.com"],
        },
      ],
      selected_profile: {
        directory: "Profile 3",
        name: "Profile 3",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.runtime_patch.chrome_profile).toBe("Profile 3");
    expect(JSON.stringify(result)).not.toMatch(/sessionid=secret/);
    expect(result.actions.every((action) => action.type !== "f2_config")).toBe(
      true,
    );
    vi.restoreAllMocks();
  });
});
