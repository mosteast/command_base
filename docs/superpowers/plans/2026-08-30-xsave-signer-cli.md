# xsave `--signer` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--signer` to `xsave_instagram` and `xsave_douyin` so `like` and `collection` export the logged-in account without a URL, and fix Instagram likes to `your_activity/interactions/likes`.

**Architecture:** Same boolean `--signer` on both `parse_cli` surfaces. Instagram skips the profile-URL session match and opens the Your Activity likes page or the session user's saved-all-posts URL. Douyin resolves `sec_user_id` from the Chrome session and reuses the existing like/collection collect path. Gather defaults and `instagram_likes_export` stay unchanged.

**Tech Stack:** Node.js, yargs, Playwright (injected in tests), Vitest.

## Global Constraints

- Invocation: `<command> like --signer` and `<command> collection --signer` (no URL). Existing `<source> <url>` and item-URL forms stay valid.
- `--signer` is boolean, default `false`. Valid only with `like` or `collection`.
- Extra positional with `--signer` → `Unexpected argument <token>`.
- `post` / `video` plus `--signer` → `source <source> does not accept --signer`.
- `--signer` with no source and no inferable item URL → existing `Missing URL` / `Missing source`. Do not infer `like`.
- `like` / `collection` without `--signer` and without URL → existing `Missing URL`.
- Parsed field: `signer: boolean`. `url` is `""` in signer mode.
- Instagram likes URL: `https://www.instagram.com/your_activity/interactions/likes/` (replace `/your_activity/liked`).
- Instagram `collection --signer`: session username then `/{user}/saved/all-posts/`. Empty username → `source collection requires a logged-in Instagram session`.
- Instagram `--signer` skips `assert_logged_in_profile`.
- Douyin `--signer` resolves session `sec_user_id`. Failure → `source <source> requires a logged-in Douyin session`.
- Do not change gather defaults. Do not auto-append `--signer`. Do not modify `instagram_likes_export`.
- Naming: `snake_case` files/vars/functions; `function` keyword for pure helpers; named exports.
- Two or more repo-owned source files → isolated git worktree from the original branch, commit there, merge back, delete the worktree and task branch.
- Do not commit files under `tmp/`.
- Do not hit live Instagram or Douyin in unit tests.

## File structure

| Path | Responsibility |
|------|----------------|
| `lib/xsave_instagram/parse_cli.js` | `--signer` flag, empty-URL parse, help |
| `lib/xsave_douyin/parse_cli.js` | Same parse/help contract |
| `lib/xsave_instagram/chrome_client.js` | Likes URL, collection session username, export `list_page_urls` |
| `lib/xsave_instagram/run_export.js` | Skip profile assert when `signer` |
| `lib/xsave_douyin/chrome_client.js` | `resolve_session_sec_user_id` |
| `lib/xsave_douyin/run_export.js` | Use session `sec_user_id` when `signer` |
| `lib/xsave_instagram/rewrite_command.js` | Keep `--signer`; do not invent a URL |
| `lib/xsave_douyin/rewrite_command.js` | Same keep-`--signer` contract |
| `bin/xsave_instagram` / `bin/xsave_douyin` | No logic change (pass parsed options through) |
| `docs/superpowers/specs/2026-08-30-xsave-signer-cli-design.md` | Approved spec (read-only) |

Do not edit `bin/gather`, `lib/gather_doctor/*`, or `bin/instagram_likes_export`.

---

### Task 1: Instagram `parse_cli` `--signer`

**Files:**
- Modify: `lib/xsave_instagram/parse_cli.js`
- Test: `test/xsave_instagram_cli.test.js`

**Interfaces:**
- Consumes: existing `parse_cli(argv)`, `ALLOWED_SOURCES`, `LIST_SOURCES`
- Produces:
  - `SIGNER_SOURCES = ["like", "collection"]`
  - `function resolve_source_and_url(positionals: string[], { signer: boolean }): { source: string, url: string }`
  - `parse_cli` return field `signer: boolean` (default `false`)
  - Help usage lines `like --signer` / `collection --signer` and option `--signer`

