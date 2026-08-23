import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it, expect, vi } from "vitest";

const x_gallery_dl = require("../lib/gather_doctor/adapter/x_gallery_dl");
const brew_install = require("../lib/gather_doctor/brew_install");
const cookie_export = require("../lib/gather_doctor/cookie_export");

async function create_temp_dir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "gather-doctor-gallery-"));
}

describe("gather_doctor gallery-dl adapter", () => {
  it("fails when cookies file lacks x.com hosts", async () => {
    const temp_root = await create_temp_dir();
    const cookies_file = path.join(temp_root, "cookies.txt");
    await fs.writeFile(
      cookies_file,
      "# Netscape\n.example.com\tTRUE\t/\tFALSE\t0\tA\tB\n",
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

    const result = await x_gallery_dl.check({
      offline: true,
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

    expect(result.status).toBe("fail");
    expect(result.checks.some((item) => item.name === "cookies_file")).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toMatch(/SID=|auth_token=/i);
    vi.restoreAllMocks();
  });

  it("fix exports cookies and records runtime path", async () => {
    vi.spyOn(brew_install, "check_gallery_dl").mockResolvedValue({
      ok: true,
      present: true,
      needs_install: false,
      needs_upgrade: false,
      message: "ok",
    });
    vi.spyOn(cookie_export, "export_netscape_cookies").mockResolvedValue({
      ok: true,
      dry_run: true,
      output_path: "/tmp/cookies.txt",
    });

    const result = await x_gallery_dl.fix(
      { dry_run: true },
      {
        selected_profile: {
          directory: "Profile 1",
          name: "Work",
          active_time: 5,
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.runtime_patch.chrome_profile).toBe("Profile 1");
    expect(result.runtime_patch.cookies_file).toContain("cookies.txt");
    vi.restoreAllMocks();
  });
});
