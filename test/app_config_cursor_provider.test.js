import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const cursor_provider = require("../lib/app_config/provider/cursor_provider");

function test_ctx(home_dir) {
  return {
    debug: false,
    quiet: true,
    dry_run: false,
    home_dir,
    exec_cursor_list_extensions: () => "publisher.one\npublisher.two\n",
  };
}

describe("cursor_provider filtered backup", () => {
  it("excludes volatile databases and extension binaries", async () => {
    const home_dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-home-"));
    const backup_dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cursor-backup-"),
    );
    const global_storage = path.join(
      home_dir,
      cursor_provider.GLOBAL_STORAGE_REL_PATH,
    );
    const extensions_dir = path.join(
      home_dir,
      cursor_provider.EXTENSIONS_REL_PATH,
    );

    await fs.ensureDir(path.join(global_storage, "publisher.small-state"));
    await fs.writeFile(path.join(global_storage, "state.vscdb"), "chat data");
    await fs.writeFile(
      path.join(global_storage, "state.vscdb.backup"),
      "chat backup",
    );
    await fs.writeFile(
      path.join(global_storage, "conversation-search.db-wal"),
      "search data",
    );
    await fs.writeFile(
      path.join(global_storage, "publisher.small-state", "config.json"),
      '{"enabled":true}',
    );
    await fs.ensureDir(extensions_dir);
    await fs.writeFile(path.join(extensions_dir, "native-binary"), "binary");

    const manifest = cursor_provider.backup(backup_dir, test_ctx(home_dir));
    const backed_up_global_storage = path.join(
      backup_dir,
      cursor_provider.GLOBAL_STORAGE_REL_PATH,
    );

    expect(
      await fs.pathExists(path.join(backed_up_global_storage, "state.vscdb")),
    ).toBe(false);
    expect(
      await fs.pathExists(
        path.join(backed_up_global_storage, "state.vscdb.backup"),
      ),
    ).toBe(false);
    expect(
      await fs.pathExists(
        path.join(backed_up_global_storage, "conversation-search.db-wal"),
      ),
    ).toBe(false);
    expect(
      await fs.pathExists(
        path.join(
          backed_up_global_storage,
          "publisher.small-state",
          "config.json",
        ),
      ),
    ).toBe(true);
    expect(
      await fs.pathExists(
        path.join(backup_dir, cursor_provider.EXTENSIONS_REL_PATH),
      ),
    ).toBe(false);
    expect(
      await fs.readFile(
        path.join(backup_dir, cursor_provider.EXTENSIONS_LIST_FILE),
        "utf8",
      ),
    ).toBe("publisher.one\npublisher.two\n");
    expect(manifest.included_paths).not.toContain(
      cursor_provider.EXTENSIONS_REL_PATH,
    );
    expect(manifest.excluded_paths).toContain(
      cursor_provider.EXTENSIONS_REL_PATH,
    );
  });
});

describe("cursor_provider filtered restore", () => {
  it("merges globalStorage without replacing current volatile databases", async () => {
    const home_dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-home-"));
    const backup_dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cursor-backup-"),
    );
    const live_global_storage = path.join(
      home_dir,
      cursor_provider.GLOBAL_STORAGE_REL_PATH,
    );
    const backup_global_storage = path.join(
      backup_dir,
      cursor_provider.GLOBAL_STORAGE_REL_PATH,
    );

    await fs.ensureDir(live_global_storage);
    await fs.ensureDir(backup_global_storage);
    await fs.writeFile(
      path.join(live_global_storage, "state.vscdb"),
      "current chat data",
    );
    await fs.writeFile(
      path.join(live_global_storage, "current-only.json"),
      "keep me",
    );
    await fs.writeFile(
      path.join(backup_global_storage, "state.vscdb"),
      "old chat data",
    );
    await fs.writeFile(
      path.join(backup_global_storage, "storage.json"),
      "restored config",
    );
    await fs.writeJson(path.join(backup_dir, cursor_provider.MANIFEST_NAME), {
      included_paths: [cursor_provider.GLOBAL_STORAGE_REL_PATH],
    });
    await fs.writeFile(
      path.join(backup_dir, cursor_provider.EXTENSIONS_LIST_FILE),
      "",
    );

    cursor_provider.restore(backup_dir, test_ctx(home_dir));

    expect(
      await fs.readFile(path.join(live_global_storage, "state.vscdb"), "utf8"),
    ).toBe("current chat data");
    expect(
      await fs.readFile(
        path.join(live_global_storage, "current-only.json"),
        "utf8",
      ),
    ).toBe("keep me");
    expect(
      await fs.readFile(path.join(live_global_storage, "storage.json"), "utf8"),
    ).toBe("restored config");
  });
});
