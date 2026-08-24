# xsave_douyin Chrome Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Headed `xsave_douyin` Chrome reuses a local user-data dir, seeding `Default/` once from the daily Chrome Douyin profile so later runs stay logged in.

**Architecture:** Add helpers that resolve `~/Library/Application Support/command_base/xsave_douyin/chrome`, copy the source profile into `Default/` on first use, skip caches and Singleton locks, and never delete the dir. `open_persistent_session` launches Playwright against that dir. CDP and cookie-only paths stay unchanged.

**Tech Stack:** Node.js `fs`/`os`/`path`, existing Playwright `chromium.launchPersistentContext`, Vitest.

## Global Constraints

- Dedicated user-data default: `~/Library/Application Support/command_base/xsave_douyin/chrome` via `os.homedir()`, never a hardcoded username.
- Seed destination is `user-data/Default/`, not the user-data root.
- Skip Cache, Code Cache, GPUCache, OptimizationGuide, SingletonLock, SingletonCookie, SingletonSocket when copying.
- If `user-data/Default` already exists, do not overwrite.
- Clear Singleton lock files at the user-data root before launch; launch once; on failure keep the dir.
- `close()` must not delete the dedicated user-data dir.
- Source profile missing → `chrome profile directory missing`; do not create an empty dedicated dir.
- Tests inject `persistent_user_data_dir`; never write real Application Support in tests.
- No new CLI flags. No new dependencies. No iCloud / repo `tmp/` profile storage.
- `open_session` order stays CDP → persistent → cookie-only.
- Naming: `snake_case` files/vars/functions; `function` keyword for pure helpers; named exports.
- Two or more repo-owned source files → isolated git worktree from the original branch, commit there, merge back, delete the worktree and task branch.
- Do not commit files under `tmp/`.

## File structure

| Path | Responsibility |
|------|----------------|
| `lib/xsave_douyin/chrome_client.js` | Default path, seed/reuse helpers, persistent session launch/close |
| `test/xsave_douyin_chrome_client.test.js` | Helper and `open_session` persistence tests |
| `docs/superpowers/specs/2026-08-24-xsave-douyin-chrome-session-design.md` | Approved spec (read-only) |

---

### Task 1: Persistent user-data helpers

**Files:**
- Modify: `lib/xsave_douyin/chrome_client.js` (`should_skip_profile_path`, new helpers, `module.exports`)
- Test: `test/xsave_douyin_chrome_client.test.js`

**Interfaces:**
- Consumes: Node `fs`, `os`, `path`; existing `should_skip_profile_path`
- Produces:
  - `function default_persistent_user_data_dir(): string`
  - `function prepare_persistent_user_data({ source_dir: string, persistent_user_data_dir?: string }): string`
  - `should_skip_profile_path` also skips Singleton lock names

Create the isolated worktree before editing (original branch is the workspace branch at start; expected files: `lib/xsave_douyin/chrome_client.js`, `test/xsave_douyin_chrome_client.test.js`).

- [ ] **Step 1: Write the failing helper tests**

In `test/xsave_douyin_chrome_client.test.js`, add these imports next to the existing `require`:

```js
const {
  attach_list_intercept,
  collect_list,
  default_persistent_user_data_dir,
  fetch_comments,
  fetch_danmaku,
  list_endpoint,
  open_session,
  prepare_list_page,
  prepare_persistent_user_data,
} = require("../lib/xsave_douyin/chrome_client");
```

Append this describe after the existing `describe("xsave_douyin chrome_client", …)` block:

```js
describe("xsave_douyin persistent user-data", () => {
  it("resolves the Application Support chrome dir from homedir", () => {
    expect(default_persistent_user_data_dir()).toBe(
      path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "command_base",
        "xsave_douyin",
        "chrome",
      ),
    );
  });

  it("seeds a Chrome profile into Default and skips cache and locks", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-persist-"));
    const source_dir = path.join(temp_root, "Profile 9");
    const user_data = path.join(temp_root, "chrome");
    try {
      await fs.mkdir(path.join(source_dir, "Cache"), { recursive: true });
      await fs.writeFile(path.join(source_dir, "Preferences"), "{}", "utf8");
      await fs.writeFile(path.join(source_dir, "Cache", "blob"), "c", "utf8");
      await fs.writeFile(path.join(source_dir, "SingletonLock"), "lock", "utf8");
      const result = prepare_persistent_user_data({
        source_dir,
        persistent_user_data_dir: user_data,
      });
      expect(result).toBe(user_data);
      expect(
        await fs.readFile(path.join(user_data, "Default", "Preferences"), "utf8"),
      ).toBe("{}");
      await expect(fs.stat(path.join(user_data, "Preferences"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        fs.stat(path.join(user_data, "Default", "Cache")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.stat(path.join(user_data, "Default", "SingletonLock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing Default profile", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-persist-"));
    const source_dir = path.join(temp_root, "Profile 9");
    const user_data = path.join(temp_root, "chrome");
    try {
      await fs.mkdir(source_dir, { recursive: true });
      await fs.writeFile(path.join(source_dir, "Preferences"), "new", "utf8");
      await fs.mkdir(path.join(user_data, "Default"), { recursive: true });
      await fs.writeFile(path.join(user_data, "Default", "sentinel"), "keep", "utf8");
      await fs.writeFile(path.join(user_data, "Default", "Preferences"), "old", "utf8");
      prepare_persistent_user_data({
        source_dir,
        persistent_user_data_dir: user_data,
      });
      expect(
        await fs.readFile(path.join(user_data, "Default", "sentinel"), "utf8"),
      ).toBe("keep");
      expect(
        await fs.readFile(path.join(user_data, "Default", "Preferences"), "utf8"),
      ).toBe("old");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("removes leftover Singleton locks at the user-data root", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-persist-"));
    const source_dir = path.join(temp_root, "Profile 9");
    const user_data = path.join(temp_root, "chrome");
    try {
      await fs.mkdir(source_dir, { recursive: true });
      await fs.writeFile(path.join(source_dir, "Preferences"), "{}", "utf8");
      await fs.mkdir(path.join(user_data, "Default"), { recursive: true });
      await fs.writeFile(path.join(user_data, "SingletonLock"), "old", "utf8");
      await fs.writeFile(path.join(user_data, "SingletonCookie"), "old", "utf8");
      await fs.writeFile(path.join(user_data, "SingletonSocket"), "old", "utf8");
      prepare_persistent_user_data({
        source_dir,
        persistent_user_data_dir: user_data,
      });
      await expect(
        fs.stat(path.join(user_data, "SingletonLock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.stat(path.join(user_data, "SingletonCookie")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.stat(path.join(user_data, "SingletonSocket")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xsave_douyin_chrome_client.test.js --testNamePattern="persistent user-data"`

Expected: FAIL because `default_persistent_user_data_dir` and `prepare_persistent_user_data` are not exported.

- [ ] **Step 3: Write minimal helper implementation**

In `lib/xsave_douyin/chrome_client.js`, replace `should_skip_profile_path` and add helpers after `DEFAULT_CHROME_USER_DATA` is required. Keep `copy_chrome_profile` for now (Task 2 removes it).

```js
function default_persistent_user_data_dir() {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "command_base",
    "xsave_douyin",
    "chrome",
  );
}

function should_skip_profile_path(file_path) {
  return /\/(Cache|Code Cache|GPUCache|OptimizationGuide|SingletonLock|SingletonCookie|SingletonSocket)(\/|$)/.test(
    file_path,
  );
}

function clear_singleton_locks(user_data_dir) {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"])
    fs.rmSync(path.join(user_data_dir, name), { force: true });
}

function seed_chrome_user_data(source_dir, user_data_dir) {
  const dest_default = path.join(user_data_dir, "Default");
  if (fs.existsSync(dest_default)) return;
  fs.mkdirSync(user_data_dir, { recursive: true });
  fs.cpSync(source_dir, dest_default, {
    recursive: true,
    dereference: true,
    filter: (src) => !should_skip_profile_path(src),
  });
}

function prepare_persistent_user_data({
  source_dir,
  persistent_user_data_dir,
} = {}) {
  const user_data_dir =
    persistent_user_data_dir || default_persistent_user_data_dir();
  seed_chrome_user_data(source_dir, user_data_dir);
  clear_singleton_locks(user_data_dir);
  return user_data_dir;
}
```

Add to `module.exports`:

```js
  default_persistent_user_data_dir,
  prepare_persistent_user_data,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/xsave_douyin_chrome_client.test.js`