Create the isolated worktree from the original workspace branch before editing. Link `node_modules` into the worktree. Do all later tasks in that worktree.

- [ ] **Step 1: Write the failing parse and help tests**

Add these cases to `test/xsave_instagram_cli.test.js` (keep existing tests). Also extend the existing help test with `--signer` and the logged-in likes example:

```js
  it("parses like --signer and collection --signer without a url", () => {
    const like = parse_cli(["like", "--signer"]);
    expect(like.source).toBe("like");
    expect(like.url).toBe("");
    expect(like.signer).toBe(true);
    const collection = parse_cli(["--signer", "collection"]);
    expect(collection.source).toBe("collection");
    expect(collection.url).toBe("");
    expect(collection.signer).toBe(true);
  });

  it("rejects --signer with an extra url or on post/video", () => {
    expect(() =>
      parse_cli(["like", "--signer", "https://www.instagram.com/example_user/"]),
    ).toThrow(/Unexpected argument https:\/\/www.instagram.com\/example_user\//);
    expect(() =>
      parse_cli(["post", "--signer", "https://www.instagram.com/example_user/"]),
    ).toThrow(/source post does not accept --signer/);
    expect(() =>
      parse_cli(["video", "https://www.instagram.com/p/AbCdEfGhIjK/", "--signer"]),
    ).toThrow(/source video does not accept --signer/);
    expect(() =>
      parse_cli(["--signer", "https://www.instagram.com/p/AbCdEfGhIjK/"]),
    ).toThrow(/source video does not accept --signer/);
  });

  it("does not infer like from --signer alone", () => {
    expect(() => parse_cli(["--signer"])).toThrow(/Missing URL/);
    expect(() => parse_cli(["like"])).toThrow(/Missing URL/);
  });
```

In the existing help test, add:

```js
    expect(result.stdout).toMatch(/--signer/);
    expect(result.stdout).toMatch(/# Download the logged-in account's likes/);
    expect(result.stdout).toMatch(/\$0 like --signer/);
    expect(result.stdout).toMatch(/\$0 collection --signer/);
```

In `parses source and url positionals`, add `expect(options.signer).toBe(false);`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xsave_instagram_cli.test.js --testNamePattern="parses like --signer|rejects --signer with an extra|does not infer like|prints help"`

Expected: FAIL — `--signer` is an unknown option and/or `Missing URL` for `like --signer`.

- [ ] **Step 3: Write minimal implementation**

In `lib/xsave_instagram/parse_cli.js`:

1. Add `const SIGNER_SOURCES = ["like", "collection"];` next to `LIST_SOURCES`.

2. Replace `build_help_text` usage/options/examples with:

```js
    "Usage",
    `  ${name} <source> <url> [options]`,
    `  ${name} <item-url> [options]`,
    `  ${name} like --signer [options]`,
    `  ${name} collection --signer [options]`,
```

After the `--cookie-file` option line:

```js
    "      --signer                  Export the logged-in account for like or collection (default: false)",
```

After the existing liked-posts example, add:

```js
    "  # Download the logged-in account's likes",
    "  $0 like --signer",
    "",
    "  # Download the logged-in account's collections",
    "  $0 collection --signer",
    "",
```

3. Replace `resolve_source_and_url` with:

```js
function resolve_source_and_url(positionals, { signer } = {}) {
  if (positionals.length === 0) throw new Error("Missing URL");
  const first = String(positionals[0] || "").trim();
  if (ALLOWED_SOURCES.includes(first)) {
    const url = String(positionals[1] || "").trim();
    if (signer && SIGNER_SOURCES.includes(first)) {
      if (positionals.length > 1)
        throw new Error(`Unexpected argument ${positionals[1]}`);
      return { source: first, url: "" };
    }
    if (!url) throw new Error("Missing URL");
    if (positionals.length > 2)
      throw new Error(`Unexpected argument ${positionals[2]}`);
    return { source: first, url };
  }
  if (!looks_like_url(first)) {
    throw new Error(
      `Invalid source ${first}. Allowed: like, post, collection, video`,
    );
  }
  if (positionals.length > 1)
    throw new Error(`Unexpected argument ${positionals[1]}`);
  if (is_item_url(first)) return { source: "video", url: first };
  throw new Error(
    "Missing source. Use like, post, collection, or a /p/ or /reel/ URL",
  );
}
```

4. In the yargs chain, add:

```js
    .option("signer", {
      type: "boolean",
      default: false,
      describe: "Export the logged-in account for like or collection",
    })
