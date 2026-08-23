import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it, expect, vi } from "vitest";
import YAML from "yaml";

const { douyin, x_f2 } = require("../lib/gather_setup/adapter/f2_platforms");
const brew_install = require("../lib/gather_setup/brew_install");
const cookie_export = require("../lib/gather_setup/cookie_export");
const f2_config = require("../lib/gather_setup/f2_config");

async function create_temp_dir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "gather-setup-f2-"));
}

describe("gather_setup f2 adapters", () => {
  it("reports missing f2 cookie without printing cookie values", async () => {
    const temp_root = await create_temp_dir();
    const config_path = path.join(temp_root, "app.yaml");
    await fs.writeFile(config_path, "douyin:\n  cookie: ''\n", "utf8");

    vi.spyOn(brew_install, "which_command").mockResolvedValue("/tmp/f2_compat");
    vi.spyOn(brew_install, "check_f2").mockResolvedValue({
      ok: true,
      present: true,
      path: "/tmp/f2",
      message: "f2 present",
    });

    const result = await douyin.check({
      offline: true,
      f2_options: { f2_config_path: config_path },
      chrome_scans: [
        {
          ok: true,
          directory: "Default",
          name: "Default",
          active_time: 1,
          hosts: ["douyin.com"],
        },
      ],
    });
    expect(result.status).toBe("fail");
    expect(JSON.stringify(result)).not.toMatch(/sessionid=/i);
    vi.restoreAllMocks();
  });

  it("writes f2 cookie into app.yaml on setup", async () => {
    const temp_root = await create_temp_dir();
    const config_path = path.join(temp_root, "app.yaml");
    await fs.writeFile(
      config_path,
      YAML.stringify({ twitter: { cookie: "" } }),
      "utf8",
    );

    vi.spyOn(brew_install, "check_f2").mockResolvedValue({
      ok: true,
      present: true,
      path: "/tmp/f2",
      message: "f2 present",
    });

    const write_spy = vi
      .spyOn(f2_config, "write_f2_cookie")
      .mockResolvedValue({
        ok: true,
        dry_run: false,
        config_path,
        app_key: "twitter",
      });
    vi.spyOn(f2_config, "resolve_f2_app_config_path").mockResolvedValue(
      config_path,
    );
    vi.spyOn(cookie_export, "export_netscape_cookies").mockResolvedValue({
      ok: true,
      output_path: path.join(temp_root, "cookies.txt"),
    });
    vi.spyOn(cookie_export, "netscape_to_cookie_header").mockResolvedValue(
      "auth_token=value1",
    );

    // Call through module methods used by adapter after rewiring requires.
    const adapter = require("../lib/gather_setup/adapter/f2_platforms");
    // Patch module-local bindings by stubbing helpers the adapter imports via f2_config/cookie_export objects.
    const result = await adapter.x_f2.setup(
      {
        dry_run: true,
        f2_options: { f2_config_path: config_path },
      },
      {
        selected_profile: {
          directory: "Profile 9",
          name: "nori",
          active_time: 99,
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.runtime_patch.chrome_profile).toBe("Profile 9");
    expect(result.runtime_patch.f2_config).toBe(config_path);

    await f2_config.write_f2_cookie("x_f2", "auth_token=value1", {
      f2_config_path: config_path,
    });
    // Restore real write and verify helper
    write_spy.mockRestore();
    const write_result = await f2_config.write_f2_cookie(
      "x_f2",
      "auth_token=value1",
      { f2_config_path: config_path },
    );
    expect(write_result.ok).toBe(true);
    const written = YAML.parse(await fs.readFile(config_path, "utf8"));
    expect(written.twitter.cookie).toBe("auth_token=value1");
    vi.restoreAllMocks();
  });

  it("resolve_f2_app_config_path honors override", async () => {
    const temp_root = await create_temp_dir();
    const config_path = path.join(temp_root, "app.yaml");
    await fs.writeFile(config_path, "douyin: {}\n", "utf8");
    const resolved = await f2_config.resolve_f2_app_config_path({
      f2_config_path: config_path,
    });
    expect(resolved).toBe(config_path);
  });
});