Expected: PASS, including the new persistent user-data tests and the existing chrome_client tests.

- [ ] **Step 5: Commit**

```bash
git add lib/xsave_douyin/chrome_client.js test/xsave_douyin_chrome_client.test.js
git commit -m "$(cat <<'EOF'
feat: add xsave_douyin persistent Chrome user-data helpers

Seed Default/ once from the daily profile and skip caches/locks so the
headed session can reuse a durable directory.
EOF
)"
```

---

### Task 2: Persistent headed session

**Files:**
- Modify: `lib/xsave_douyin/chrome_client.js` (`open_persistent_session`, `open_session`; remove `copy_chrome_profile`)
- Test: `test/xsave_douyin_chrome_client.test.js`

**Interfaces:**
- Consumes: `prepare_persistent_user_data({ source_dir, persistent_user_data_dir })` from Task 1
- Produces:
  - `open_persistent_session({ chrome_profile, playwright, chrome_user_data_dir, profile_source_dir, persistent_user_data_dir })`
  - `open_session({ cookie_header, chrome_profile, playwright, chrome_user_data_dir, profile_source_dir, persistent_user_data_dir })`
  - `close()` does not delete user-data; launch errors do not delete user-data

- [ ] **Step 1: Write the failing session tests**

Replace the existing test `opens a copied Chrome profile instead of a cookie-only context` with:

```js
  it("seeds Default in a durable user-data dir and keeps it after close", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-profile-"));
    const source_dir = path.join(temp_root, "Profile 9");
    const user_data = path.join(temp_root, "chrome");
    await fs.mkdir(source_dir, { recursive: true });
    await fs.writeFile(path.join(source_dir, "Preferences"), "{}", "utf8");
    const launched = [];
    const page = { url: () => "about:blank" };
    try {
      const session = await open_session({
        cookie_header: "sessionid=dummy",
        chrome_profile: "Profile 9",
        profile_source_dir: source_dir,
        persistent_user_data_dir: user_data,
        playwright: {
          chromium: {
            launchPersistentContext: async (launched_user_data, options) => {
              launched.push({
                user_data: launched_user_data,
                channel: options.channel,
                headless: options.headless,
                chromiumSandbox: options.chromiumSandbox,
                args: options.args,
              });
              return {
                pages: () => [page],
                newPage: async () => page,
                close: async () => {},
              };
            },
            launch: async () => {
              throw new Error("should not use cookie-only launch");
            },
          },
        },
      });
      expect(launched).toHaveLength(1);
      expect(launched[0].channel).toBe("chrome");
      expect(launched[0].headless).toBe(false);
      expect(launched[0].user_data).toBe(user_data);
      expect(launched[0].chromiumSandbox).toBe(true);
      expect(launched[0].args || []).not.toContain("--no-sandbox");
      expect(
        await fs.readFile(path.join(user_data, "Default", "Preferences"), "utf8"),
      ).toBe("{}");
      await session.close();
      expect(
        await fs.readFile(path.join(user_data, "Default", "Preferences"), "utf8"),
      ).toBe("{}");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
```

Add these tests inside `describe("xsave_douyin chrome_client", …)`, after the durable-dir test:

```js
  it("does not create persistent user-data when the source profile is missing", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-profile-"));
    const user_data = path.join(temp_root, "chrome");
    try {
      await expect(
        open_session({
          chrome_profile: "Profile 9",
          profile_source_dir: path.join(temp_root, "missing"),
          persistent_user_data_dir: user_data,
          playwright: {
            chromium: {
              launchPersistentContext: async () => {
                throw new Error("should not launch");
              },
            },
          },
        }),
      ).rejects.toThrow("chrome profile directory missing");
      await expect(fs.stat(user_data)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("keeps the persistent user-data dir when Chrome fails to launch", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-profile-"));
    const source_dir = path.join(temp_root, "Profile 9");
    const user_data = path.join(temp_root, "chrome");
    await fs.mkdir(source_dir, { recursive: true });
    await fs.writeFile(path.join(source_dir, "Preferences"), "{}", "utf8");
    try {
      await expect(
        open_session({
          chrome_profile: "Profile 9",
          profile_source_dir: source_dir,
          persistent_user_data_dir: user_data,
          playwright: {
            chromium: {
              launchPersistentContext: async () => {
                throw new Error("chrome explode");
              },
            },
          },
        }),
      ).rejects.toThrow("chrome explode");
      expect(
        await fs.readFile(path.join(user_data, "Default", "Preferences"), "utf8"),
      ).toBe("{}");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
```