```

5. After `parser.parse()`:

```js
  const parsed = parser.parse();
  const positionals = (parsed._ || []).map((token) => String(token));
  const signer = Boolean(parsed.signer);
  const { source, url } = resolve_source_and_url(positionals, { signer });
  if (signer && !SIGNER_SOURCES.includes(source))
    throw new Error(`source ${source} does not accept --signer`);
  if (url) assert_source_url_match(source, url);

  return {
    source,
    url,
    signer,
    // existing fields unchanged
  };
```

Export `SIGNER_SOURCES` from `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/xsave_instagram_cli.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/xsave_instagram/parse_cli.js test/xsave_instagram_cli.test.js
git commit -m "feat: parse xsave_instagram like --signer without a url"
```

---

### Task 2: Douyin `parse_cli` `--signer`

**Files:**
- Modify: `lib/xsave_douyin/parse_cli.js`
- Test: `test/xsave_douyin_cli.test.js`

**Interfaces:**
- Consumes: existing Douyin `parse_cli(argv)`
- Produces:
  - `SIGNER_SOURCES = ["like", "collection"]`
  - Same `signer: boolean` and empty-`url` contract as Instagram
  - Help usage/option/examples for `--signer`

- [ ] **Step 1: Write the failing parse and help tests**

Add to `test/xsave_douyin_cli.test.js`:

```js
  it("parses like --signer and collection --signer without a url", () => {
    const like = parse_cli(["like", "--signer"]);
    expect(like.source).toBe("like");
    expect(like.url).toBe("");
    expect(like.signer).toBe(true);
    const collection = parse_cli(["--signer", "collection"]);
    expect(collection.source).toBe("collection");
    expect(collection.url).toBe("");
    expect(collection.signer).toBe(true);
  });

  it("rejects --signer with an extra url or on post/video", () => {
    expect(() =>
      parse_cli(["like", "--signer", "https://www.douyin.com/user/MS4wLjABAAAA"]),
    ).toThrow(/Unexpected argument https:\/\/www.douyin.com\/user\/MS4wLjABAAAA/);
    expect(() =>
      parse_cli(["post", "--signer", "https://www.douyin.com/user/MS4wLjABAAAA"]),
    ).toThrow(/source post does not accept --signer/);
    expect(() =>
      parse_cli(["video", "https://www.douyin.com/video/123", "--signer"]),
    ).toThrow(/source video does not accept --signer/);
    expect(() => parse_cli(["--signer", "https://www.douyin.com/video/123"])).toThrow(
      /source video does not accept --signer/,
    );
  });

  it("does not infer like from --signer alone", () => {
    expect(() => parse_cli(["--signer"])).toThrow(/Missing URL/);
    expect(() => parse_cli(["like"])).toThrow(/Missing URL/);
  });
