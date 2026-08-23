import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it, expect } from "vitest";

const {
  list_chrome_profiles,
  host_matches_patterns,
  profiles_with_platform_hosts,
  pick_best_profile,
  read_cookie_hosts,
} = require("../lib/gather_setup/chrome_profile");
const {
  parse_netscape_cookie_header,
} = require("../lib/gather_setup/cookie_export");

async function create_temp_dir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "gather-setup-chrome-"));
}

describe("gather_setup chrome_profile", () => {
  it("lists profiles from Local State ordered by active_time", async () => {
    const temp_root = await create_temp_dir();
    const local_state = {
      profile: {
        info_cache: {
          Default: { name: "Person 1", active_time: 10 },
          "Profile 2": { name: "Work", active_time: 50 },
        },
      },
    };
    await fs.writeFile(
      path.join(temp_root, "Local State"),
      JSON.stringify(local_state),
      "utf8",
    );
    await fs.mkdir(path.join(temp_root, "Default"), { recursive: true });
    await fs.mkdir(path.join(temp_root, "Profile 2"), { recursive: true });

    const listed = await list_chrome_profiles(temp_root);
    expect(listed.profiles.map((item) => item.directory)).toEqual([
      "Profile 2",
      "Default",
    ]);
  });

  it("matches platform hosts without exposing cookie values", () => {
    expect(host_matches_patterns(".youtube.com", ["youtube.com"])).toBe(true);
    expect(host_matches_patterns("api.x.com", ["x.com", "twitter.com"])).toBe(
      true,
    );
    const matches = profiles_with_platform_hosts(
      [
        {
          ok: true,
          directory: "Profile 1",
          name: "A",
          active_time: 1,
          hosts: [".youtube.com", "example.com"],
        },
        {
          ok: true,
          directory: "Default",
          name: "B",
          active_time: 9,
          hosts: ["x.com"],
        },
      ],
      "youtube",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].directory).toBe("Profile 1");
    expect(JSON.stringify(matches)).not.toMatch(/SID=|auth_token=/i);
    expect(pick_best_profile(matches).directory).toBe("Profile 1");
  });

  it("reports missing Cookies DB clearly", async () => {
    const temp_root = await create_temp_dir();
    const missing = path.join(temp_root, "Cookies");
    const result = await read_cookie_hosts(missing);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Cookies DB missing");
  });
});

describe("gather_setup cookie_export parsing", () => {
  it("builds cookie headers from netscape rows for matching hosts only", () => {
    const netscape = [
      "# Netscape HTTP Cookie File",
      ".youtube.com\tTRUE\t/\tFALSE\t0\tSID\tsecret-a",
      ".example.com\tTRUE\t/\tFALSE\t0\tOTHER\tsecret-b",
      ".x.com\tTRUE\t/\tFALSE\t0\tauth_token\tsecret-c",
      "",
    ].join("\n");
    const header = parse_netscape_cookie_header(netscape, [
      "youtube.com",
      "x.com",
    ]);
    expect(header).toContain("SID=secret-a");
    expect(header).toContain("auth_token=secret-c");
    expect(header).not.toContain("OTHER=");
  });
});