Replace `attaches to an existing Chrome debug port when available` with:

```js
  it("attaches to an existing Chrome debug port when available", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-cdp-"));
    const source_dir = path.join(temp_root, "Profile 9");
    const user_data = path.join(temp_root, "chrome");
    await fs.mkdir(source_dir, { recursive: true });
    await fs.writeFile(path.join(source_dir, "Preferences"), "{}", "utf8");
    const page = { url: () => "about:blank" };
    let used_cdp = false;
    try {
      const session = await open_session({
        chrome_profile: "Profile 9",
        profile_source_dir: source_dir,
        persistent_user_data_dir: user_data,
        playwright: {
          chromium: {
            connectOverCDP: async () => {
              used_cdp = true;
              return {
                contexts: () => [
                  {
                    pages: () => [],
                    newPage: async () => page,
                  },
                ],
                close: async () => {},
              };
            },
            launchPersistentContext: async () => {
              throw new Error("should not copy the profile when CDP works");
            },
          },
        },
      });
      expect(used_cdp).toBe(true);
      expect(session.page).toBe(page);
      await expect(
        fs.stat(path.join(user_data, "Default")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await session.close();
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run session tests to verify they fail**

Run: `npx vitest run test/xsave_douyin_chrome_client.test.js --testNamePattern="durable user-data|source profile is missing|fails to launch|debug port"`

Expected: FAIL. The current implementation copies into a temp dir (not `persistent_user_data_dir/Default`) and deletes that copy on close or launch error.

- [ ] **Step 3: Wire the persistent session**

Replace `copy_chrome_profile` and `open_persistent_session` in `lib/xsave_douyin/chrome_client.js`:

```js
async function open_persistent_session({
  chrome_profile,
  playwright,
  chrome_user_data_dir,
  profile_source_dir,
  persistent_user_data_dir,
} = {}) {
  const source_dir = await resolve_profile_source_dir({
    chrome_profile,
    chrome_user_data_dir,
    profile_source_dir,
  });
  if (!source_dir || !fs.existsSync(source_dir))
    throw new Error("chrome profile directory missing");
  const user_data = prepare_persistent_user_data({
    source_dir,
    persistent_user_data_dir,
  });
  const { chromium } = playwright || load_playwright();
  const context = await chromium.launchPersistentContext(user_data, {
    headless: false,
    channel: "chrome",
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
    chromiumSandbox: true,
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  const page =
    (context.pages && context.pages()[0]) || (await context.newPage());
  if (typeof page.setDefaultTimeout === "function")
    page.setDefaultTimeout(30000);
  return {
    browser: context,
    context,
    page,
    async close() {
      await context.close();
    },
  };
}
```

Delete `copy_chrome_profile` entirely.

Update `open_session` to pass `persistent_user_data_dir`:

```js
async function open_session({
  cookie_header,
  chrome_profile,
  playwright,
  chrome_user_data_dir,
  profile_source_dir,
  persistent_user_data_dir,
} = {}) {
  const cdp = await try_open_cdp_session(playwright);
  if (cdp) return cdp;
  if (chrome_profile || profile_source_dir)
    return open_persistent_session({
      chrome_profile,
      playwright,
      chrome_user_data_dir,
      profile_source_dir,
      persistent_user_data_dir,
    });
  return open_cookie_session({ cookie_header, playwright });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/xsave_douyin_chrome_client.test.js`

Expected: PASS for helper tests and session tests.

Also run: `npx vitest run test/xsave_douyin_cli.test.js test/xsave_douyin_chrome_client.test.js`

Expected: PASS. CLI help and flags are unchanged.

- [ ] **Step 5: Commit, merge worktree, clean up**

```bash
git add lib/xsave_douyin/chrome_client.js test/xsave_douyin_chrome_client.test.js
git commit -m "$(cat <<'EOF'
feat: reuse a durable headed Chrome profile for xsave_douyin

Keep login cookies in a local user-data Default/ instead of a temp
copy that was deleted after every run.
EOF
)"
```

Then fast-forward merge the task branch into the original workspace branch, remove the worktree, and delete the task branch.