```

In the existing help test, add `--signer` and:

```js
    expect(result.stdout).toMatch(/# Download the logged-in account's likes/);
    expect(result.stdout).toMatch(/\$0 like --signer/);
    expect(result.stdout).toMatch(/\$0 collection --signer/);
```

In `parses source and url positionals`, add `expect(options.signer).toBe(false);`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xsave_douyin_cli.test.js --testNamePattern="parses like --signer|rejects --signer with an extra|does not infer like|prints help"`

Expected: FAIL — `--signer` unknown and/or `Missing URL`.

- [ ] **Step 3: Write minimal implementation**

In `lib/xsave_douyin/parse_cli.js`:

1. Add `const SIGNER_SOURCES = ["like", "collection"];` next to `LIST_SOURCES`.

2. Update `build_help_text` usage:

```js
    "Usage",
    `  ${name} <source> <url> [options]`,
    `  ${name} <video-url> [options]`,
    `  ${name} like --signer [options]`,
    `  ${name} collection --signer [options]`,
```

After `--cookie-file`:

```js
    "      --signer                  Export the logged-in account for like or collection (default: false)",
```

After the existing liked-videos example:

```js
    "  # Download the logged-in account's likes",
    "  $0 like --signer",
    "",
    "  # Download the logged-in account's collections",
    "  $0 collection --signer",
    "",
```

3. Replace `resolve_source_and_url` with:

```js
function resolve_source_and_url(positionals, { signer } = {}) {
  if (positionals.length === 0) throw new Error("Missing URL");
  const first = String(positionals[0] || "").trim();
  if (ALLOWED_SOURCES.includes(first)) {
    const url = String(positionals[1] || "").trim();
    if (signer && SIGNER_SOURCES.includes(first)) {
      if (positionals.length > 1)
        throw new Error(`Unexpected argument ${positionals[1]}`);
      return { source: first, url: "" };
    }
    if (!url) throw new Error("Missing URL");
    if (positionals.length > 2)
      throw new Error(`Unexpected argument ${positionals[2]}`);
    return { source: first, url };
  }
  if (!looks_like_url(first)) {
    throw new Error(
      `Invalid source ${first}. Allowed: like, post, collection, video`,
    );
  }
  if (positionals.length > 1)
    throw new Error(`Unexpected argument ${positionals[1]}`);
  if (is_video_url(first) && !is_short_url(first))
    return { source: "video", url: first };
  throw new Error(
    "Missing source. Use like, post, collection, or a /video/ URL",
  );
}
```

4. Add the yargs `--signer` boolean option (default `false`).

5. After parse:

```js
  const signer = Boolean(parsed.signer);
  const { source, url } = resolve_source_and_url(positionals, { signer });
  if (signer && !SIGNER_SOURCES.includes(source))
    throw new Error(`source ${source} does not accept --signer`);
  if (url) assert_source_url_match(source, url);
```

Return `signer` with the existing fields. Export `SIGNER_SOURCES`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/xsave_douyin_cli.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/xsave_douyin/parse_cli.js test/xsave_douyin_cli.test.js
git commit -m "feat: parse xsave_douyin like --signer without a url"
```

---

### Task 3: Instagram likes URL, collection session user, skip profile assert

**Files:**
- Modify: `lib/xsave_instagram/chrome_client.js`
- Modify: `lib/xsave_instagram/run_export.js`
- Test: `test/xsave_instagram_chrome_client.test.js`
- Test: `test/xsave_instagram_cli.test.js` (export skip-assert case)

**Interfaces:**
- Consumes: `read_session_username(page)`, `extract_profile_username(url)`, `normalize_username(raw)`, `assert_logged_in_profile`
- Produces:
  - `function list_page_urls(source: string, url: string, session_username?: string): string[]`
  - `function resolve_list_username({ page, source, url, session_username }): Promise<string>`
  - `prepare_list_page(page, { source, url, session_username })`
  - `collect_list({ page, source, url, session_username, limit, should_stop })`
  - `run_export` calls `assert_logged_in_profile` only when `source` is `like`/`collection` **and** `options.signer` is falsy
  - Likes URL is always `https://www.instagram.com/your_activity/interactions/likes/`
  - Empty collection username throws `source collection requires a logged-in Instagram session`

- [ ] **Step 1: Write the failing chrome and export tests**

Add to `test/xsave_instagram_chrome_client.test.js` (import `list_page_urls` and `prepare_list_page`):

```js
  it("opens likes on your_activity/interactions/likes", () => {
    expect(list_page_urls("like", "")).toEqual([
      "https://www.instagram.com/your_activity/interactions/likes/",
    ]);
    expect(
      list_page_urls("like", "https://www.instagram.com/example_user/"),
    ).toEqual(["https://www.instagram.com/your_activity/interactions/likes/"]);
  });

  it("builds collection saved url from the session username", () => {
    expect(list_page_urls("collection", "", "Nori")).toEqual([
      "https://www.instagram.com/nori/saved/all-posts/",
    ]);
  });

  it("fails collection --signer when the session username is empty", async () => {
    await expect(
      prepare_list_page(
        { evaluate: async () => "", goto: async () => {} },
        { source: "collection", url: "" },
      ),
    ).rejects.toThrow(/source collection requires a logged-in Instagram session/);
  });
```

Add to `test/xsave_instagram_cli.test.js`:

```js
  it("skips logged-in profile assert when signer is set", async () => {
    const { run_export } = require("../lib/xsave_instagram/run_export");
    let asserted = false;
    const result = await run_export(
      {
        source: "like",
        url: "",
        signer: true,
        dry_run: true,
        output: "/tmp/xsave-ig-signer",
        max_comment: 0,
        chrome_profile: "nori",
      },
      {
        resolve_cookie: async () => "dummy",
        collect_list: async () => [],
        assert_logged_in_profile: async () => {
          asserted = true;
          throw new Error("should not assert when signer");
        },
        log: () => {},
      },
    );
    expect(result.exit_code).toBe(0);
    expect(asserted).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xsave_instagram_chrome_client.test.js test/xsave_instagram_cli.test.js --testNamePattern="opens likes on your_activity|builds collection saved|fails collection --signer|skips logged-in profile"`

Expected: FAIL — `list_page_urls` is not exported; likes URL is still `/your_activity/liked`; assert still runs for `like`.

- [ ] **Step 3: Write minimal implementation**

In `lib/xsave_instagram/chrome_client.js`, replace `list_page_urls` and add `resolve_list_username`. Update `prepare_list_page` and `collect_list` to pass `session_username` through.

```js
function list_page_urls(source, url, session_username) {
  const username =
    extract_profile_username(url) || normalize_username(session_username || "");
  if (source === "video") return [String(url || "")];
  if (source === "like")
    return ["https://www.instagram.com/your_activity/interactions/likes/"];
  if (source === "collection" && username)
    return [`https://www.instagram.com/${username}/saved/all-posts/`];
  if (source === "post" && username)
    return [
      `https://www.instagram.com/${username}/`,
      `https://www.instagram.com/${username}/reels/`,
    ];
  return [String(url || "")];
}

