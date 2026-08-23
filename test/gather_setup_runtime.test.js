import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it, expect } from "vitest";
const {
  normalize_runtime_data,
  write_runtime_config,
  read_runtime_config,
  get_cookies_from_browser,
  get_cookies_file,
  set_platform_runtime,
} = require("../lib/gather_setup/runtime_config");

async function create_temp_dir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "gather-setup-runtime-"));
}

describe("gather_setup runtime_config", () => {
  it("writes and reads platform cookie mappings without secrets", async () => {
    const temp_root = await create_temp_dir();
    const runtime_path = path.join(temp_root, "gather.runtime.yaml");
    let data = normalize_runtime_data({});
    data = set_platform_runtime(data, "youtube", {
      chrome_profile: "Profile 2",
      cookies_from_browser: "chrome:Profile 2",
    });
    data = set_platform_runtime(data, "x_gallery_dl", {
      chrome_profile: "Default",
      cookies_file: path.join(temp_root, "cookies.txt"),
    });

    await write_runtime_config(runtime_path, data);
    const loaded = await read_runtime_config(runtime_path);
    expect(loaded.exists).toBe(true);
    expect(get_cookies_from_browser(loaded.data, "youtube")).toBe(
      "chrome:Profile 2",
    );
    expect(get_cookies_file(loaded.data, "x_gallery_dl")).toBe(
      path.join(temp_root, "cookies.txt"),
    );

    const raw_text = await fs.readFile(runtime_path, "utf8");
    expect(raw_text).not.toMatch(/SID=|auth_token=/i);
  });

  it("dry-run write does not create the file", async () => {
    const temp_root = await create_temp_dir();
    const runtime_path = path.join(temp_root, "gather.runtime.yaml");
    const result = await write_runtime_config(
      runtime_path,
      { platform: { youtube: { chrome_profile: "Default" } } },
      { dry_run: true },
    );
    expect(result.dry_run).toBe(true);
    await expect(fs.access(runtime_path)).rejects.toBeTruthy();
  });
});