async function resolve_list_username({
  page,
  source,
  url,
  session_username,
} = {}) {
  const from_url = extract_profile_username(url);
  if (from_url) return from_url;
  const from_arg = normalize_username(session_username || "");
  if (from_arg) return from_arg;
  if (source !== "collection") return "";
  const from_session = await read_session_username(page);
  if (!from_session)
    throw new Error("source collection requires a logged-in Instagram session");
  return from_session;
}

async function prepare_list_page(
  page,
  { source, url, session_username } = {},
) {
  const username = await resolve_list_username({
    page,
    source,
    url,
    session_username,
  });
  const targets = list_page_urls(source, url, username);
  if (!page || typeof page.goto !== "function") return;
  if (targets[0]) await page.goto(targets[0], { waitUntil: "domcontentloaded" });
}

async function collect_list({
  page,
  source,
  url,
  session_username,
  limit,
  should_stop,
} = {}) {
  const username = await resolve_list_username({
    page,
    source,
    url,
    session_username,
  });
  const items = [];
  const seen = new Set();
  const intercepted = [];
  attach_graphql_intercept(page, intercepted);
  const targets = list_page_urls(source, url, username);
  for (const target of targets) {
    if (page && typeof page.goto === "function")
      await page.goto(target, { waitUntil: "domcontentloaded" });
    if (page && page.keyboard && page.keyboard.press)
      await page.keyboard.press("End").catch(() => {});
    for (const item of intercepted.concat(harvest_items_from_payload({}))) {
      if (!item || seen.has(item.shortcode)) continue;
      seen.add(item.shortcode);
      items.push(item);
    }
    if (limit && items.length >= limit) break;
    if (should_stop && (await should_stop(items))) break;
  }
  return limit ? items.slice(0, limit) : items;
}
```

Export `list_page_urls` and `resolve_list_username`.

In `lib/xsave_instagram/run_export.js`, change the assert guard to:

```js
  if (
    (source === "like" || source === "collection") &&
    !(options && options.signer) &&
    resolved.assert_logged_in_profile
  ) {
```

Do not change cookie / session / collect / download.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/xsave_instagram_chrome_client.test.js test/xsave_instagram_cli.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/xsave_instagram/chrome_client.js lib/xsave_instagram/run_export.js test/xsave_instagram_chrome_client.test.js test/xsave_instagram_cli.test.js
git commit -m "fix: open Instagram likes from your_activity and skip profile match for --signer"
```

---

### Task 4: Douyin session `sec_user_id` for `--signer`

**Files:**
- Modify: `lib/xsave_douyin/chrome_client.js`
- Modify: `lib/xsave_douyin/run_export.js`
- Test: `test/xsave_douyin_chrome_client.test.js`
- Test: `test/xsave_douyin_cli.test.js`

**Interfaces:**
- Consumes: `extract_sec_user_id_from_url(raw_url)`, existing `prepare_list_page(page, { mode, url, sec_user_id })`
- Produces:
  - `async function resolve_session_sec_user_id(page): Promise<string>`
  - `run_export` `load_default_deps` includes `resolve_session_sec_user_id`
  - After the Chrome session is open, if `options.signer` and `sec_user_id` is still empty, call `resolved.resolve_session_sec_user_id(page)`
  - If still empty, log `source <source> requires a logged-in Douyin session`, doctor hint, exit `1`
  - Existing URL-based `extract_sec_user_id` stays for non-signer runs

- [ ] **Step 1: Write the failing chrome and export tests**

Add to `test/xsave_douyin_chrome_client.test.js` (import `resolve_session_sec_user_id`):

```js
  it("resolves sec_user_id from the session homepage or a /user/ link", async () => {
    const from_location = await resolve_session_sec_user_id({
      goto: async () => {},
      url: () => "https://www.douyin.com/user/MS4wLjSESSION",
    });
    expect(from_location).toBe("MS4wLjSESSION");
    const from_link = await resolve_session_sec_user_id({
      goto: async () => {},
      url: () => "https://www.douyin.com/",
      evaluate: async () => "https://www.douyin.com/user/MS4wLjLINK",
    });
    expect(from_link).toBe("MS4wLjLINK");
    expect(await resolve_session_sec_user_id(null)).toBe("");
  });
```

Add to `test/xsave_douyin_cli.test.js`:

```js
  it("uses session sec_user_id when signer is set and url is empty", async () => {
    const { run_export } = require("../lib/xsave_douyin/run_export");
    const seen = {};
    const result = await run_export(
      {
        source: "like",
        url: "",
        signer: true,
        dry_run: true,
        output: "/tmp/xsave-dy-signer",
        max_comment: 0,
        max_danmaku: 0,
        chrome_profile: "nori",
      },
      {
        resolve_cookie: async () => "dummy",
        open_session: async () => ({ page: { id: "session" }, close: async () => {} }),
        resolve_session_sec_user_id: async (page) => {
          seen.page = page;
          return "MS4wLjFROMSESSION";
        },
        attach_list_intercept: () => [],
        prepare_list_page: async (_page, args) => {
          seen.prepare = args;
        },
        collect_list: async (args) => {
          seen.collect = args;
          return [];
        },
        log: () => {},
      },
    );
    expect(result.exit_code).toBe(0);
    expect(seen.page).toEqual({ id: "session" });
    expect(seen.prepare.sec_user_id).toBe("MS4wLjFROMSESSION");
    expect(seen.collect.sec_user_id).toBe("MS4wLjFROMSESSION");
  });

  it("fails signer export when session sec_user_id is missing", async () => {
    const { run_export } = require("../lib/xsave_douyin/run_export");
    const errors = [];
    const result = await run_export(
      {
        source: "collection",
        url: "",
        signer: true,
        dry_run: true,
        output: "/tmp/xsave-dy-signer-miss",
        max_comment: 0,
        max_danmaku: 0,
        chrome_profile: "nori",
      },
      {
        resolve_cookie: async () => "dummy",
        open_session: async () => ({ page: {}, close: async () => {} }),
        resolve_session_sec_user_id: async () => "",
        collect_list: async () => [],
        log: () => {},
        error: (text) => errors.push(String(text)),
      },
    );
    expect(result.exit_code).toBe(1);
    expect(errors.join("\n")).toMatch(
      /source collection requires a logged-in Douyin session/,
    );
  });
```

Note: Douyin `run_export` always merges `load_default_deps()`. Injected `open_session` / `collect_list` still run the real session path unless `dry_run` skips it. `needs_session` is `!options.dry_run || !deps.collect_list`. These tests set `dry_run: true` **and** `collect_list`, so `page` stays `null` unless the implementation opens a session for `--signer`. After the session-resolve block is added, **open the session when `options.signer` needs `sec_user_id`**, even on dry-run, if `resolve_session_sec_user_id` is present and `sec_user_id` is empty. Concrete rule in `run_export`:

```js
  const needs_session =
    !options.dry_run || !deps.collect_list || Boolean(options && options.signer && !sec_user_id);
```

Keep this exact condition so the tests above get a `page` from `open_session`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xsave_douyin_chrome_client.test.js test/xsave_douyin_cli.test.js --testNamePattern="resolves sec_user_id from the session|uses session sec_user_id|fails signer export"`

Expected: FAIL — `resolve_session_sec_user_id` is not exported; collect sees empty `sec_user_id`.

- [ ] **Step 3: Write minimal implementation**

In `lib/xsave_douyin/chrome_client.js`, add next to `extract_sec_user_id_from_url` and export both:

```js
async function resolve_session_sec_user_id(page) {
  if (!page || typeof page.goto !== "function") return "";
  await page.goto("https://www.douyin.com/", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  const current = typeof page.url === "function" ? page.url() : "";
  const from_location = extract_sec_user_id_from_url(current);
  if (from_location) return from_location;
  if (typeof page.evaluate !== "function") return "";
  const href = await page
    .evaluate(() => {
      const link = document.querySelector('a[href*="/user/"]');
      return link ? String(link.href || link.getAttribute("href") || "") : "";
    })
    .catch(() => "");
  return extract_sec_user_id_from_url(href);
}
```

Export `extract_sec_user_id_from_url` and `resolve_session_sec_user_id`.

In `lib/xsave_douyin/run_export.js` `load_default_deps`, add:

```js
    resolve_session_sec_user_id: chrome_client.resolve_session_sec_user_id,
```

Change session + `sec_user_id` handling to:

```js
  let sec_user_id =
    (options && options.sec_user_id) ||
    extract_sec_user_id(options && options.url);
  const aweme_id =
    (options && options.aweme_id) || extract_aweme_id(options && options.url);
  const limit = item_limit;

  let session = null;
  let page = resolved.page || null;
  const needs_session =
    !options.dry_run ||
    !deps.collect_list ||
    Boolean(options && options.signer && !sec_user_id);
  if (needs_session && !page) {
    logger.debug("Opening Chrome session");
    logger.log("Complete any Douyin captcha in the Chrome window");
    try {
      session = await resolved.open_session({ cookie_header, chrome_profile });
      page = session.page;
    } catch (error) {
      logger.error(error.message || String(error));
      logger.error(doctor_hint(chrome_profile));
      return finish(1);
    }
  }

  if (options && options.signer && !sec_user_id) {
    try {
      const resolve = resolved.resolve_session_sec_user_id;
      sec_user_id = resolve ? await resolve(page) : "";
    } catch (error) {
      logger.error(error.message || String(error));
      logger.error(doctor_hint(chrome_profile));
      if (session && session.close) await session.close();
      return finish(1);
    }
    if (!sec_user_id) {
      logger.error(`source ${source} requires a logged-in Douyin session`);
      logger.error(doctor_hint(chrome_profile));
      if (session && session.close) await session.close();
      return finish(1);
    }
  }
```

Leave `prepare_list_page` / `collect_list` as they are; they already take `sec_user_id`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/xsave_douyin_chrome_client.test.js test/xsave_douyin_cli.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/xsave_douyin/chrome_client.js lib/xsave_douyin/run_export.js test/xsave_douyin_chrome_client.test.js test/xsave_douyin_cli.test.js
git commit -m "feat: resolve Douyin sec_user_id from the session for --signer"
```

---

### Task 5: Rewrite keeps `--signer` and no invented URL

**Files:**
- Modify: `lib/xsave_instagram/rewrite_command.js` (only if a test fails)
- Modify: `lib/xsave_douyin/rewrite_command.js` (only if a test fails)
- Test: `test/xsave_instagram_rewrite_command.test.js`
- Test: `test/xsave_douyin_rewrite_command.test.js`

**Interfaces:**
- Consumes: existing `rewrite_xsave_instagram_command_text` / `rewrite_xsave_douyin_command_text`
- Produces: `xsave_* like --signer` and `xsave_* collection --signer` round-trip unchanged; no URL inserted

Today both rewriters keep unknown tokens in `kept` and only emit a URL when one was found. Lock that with tests. If a test fails because rewrite requires a URL, stop inventing one: only push `url` when it is non-empty.

- [ ] **Step 1: Write the failing rewrite tests**

Add to `test/xsave_instagram_rewrite_command.test.js`:

```js
  it("keeps like --signer without inventing a url", () => {
    expect(
      rewrite_xsave_instagram_command_text("xsave_instagram like --signer"),
    ).toBe("xsave_instagram like --signer");
    expect(
      rewrite_xsave_instagram_command_text(
        "xsave_instagram collection --signer --dry-run",
      ),
    ).toBe("xsave_instagram collection --signer --dry-run");
  });
```

Add to `test/xsave_douyin_rewrite_command.test.js`:

```js
  it("keeps like --signer without inventing a url", () => {
    expect(rewrite_xsave_douyin_command_text("xsave_douyin like --signer")).toBe(
      "xsave_douyin like --signer",
    );
    expect(
      rewrite_xsave_douyin_command_text(
        "xsave_douyin collection --signer --dry-run",
      ),
    ).toBe("xsave_douyin collection --signer --dry-run");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xsave_instagram_rewrite_command.test.js test/xsave_douyin_rewrite_command.test.js --testNamePattern="keeps like --signer"`

Expected: PASS if current keep-token behavior already matches; FAIL only if rewrite drops `--signer` or inserts a URL. If they PASS, do not change rewrite source; still commit the tests in Step 5.

- [ ] **Step 3: Write minimal implementation (only if Step 2 failed)**

Instagram `rewrite_xsave_instagram_command_text` already does:

```js
  const out = ["xsave_instagram"];
  if (source) out.push(source);
  if (url) out.push(url);
  for (const token of kept) out.push(quote_token(token));
```

Keep that `if (url)` guard. Do not treat `--signer` as a URL.

Douyin `rewrite_xsave_douyin_command_text` already does the same `if (url)` push after scanning `kept`. Do not add a placeholder URL when `--signer` is present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/xsave_instagram_rewrite_command.test.js test/xsave_douyin_rewrite_command.test.js test/xsave_instagram_cli.test.js test/xsave_douyin_cli.test.js test/xsave_instagram_chrome_client.test.js test/xsave_douyin_chrome_client.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/xsave_instagram_rewrite_command.test.js test/xsave_douyin_rewrite_command.test.js lib/xsave_instagram/rewrite_command.js lib/xsave_douyin/rewrite_command.js
git commit -m "test: keep xsave like --signer when rewriting gather commands"
```

Stage rewrite source files only when Step 3 changed them.

After the worktree commits succeed, merge the task branch back into the original branch, remove the temporary worktree, and delete the task branch.

---

## Spec coverage

| Spec section | Task |
|---|---|
| Invocation / parse rules / errors | 1, 2 |
| Instagram likes URL + collection session user + skip assert | 3 |
| Douyin session `sec_user_id` + logged-in error | 4 |
| Help examples | 1, 2 |
| gather unchanged / rewrite keeps `--signer` | 5 (rewrite only; gather files not edited) |
| `instagram_likes_export` unchanged | no task edits that file |
| No live login tests | all tasks inject Chrome/collect |
