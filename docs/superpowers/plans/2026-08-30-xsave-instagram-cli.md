# xsave_instagram CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `xsave_instagram` as a Chrome media-library exporter with the same positional source+URL contract as `xsave_douyin`, and wire it into `gather` / `gather doctor`.

**Architecture:** Independent `lib/xsave_instagram/` package. `parse_cli` owns the public grammar. `run_export` plans, downloads, and writes meta/comment sidecars using `shortcode`. `chrome_client` owns the persistent Chrome session, GraphQL harvest, comments, and logged-in profile checks. `gather` emits `xsave_instagram post <url>` and injects `--chrome-profile`. Do not require `lib/xsave_douyin/*`.

**Tech Stack:** Node.js, yargs, Playwright, Vitest, existing `lib/gather_doctor/*`.

## Global Constraints

- Invocation: `xsave_instagram <source> <url> [options]` or `xsave_instagram <item-url> [options]`.
- Allowed sources: `like`, `post`, `collection`, `video`.
- Infer `video` only for item URLs (`/p/<code>` or `/reel/<code>`). Short hosts `instagr.am` and `l.instagram.com` never infer source.
- Shared flags only: `--output`, `--chrome-profile`, `--max-comment`, `--limit`, `--full-scan`, `--refresh`, `--cookie-file`, `--dry-run`, `--quiet`, `--debug`, `-h`, `-v`. No `--max-danmaku`.
- Parsed fields only: `source`, `url`, `output`, `full_scan`, `limit`, `refresh`, `cookie_file`, `chrome_profile`, `max_comment`, `dry_run`, `quiet`, `debug`.
- `--max-comment 0` means do not fetch. Do not use `Number(value) || DEFAULT`.
- `--limit` must be a positive integer. When omitted, fall back to `COMMAND_BASE_F2_LIKE_LIMIT` if that env var is a positive integer; otherwise `limit` is `0`. Do not document the env var in help.
- Default output is `DEFAULT_F2_OUTPUT_DIR/instagram/<source>`.
- Item identity is `shortcode` (`pk` secondary). No `aweme_id`. No danmaku files or stats.
- `like` / `collection` fail at runtime unless the URL profile matches the logged-in username (case-insensitive; strip leading `@` and trailing `/`).
- `post` merges Posts + Reels. `collection` is all saved items.
- `gather --refresh` does not add `--refresh` to `xsave_instagram`.
- Do not modify `lib/xsave_douyin/*` or `instagram_likes_export`.
- Naming: `snake_case` files/vars/functions; `function` keyword for pure helpers; named exports.
- Two or more repo-owned source files → isolated git worktree from the original branch, commit there, merge back, delete the worktree and task branch.
- Do not commit files under `tmp/`.

## File structure

| Path | Responsibility |
|------|----------------|
| `bin/xsave_instagram` | Parse, help/version, call `run_export` |
| `lib/xsave_instagram/parse_cli.js` | Help text, positional source/URL parse, flags |
| `lib/xsave_instagram/classify.js` | Visible if playable media exists |
| `lib/xsave_instagram/plan_item.js` | skip / fill / download |
| `lib/xsave_instagram/media_path.js` | Stem + find existing media by shortcode |
| `lib/xsave_instagram/sidecar.js` | meta + comments JSON |
| `lib/xsave_instagram/download_media.js` | Image / video / carousel download |
| `lib/xsave_instagram/run_export.js` | Cookie, session check, collect, plan, write, stats |
| `lib/xsave_instagram/chrome_client.js` | Persistent Chrome, GraphQL harvest, comments, session user |
| `lib/xsave_instagram/rewrite_command.js` | Normalize `xsave_instagram` command strings |
| `bin/gather` | Platform `instagram`, chrome-profile inject, infer, rewrite chain |
| `lib/gather_doctor/constants.js` | Key, alias `ig`, hosts, handle base, probe URL |
| `lib/gather_doctor/adapter/instagram.js` | doctor check/fix |
| `lib/gather_doctor/adapter/index.js` | Register adapter |
| `docs/superpowers/specs/2026-08-30-xsave-instagram-cli-design.md` | Approved spec (read-only) |

---

### Task 1: parse_cli, help, and bin stub

**Files:**
- Create: `lib/xsave_instagram/parse_cli.js`
- Create: `bin/xsave_instagram`
- Create: `test/xsave_instagram_cli.test.js`
- Test: `test/xsave_instagram_cli.test.js`

**Interfaces:**
- Consumes: yargs, `package.json` version
- Produces:
  - `ALLOWED_SOURCES = ["like", "post", "collection", "video"]`
  - `function parse_cli(argv: string[]): { help?: true, version?: true, version_text?: string, source: string, url: string, output: string, full_scan: boolean, limit: number, refresh: boolean, cookie_file: string, chrome_profile: string, max_comment: number, dry_run: boolean, quiet: boolean, debug: boolean }`
  - `function build_help_text(script_name?: string): string`
  - `bin/xsave_instagram` exports `{ main }` and exits with parse/`run_export` codes
  - Error messages exactly as in the spec

Create the isolated worktree before editing (original branch is the workspace branch at start). Link `node_modules` into the worktree. `chmod +x bin/xsave_instagram`.

- [ ] **Step 1: Write the failing parse and help tests**

Create `test/xsave_instagram_cli.test.js`:

```js
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { parse_cli } = require("../lib/xsave_instagram/parse_cli");

const cli_entry = path.resolve(__dirname, "../bin/xsave_instagram");

function run_cli(args) {
  return new Promise((resolve) => {
    execFile(
      cli_entry,
      args,
      {
        env: { ...process.env, FORCE_COLOR: "0" },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exit_code: error ? error.code || 1 : 0,
        });
      },
    );
  });
}

describe("xsave_instagram CLI", () => {
  it("prints help with usage description options and examples", async () => {
    const result = await run_cli(["-h"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toMatch(/Usage/);
    expect(result.stdout).toMatch(/Description/);
    expect(result.stdout).toMatch(/Options/);
    expect(result.stdout).toMatch(/like, post, collection, video/);
    expect(result.stdout).toMatch(/gather runtime/);
    expect(result.stdout).toMatch(/export paths/);
    expect(result.stdout).toMatch(/--full-scan/);
    expect(result.stdout).toMatch(/--output/);
    expect(result.stdout).toMatch(/--limit/);
    expect(result.stdout).toMatch(/--refresh/);
    expect(result.stdout).toMatch(/--cookie-file/);
    expect(result.stdout).toMatch(/# Download liked posts/);
    expect(result.stdout).toMatch(/\$0 like /);
    expect(result.stdout).toMatch(/\$0 post /);
    expect(result.stdout).toMatch(/\$0 --full-scan like /);
    expect(result.stdout).toMatch(/\$0 --dry-run collection /);
    expect(result.stdout).not.toMatch(/--max-danmaku/);
    expect(result.stdout).not.toMatch(/COMMAND_BASE_F2_LIKE_LIMIT/);
  });

  it("prints only the version number", async () => {
    const result = await run_cli(["-v"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toBe("1.0.1");
  });

  it("rejects unknown options", async () => {
    const result = await run_cli(["--nope"]);
    expect(result.exit_code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Unknown option/);
  });

  it("rejects --max-danmaku as unknown", async () => {
    const result = await run_cli([
      "like",
      "https://www.instagram.com/example_user/",
      "--max-danmaku",
      "1",
    ]);
    expect(result.exit_code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Unknown option/);
  });

  it("parses source and url positionals", () => {
    const options = parse_cli([
      "like",
      "https://www.instagram.com/example_user/",
      "--max-comment",
      "12",
    ]);
    expect(options.source).toBe("like");
    expect(options.url).toBe("https://www.instagram.com/example_user/");
    expect(options.max_comment).toBe(12);
    expect(options.output).toBe("");
    expect(options.full_scan).toBe(false);
    expect(options.limit).toBe(0);
    expect(options.refresh).toBe(false);
    expect(options.cookie_file).toBe("");
    expect(options.chrome_profile).toBe("");
    expect(options.max_danmaku).toBeUndefined();
  });

  it("infers video from a /p/ url and a /reel/ url", () => {
    expect(parse_cli(["https://www.instagram.com/p/AbCdEfGhIjK/"]).source).toBe(
      "video",
    );
    expect(
      parse_cli(["https://www.instagram.com/reel/AbCdEfGhIjK/"]).source,
    ).toBe("video");
  });

  it("accepts explicit video with a short url", () => {
    const options = parse_cli(["video", "https://instagr.am/p/AbCdEfGhIjK/"]);
    expect(options.source).toBe("video");
    expect(options.url).toBe("https://instagr.am/p/AbCdEfGhIjK/");
  });

  it("requires source for short and profile urls", () => {
    expect(() => parse_cli(["https://instagr.am/p/AbCdEfGhIjK/"])).toThrow(
      /Missing source/,
    );
    expect(() => parse_cli(["https://l.instagram.com/p/AbCdEfGhIjK/"])).toThrow(
      /Missing source/,
    );
    expect(() =>
      parse_cli(["https://www.instagram.com/example_user/"]),
    ).toThrow(/Missing source/);
  });

  it("rejects unknown source, extra args, and mismatches", () => {
    expect(() =>
      parse_cli(["one", "https://www.instagram.com/p/AbCdEfGhIjK/"]),
    ).toThrow(/Invalid source one/);
    expect(() =>
      parse_cli(["like", "https://www.instagram.com/a/", "extra"]),
    ).toThrow(/Unexpected argument extra/);
    expect(() =>
      parse_cli(["video", "https://www.instagram.com/example_user/"]),
    ).toThrow(/source video does not match profile URL/);
    expect(() =>
      parse_cli(["like", "https://www.instagram.com/p/AbCdEfGhIjK/"]),
    ).toThrow(/source like does not match item URL/);
    expect(() =>
      parse_cli(["post", "https://www.instagram.com/reel/AbCdEfGhIjK/"]),
    ).toThrow(/source post does not match item URL/);
  });

  it("parses output full-scan limit refresh and cookie-file", () => {
    const options = parse_cli([
      "--full-scan",
      "--refresh",
      "--limit",
      "3",
      "--output",
      "/tmp/ig-out",
      "--cookie-file",
      "/tmp/cookies.txt",
      "post",
      "https://www.instagram.com/example_user/",
    ]);
    expect(options.source).toBe("post");
    expect(options.output).toBe("/tmp/ig-out");
    expect(options.full_scan).toBe(true);
    expect(options.limit).toBe(3);
    expect(options.refresh).toBe(true);
    expect(options.cookie_file).toBe("/tmp/cookies.txt");
  });

  it("keeps --max-comment 0", () => {
    const options = parse_cli([
      "like",
      "https://www.instagram.com/example_user/",
      "--max-comment",
      "0",
    ]);
    expect(options.max_comment).toBe(0);
  });

  it("rejects invalid --limit", () => {
    expect(() =>
      parse_cli([
        "like",
        "https://www.instagram.com/example_user/",
        "--limit",
        "0",
      ]),
    ).toThrow(/Invalid --limit/);
  });

  it("requires source and url", async () => {
    const result = await run_cli(["--dry-run"]);
    expect(result.exit_code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Missing URL/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xsave_instagram_cli.test.js`

Expected: FAIL (module or bin missing).

- [ ] **Step 3: Implement parse_cli and the bin stub**

Create `lib/xsave_instagram/parse_cli.js`:

```js
"use strict";

const package_json = require("../../package.json");

const ALLOWED_SOURCES = ["like", "post", "collection", "video"];
const LIST_SOURCES = ["like", "post", "collection"];
const DEFAULT_CHROME_PROFILE = "";
const DEFAULT_MAX_COMMENT = 500;
const RESERVED_PROFILE_SEGMENTS = new Set([
  "p",
  "reel",
  "reels",
  "stories",
  "explore",
  "accounts",
  "direct",
  "tv",
]);
const SHORT_HOSTS = new Set(["instagr.am", "l.instagram.com"]);

function build_help_text(script_name) {
  const name = script_name || "xsave_instagram";
  return [
    "Usage",
    `  ${name} <source> <url> [options]`,
    `  ${name} <item-url> [options]`,
    "",
    "Description",
    "  Export Instagram likes, posts, collections, or a single post/reel through Chrome.",
    "  Existing media is not re-downloaded unless --refresh is set. Missing sidecars are filled.",
    "  Invisible items are skipped even when a local file exists.",
    "  After the list page loads, compare recent items with local files",
    "  and resume from the last already downloaded position.",
    "  After each run, print counts for collected, download, fill, skip, and sidecars.",
    "",
    "Options",
    "      <source>                 List source: like, post, collection, video",
    "      <url>                    Instagram profile, short URL, or /p/ /reel/ URL",
    "  -o, --output <dir>           Output root (default: instagram/<source> library)",
    "      --chrome-profile <name>  Chrome profile name or directory (default: gather runtime Instagram profile)",
    "      --max-comment <n>        Max comments per item (default: 500; 0 skips comments)",
    "      --limit <n>              Process at most n items",
    "      --full-scan              Scan the entire list instead of stopping at already downloaded items (default: false)",
    "      --refresh                Re-download existing media and rewrite sidecars (default: false)",
    "      --cookie-file <path>     Cookie file instead of exporting from the Chrome profile",
    "  -d, --dry-run                Print planned actions without writing (default: false)",
    "      --quiet                  Print only warnings and errors (default: false)",
    "      --debug                  Print export paths and verbose debug logs (default: false)",
    "  -v, --version                Print the version number and exit",
    "  -h, --help                   Show this help message",
    "",
    "Examples",
    "  # Download liked posts",
    "  $0 like https://www.instagram.com/example_user/",
    "",
    "  # Download a user's posts and reels",
    "  $0 post https://www.instagram.com/example_user/",
    "",
    "  # Download a single post",
    "  $0 https://www.instagram.com/p/AbCdEfGhIjK/",
    "",
    "  # Scan the entire list instead of resuming at already downloaded items",
    "  $0 --full-scan like https://www.instagram.com/example_user/",
    "",
    "  # Preview collection export without writing files",
    "  $0 --dry-run collection https://www.instagram.com/example_user/",
  ].join("\n");
}

function is_help_flag(arg) {
  return arg === "-h" || arg === "--help";
}

function is_version_flag(arg) {
  return arg === "-v" || arg === "--version";
}

function looks_like_url(token) {
  const text = String(token || "");
  return /:\/\//.test(text) || /instagram\.com|instagr\.am/i.test(text);
}

function parsed_url(url) {
  try {
    return new URL(url);
  } catch (_error) {
    return null;
  }
}

function hostname_of(url) {
  const parsed = parsed_url(url);
  return parsed ? parsed.hostname.toLowerCase() : "";
}

function pathname_of(url) {
  const parsed = parsed_url(url);
  return parsed ? parsed.pathname : String(url || "");
}

function is_instagram_host(host) {
  return host === "instagram.com" || host.endsWith(".instagram.com");
}

function is_short_url(url) {
  return SHORT_HOSTS.has(hostname_of(url));
}

function is_item_url(url) {
  if (is_short_url(url)) return false;
  const host = hostname_of(url);
  if (!is_instagram_host(host)) return false;
  return /\/(?:p|reel)\/[A-Za-z0-9_-]+/.test(pathname_of(url));
}

function is_profile_url(url) {
  if (is_short_url(url) || is_item_url(url)) return false;
  const host = hostname_of(url);
  if (!is_instagram_host(host)) return false;
  const first = String(pathname_of(url).split("/").filter(Boolean)[0] || "");
  if (!first || RESERVED_PROFILE_SEGMENTS.has(first.toLowerCase())) return false;
  return true;
}

function parse_non_negative_int(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ${flag} ${raw}`);
  return n;
}

function parse_positive_int(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`Invalid ${flag} ${raw}. Use a positive integer`);
  return n;
}

function resolve_limit(parsed) {
  if (parsed.limit !== undefined && parsed.limit !== null) {
    return parse_positive_int(parsed.limit, "--limit");
  }
  const env = process.env.COMMAND_BASE_F2_LIKE_LIMIT;
  if (env === undefined || env === "") return 0;
  const n = Number(env);
  if (!Number.isInteger(n) || n < 1) return 0;
  return n;
}

function resolve_source_and_url(positionals) {
  if (positionals.length === 0) throw new Error("Missing URL");
  const first = String(positionals[0] || "").trim();
  if (ALLOWED_SOURCES.includes(first)) {
    const url = String(positionals[1] || "").trim();
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

function assert_source_url_match(source, url) {
  if (source === "video" && is_profile_url(url))
    throw new Error("source video does not match profile URL");
  if (LIST_SOURCES.includes(source) && is_item_url(url))
    throw new Error(`source ${source} does not match item URL`);
}

function parse_cli(argv) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.some(is_help_flag)) return { help: true };
  if (args.some(is_version_flag))
    return { version: true, version_text: package_json.version };

  const yargs = require("yargs/yargs");
  const parser = yargs(args)
    .parserConfiguration({
      "camel-case-expansion": false,
      "unknown-options-as-args": false,
    })
    .option("output", {
      alias: "o",
      type: "string",
      default: "",
      describe: "Output root",
    })
    .option("chrome-profile", {
      type: "string",
      default: DEFAULT_CHROME_PROFILE,
      describe: "Chrome profile name",
    })
    .option("max-comment", {
      type: "number",
      default: DEFAULT_MAX_COMMENT,
      describe: "Max comments per item",
    })
    .option("limit", {
      type: "number",
      describe: "Max items to process",
    })
    .option("full-scan", {
      type: "boolean",
      default: false,
      describe: "Scan the entire list",
    })
    .option("refresh", {
      type: "boolean",
      default: false,
      describe: "Re-download existing media",
    })
    .option("cookie-file", {
      type: "string",
      default: "",
      describe: "Cookie file",
    })
    .option("dry-run", {
      alias: "d",
      type: "boolean",
      default: false,
    })
    .option("quiet", {
      type: "boolean",
      default: false,
    })
    .option("debug", {
      type: "boolean",
      default: false,
    })
    .strict(true)
    .exitProcess(false)
    .help(false)
    .version(false)
    .fail((message) => {
      const text = String(message || "");
      if (/Unknown argument/i.test(text))
        throw new Error(text.replace(/Unknown argument/i, "Unknown option"));
      throw new Error(text || "Unknown option");
    });

  const parsed = parser.parse();
  const positionals = (parsed._ || []).map((token) => String(token));
  const { source, url } = resolve_source_and_url(positionals);
  assert_source_url_match(source, url);

  return {
    source,
    url,
    output: parsed.output ? String(parsed.output) : "",
    chrome_profile: parsed["chrome-profile"]
      ? String(parsed["chrome-profile"]).trim()
      : DEFAULT_CHROME_PROFILE,
    max_comment: parse_non_negative_int(
      parsed["max-comment"],
      "--max-comment",
    ),
    limit: resolve_limit(parsed),
    refresh: Boolean(parsed.refresh),
    cookie_file: parsed["cookie-file"]
      ? String(parsed["cookie-file"]).trim()
      : "",
    dry_run: Boolean(parsed["dry-run"]),
    full_scan: Boolean(parsed["full-scan"]),
    debug: Boolean(parsed.debug),
    quiet: Boolean(parsed.quiet),
  };
}

module.exports = {
  ALLOWED_SOURCES,
  DEFAULT_CHROME_PROFILE,
  DEFAULT_MAX_COMMENT,
  build_help_text,
  is_item_url,
  is_profile_url,
  is_short_url,
  parse_cli,
};
```

Create `bin/xsave_instagram`:

```js
#!/usr/bin/env node

"use strict";

const {
  build_help_text,
  parse_cli,
} = require("../lib/xsave_instagram/parse_cli");

async function main(argv) {
  let options;
  try {
    options = parse_cli(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.stderr.write(`${build_help_text("xsave_instagram")}\n`);
    return 1;
  }

  if (options.help) {
    process.stdout.write(`${build_help_text("xsave_instagram")}\n`);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${options.version_text}\n`);
    return 0;
  }

  let run_export;
  try {
    run_export = require("../lib/xsave_instagram/run_export").run_export;
  } catch (_error) {
    process.stderr.write("xsave_instagram export runner is not implemented yet\n");
    return 2;
  }

  const result = await run_export(options);
  return result && Number.isFinite(result.exit_code) ? result.exit_code : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (exit_code) => {
      process.exit(exit_code);
    },
    (error) => {
      process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
      process.exit(1);
    },
  );
}

module.exports = { main };
```

- [ ] **Step 4: Run the parse and help tests**

Run: `npx vitest run test/xsave_instagram_cli.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/xsave_instagram/parse_cli.js bin/xsave_instagram test/xsave_instagram_cli.test.js
git commit -m "$(cat <<'EOF'
feat: parse xsave_instagram as source plus URL

Match the xsave_douyin invocation. Infer video from /p/ and /reel/
URLs and reject --max-danmaku.
EOF
)"
```

---

### Task 2: classify and plan_item

**Files:**
- Create: `lib/xsave_instagram/classify.js`
- Create: `lib/xsave_instagram/plan_item.js`
- Create: `test/xsave_instagram_plan_item.test.js`
- Test: `test/xsave_instagram_plan_item.test.js`

**Interfaces:**
- Consumes: item shape `{ shortcode, is_prohibited, video_url, image_urls, carousel }`
- Produces:
  - `function has_playable_url(item): boolean`
  - `function is_item_visible(item): boolean`
  - `function classify_item(item): { visible: boolean, reason: string }`
  - `function plan_item({ item, media, sidecar_exists, refresh }): { action, reason, download, write_meta, write_comments }`
  - No `write_danmaku` field

- [ ] **Step 1: Write the failing tests**

Create `test/xsave_instagram_plan_item.test.js`:

```js
import { describe, expect, it } from "vitest";

const { plan_item } = require("../lib/xsave_instagram/plan_item");

const visible_item = {
  shortcode: "AbCdEfGhIjK",
  video_url: "https://example.com/a.mp4",
};

describe("xsave_instagram plan_item", () => {
  it("skips invisible items even when local media exists", () => {
    const planned = plan_item({
      item: { shortcode: "AbCdEfGhIjK", is_prohibited: true },
      media: { media_path: "/tmp/a.mp4", stem_path: "/tmp/a" },
      sidecar_exists: { comments: false },
    });
    expect(planned).toEqual({
      action: "skip",
      reason: "invisible",
      download: false,
      write_meta: false,
      write_comments: false,
    });
    expect(planned.write_danmaku).toBeUndefined();
  });

  it("fills comments without downloading when media exists", () => {
    const planned = plan_item({
      item: visible_item,
      media: { media_path: "/tmp/a.mp4", stem_path: "/tmp/a" },
      sidecar_exists: { comments: false },
    });
    expect(planned.action).toBe("fill");
    expect(planned.download).toBe(false);
    expect(planned.write_meta).toBe(true);
    expect(planned.write_comments).toBe(true);
  });

  it("downloads when media is missing and item is visible", () => {
    const planned = plan_item({
      item: visible_item,
      media: null,
      sidecar_exists: { comments: false },
    });
    expect(planned).toEqual({
      action: "download",
      reason: "",
      download: true,
      write_meta: true,
      write_comments: true,
    });
  });

  it("re-downloads existing media when refresh is set", () => {
    const planned = plan_item({
      item: visible_item,
      media: { media_path: "/tmp/a.mp4", stem_path: "/tmp/a" },
      sidecar_exists: { comments: true },
      refresh: true,
    });
    expect(planned).toEqual({
      action: "download",
      reason: "refresh",
      download: true,
      write_meta: true,
      write_comments: true,
    });
  });

  it("still skips invisible items when refresh is set", () => {
    const planned = plan_item({
      item: { shortcode: "AbCdEfGhIjK", is_prohibited: true },
      media: { media_path: "/tmp/a.mp4", stem_path: "/tmp/a" },
      refresh: true,
    });
    expect(planned.action).toBe("skip");
    expect(planned.download).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xsave_instagram_plan_item.test.js`

Expected: FAIL (module missing).

- [ ] **Step 3: Implement classify and plan_item**

Create `lib/xsave_instagram/classify.js`:

```js
"use strict";

function has_playable_url(item) {
  if (item && String(item.video_url || "").trim()) return true;
  const images = item && Array.isArray(item.image_urls) ? item.image_urls : [];
  if (images.some((url) => String(url || "").trim())) return true;
  const carousel = item && Array.isArray(item.carousel) ? item.carousel : [];
  return carousel.some((entry) => String((entry && entry.url) || "").trim());
}

function is_item_visible(item) {
  if (!item || typeof item !== "object") return false;
  if (item.is_prohibited) return false;
  return has_playable_url(item);
}

function classify_item(item) {
  const visible = is_item_visible(item);
  return { visible, reason: visible ? "" : "invisible" };
}

module.exports = { has_playable_url, is_item_visible, classify_item };
```

Create `lib/xsave_instagram/plan_item.js`:

```js
"use strict";

const { classify_item } = require("./classify");

function plan_item({ item, media, sidecar_exists, refresh } = {}) {
  const classified = classify_item(item);
  if (!classified.visible) {
    return {
      action: "skip",
      reason: "invisible",
      download: false,
      write_meta: false,
      write_comments: false,
    };
  }
  if (media && media.media_path && !refresh) {
    const exists = sidecar_exists || {};
    return {
      action: "fill",
      reason: "",
      download: false,
      write_meta: true,
      write_comments: !exists.comments,
    };
  }
  return {
    action: "download",
    reason: refresh && media && media.media_path ? "refresh" : "",
    download: true,
    write_meta: true,
    write_comments: true,
  };
}

module.exports = { plan_item };
```

- [ ] **Step 4: Run the plan tests**

Run: `npx vitest run test/xsave_instagram_plan_item.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/xsave_instagram/classify.js lib/xsave_instagram/plan_item.js test/xsave_instagram_plan_item.test.js
git commit -m "$(cat <<'EOF'
feat: plan xsave_instagram skip fill and refresh

Use shortcode items and comment-only sidecars. Invisible posts stay
skipped when --refresh is set.
EOF
)"
```

---

### Task 3: media_path and sidecar

**Files:**
- Create: `lib/xsave_instagram/media_path.js`
- Create: `lib/xsave_instagram/sidecar.js`
- Create: `test/xsave_instagram_media_path.test.js`
- Create: `test/xsave_instagram_sidecar.test.js`
- Test: those same files

**Interfaces:**
- Consumes: item `{ shortcode, pk, author.username, author.full_name, caption, taken_at }`
- Produces:
  - `function sidecar_paths(stem_path): { meta: string, comments: string }` — no `danmaku`
  - `function build_stem(item, output_dir): string`
  - `function find_existing_media(output_dir, shortcode): Promise<{ media_path, stem_path } | null>`
  - `function build_meta(item, fetched_at): object` — fields `shortcode`, `pk`, `author`, `title`, `desc`, `create_time`, `like_count`, `comment_count`, `online_status`, `fetched_at`
  - `function build_comments(list, max_comment): array`
  - `function write_sidecars({ stem_path, meta, comments, write_comments })`

- [ ] **Step 1: Write the failing tests**

Create `test/xsave_instagram_media_path.test.js`:

```js
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  build_stem,
  find_existing_media,
  sidecar_paths,
} = require("../lib/xsave_instagram/media_path");

describe("xsave_instagram media_path", () => {
  it("builds a stem that includes the shortcode", () => {
    const stem = build_stem(
      {
        shortcode: "AbCdEfGhIjK",
        author: { username: "nori", full_name: "Nori" },
        caption: "hello",
        taken_at: 1700000000,
      },
      "/tmp/ig",
    );
    expect(stem).toContain("AbCdEfGhIjK");
    expect(path.dirname(stem)).toBe("/tmp/ig");
    expect(sidecar_paths(stem).danmaku).toBeUndefined();
    expect(sidecar_paths(stem).comments).toBe(`${stem}_comments.json`);
  });

  it("finds existing media by shortcode", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "ig-media-"));
    const name = `"nori","AbCdEfGhIjK","Nori","2026-01-01","hello"_video.mp4`;
    await fs.writeFile(path.join(temp_root, name), "video");
    try {
      const found = await find_existing_media(temp_root, "AbCdEfGhIjK");
      expect(found.media_path).toBe(path.join(temp_root, name));
      expect(found.stem_path).toContain("AbCdEfGhIjK");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
```

Create `test/xsave_instagram_sidecar.test.js`:

```js
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  build_comments,
  build_meta,
  write_sidecars,
} = require("../lib/xsave_instagram/sidecar");

describe("xsave_instagram sidecar", () => {
  it("builds meta from shortcode fields", () => {
    const meta = build_meta(
      {
        shortcode: "AbCdEfGhIjK",
        pk: "99",
        author: { username: "nori", full_name: "Nori" },
        caption: "hello",
        taken_at: 1700000000,
        like_count: 3,
        comment_count: 2,
      },
      "2026-01-01T00:00:00.000Z",
    );
    expect(meta.shortcode).toBe("AbCdEfGhIjK");
    expect(meta.pk).toBe("99");
    expect(meta.author).toBe("Nori");
    expect(meta.aweme_id).toBeUndefined();
  });

  it("writes meta and comments and never a danmaku file", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "ig-side-"));
    const stem_path = path.join(temp_root, "item");
    try {
      await write_sidecars({
        stem_path,
        meta: { shortcode: "AbCdEfGhIjK" },
        comments: build_comments(
          [{ id: "1", text: "hi", user: { username: "a" }, created_at: 1 }],
          500,
        ),
        write_comments: true,
      });
      const names = await fs.readdir(temp_root);
      expect(names).toContain("item_meta.json");
      expect(names).toContain("item_comments.json");
      expect(names.some((name) => name.includes("danmaku"))).toBe(false);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xsave_instagram_media_path.test.js test/xsave_instagram_sidecar.test.js`

Expected: FAIL (modules missing).

- [ ] **Step 3: Implement media_path and sidecar**

Create `lib/xsave_instagram/media_path.js`:

```js
"use strict";

const fs = require("fs/promises");
const path = require("path");

const MEDIA_SUFFIXES = ["_video.mp4", "_image_1.jpeg", "_image_1.jpg"];

function sidecar_paths(stem_path) {
  return {
    meta: `${stem_path}_meta.json`,
    comments: `${stem_path}_comments.json`,
  };
}

function stem_from_media_name(file_name) {
  for (const suffix of MEDIA_SUFFIXES) {
    if (file_name.endsWith(suffix)) return file_name.slice(0, -suffix.length);
  }
  const ext = path.extname(file_name);
  if (ext) return file_name.slice(0, -ext.length);
  return file_name;
}

function file_has_shortcode(file_name, shortcode) {
  const id = String(shortcode || "").trim();
  if (!id) return false;
  return (
    file_name.includes(`"${id}"`) ||
    file_name.includes(`,${id},`) ||
    file_name.includes(`"${id}",`)
  );
}

async function list_candidate_files(output_dir) {
  const entries = [];
  let names = [];
  try {
    names = await fs.readdir(output_dir, { withFileTypes: true });
  } catch (_error) {
    return entries;
  }
  for (const entry of names) {
    const full_path = path.join(output_dir, entry.name);
    if (entry.isFile()) {
      entries.push(full_path);
      continue;
    }
    if (!entry.isDirectory()) continue;
    let nested = [];
    try {
      nested = await fs.readdir(full_path, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const child of nested) {
      if (child.isFile()) entries.push(path.join(full_path, child.name));
    }
  }
  return entries;
}

async function find_existing_media(output_dir, shortcode) {
  const files = await list_candidate_files(output_dir);
  for (const file_path of files) {
    const file_name = path.basename(file_path);
    if (!file_has_shortcode(file_name, shortcode)) continue;
    const is_media =
      MEDIA_SUFFIXES.some((suffix) => file_name.endsWith(suffix)) ||
      file_name.endsWith(".mp4") ||
      file_name.endsWith(".jpg") ||
      file_name.endsWith(".jpeg");
    if (!is_media) continue;
    let stat;
    try {
      stat = await fs.stat(file_path);
    } catch (_error) {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0) continue;
    return {
      media_path: file_path,
      stem_path: path.join(path.dirname(file_path), stem_from_media_name(file_name)),
    };
  }
  return null;
}

function build_stem(item, output_dir) {
  const shortcode = String((item && item.shortcode) || "").trim();
  const username = String((item && item.author && item.author.username) || "").trim();
  const full_name = String((item && item.author && item.author.full_name) || "").trim();
  const taken_at = String((item && item.taken_at) || "").trim();
  const caption = String((item && item.caption) || "").trim().slice(0, 40);
  const file_stem = `"${username}","${shortcode}","${full_name}","${taken_at}","${caption}"`;
  return path.join(output_dir, file_stem);
}

module.exports = {
  build_stem,
  find_existing_media,
  sidecar_paths,
};
```

Create `lib/xsave_instagram/sidecar.js`:

```js
"use strict";

const fs = require("fs/promises");
const { sidecar_paths } = require("./media_path");

const SECRET_PATTERN = /sessionid=|csrftoken=|ds_user_id=/i;

function has_secret_leak(text) {
  return SECRET_PATTERN.test(String(text || ""));
}

function number_or_undefined(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function build_meta(item, fetched_at) {
  return {
    shortcode: String((item && item.shortcode) || ""),
    pk: String((item && item.pk) || ""),
    author: String((item && item.author && item.author.full_name) || ""),
    title: String((item && item.caption) || ""),
    desc: String((item && item.caption) || ""),
    create_time: item && item.taken_at,
    like_count: number_or_undefined(item && item.like_count),
    comment_count: number_or_undefined(item && item.comment_count),
    online_status: "visible",
    fetched_at,
  };
}

function map_entry(entry) {
  const user = (entry && entry.user) || {};
  return {
    id: String((entry && (entry.pk || entry.id)) || ""),
    text: String((entry && (entry.text || entry.body)) || ""),
    author: String(user.username || user.full_name || ""),
    time: entry && (entry.created_at !== undefined ? entry.created_at : entry.time),
    like_count: number_or_undefined(entry && entry.like_count) || 0,
  };
}

function build_comments(list, max_comment) {
  const items = Array.isArray(list) ? list : [];
  const limit = Number(max_comment) || 0;
  return items.slice(0, limit).map(map_entry);
}

async function write_json(file_path, payload) {
  const text = JSON.stringify(payload, null, 2);
  if (has_secret_leak(text)) throw new Error("sidecar payload leaked secrets");
  await fs.writeFile(file_path, `${text}\n`, "utf8");
}

async function write_sidecars({ stem_path, meta, comments, write_comments }) {
  const paths = sidecar_paths(stem_path);
  if (meta) await write_json(paths.meta, meta);
  if (write_comments) await write_json(paths.comments, comments || []);
}

module.exports = {
  build_comments,
  build_meta,
  has_secret_leak,
  write_sidecars,
};
```

- [ ] **Step 4: Run the media and sidecar tests**

Run: `npx vitest run test/xsave_instagram_media_path.test.js test/xsave_instagram_sidecar.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/xsave_instagram/media_path.js lib/xsave_instagram/sidecar.js test/xsave_instagram_media_path.test.js test/xsave_instagram_sidecar.test.js
git commit -m "$(cat <<'EOF'
feat: add xsave_instagram media stems and sidecars

Resume by shortcode. Write meta and comments only.
EOF
)"
```

---

### Task 4: download_media

**Files:**
- Create: `lib/xsave_instagram/download_media.js`
- Create: `test/xsave_instagram_download.test.js`
- Test: `test/xsave_instagram_download.test.js`

**Interfaces:**
- Consumes: item `{ video_url, image_urls, carousel: [{ url, type }] }`
- Produces:
  - `function collect_media_urls(item): string[]`
  - `function first_media_url(item): string`
  - `async function download_media({ item, target_path, cookie_header, page, http_download }): Promise<{ ok: boolean, reason?: string }>`
  - Video writes `target_path` (caller uses `${stem}_video.mp4`). Image-only items write `${stem}_image_1.jpeg` when `target_path` ends with `_video.mp4` by replacing the suffix, or write `target_path` as given when it already ends with an image suffix.

- [ ] **Step 1: Write the failing tests**

Create `test/xsave_instagram_download.test.js`:

```js
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  collect_media_urls,
  download_media,
} = require("../lib/xsave_instagram/download_media");

describe("xsave_instagram download_media", () => {
  it("collects video then carousel then images", () => {
    expect(
      collect_media_urls({
        video_url: "https://example.com/a.mp4",
        image_urls: ["https://example.com/a.jpg"],
        carousel: [{ url: "https://example.com/b.jpg" }],
      }),
    ).toEqual([
      "https://example.com/a.mp4",
      "https://example.com/b.jpg",
      "https://example.com/a.jpg",
    ]);
  });

  it("writes bytes from http_download", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "ig-dl-"));
    const target_path = path.join(temp_root, "item_video.mp4");
    try {
      const result = await download_media({
        item: { video_url: "https://example.com/a.mp4" },
        target_path,
        http_download: async ({ target_path: dest }) => {
          await fs.writeFile(dest, "video");
          return { ok: true };
        },
      });
      expect(result.ok).toBe(true);
      expect(await fs.readFile(target_path, "utf8")).toBe("video");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xsave_instagram_download.test.js`

Expected: FAIL (module missing).

- [ ] **Step 3: Implement download_media**

Create `lib/xsave_instagram/download_media.js`:

```js
"use strict";

const fs = require("fs/promises");
const path = require("path");

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

function add_urls(urls, list) {
  if (!Array.isArray(list)) return;
  for (const url of list) {
    const text = String(url || "").trim();
    if (text && !urls.includes(text)) urls.push(text);
  }
}

function collect_media_urls(item) {
  const urls = [];
  if (item && String(item.video_url || "").trim())
    urls.push(String(item.video_url).trim());
  const carousel = item && Array.isArray(item.carousel) ? item.carousel : [];
  add_urls(
    urls,
    carousel.map((entry) => (entry && entry.url) || ""),
  );
  add_urls(urls, item && item.image_urls);
  return urls;
}

function first_media_url(item) {
  return collect_media_urls(item)[0] || "";
}

function download_headers(cookie_header) {
  return {
    Referer: "https://www.instagram.com/",
    "User-Agent": CHROME_UA,
    ...(cookie_header ? { Cookie: cookie_header } : {}),
  };
}

async function write_media_file(target_path, bytes) {
  await fs.mkdir(path.dirname(target_path), { recursive: true });
  await fs.writeFile(target_path, bytes);
}

async function default_http_download({ url, item, target_path, cookie_header } = {}) {
  const urls = [];
  if (url) urls.push(url);
  for (const candidate of collect_media_urls(item)) {
    if (!urls.includes(candidate)) urls.push(candidate);
  }
  if (!urls.length) return { ok: false, status: 0, reason: "missing_url" };
  let last = { ok: false, status: 0, reason: "missing_url" };
  for (const media_url of urls) {
    try {
      const response = await fetch(media_url, {
        headers: download_headers(cookie_header),
      });
      if (!response.ok) {
        last = { ok: false, status: response.status };
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) {
        last = { ok: false, status: response.status, reason: "empty" };
        continue;
      }
      await write_media_file(target_path, bytes);
      return { ok: true, status: response.status };
    } catch (error) {
      last = {
        ok: false,
        status: 0,
        reason: error && error.message ? error.message : "fetch_failed",
      };
    }
  }
  return last;
}

async function download_media({
  item,
  target_path,
  cookie_header,
  http_download,
} = {}) {
  const url = first_media_url(item);
  const download = http_download || default_http_download;
  if (!url) return { ok: false, reason: "missing_url" };
  const result = await download({
    item,
    target_path,
    url,
    cookie_header,
  });
  if (result && result.ok) return { ok: true, reason: "" };
  return { ok: false, reason: (result && result.reason) || "download_failed" };
}

module.exports = {
  CHROME_UA,
  collect_media_urls,
  default_http_download,
  download_media,
  first_media_url,
};
```

- [ ] **Step 4: Run the download tests**

Run: `npx vitest run test/xsave_instagram_download.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/xsave_instagram/download_media.js test/xsave_instagram_download.test.js
git commit -m "$(cat <<'EOF'
feat: download xsave_instagram video and image URLs

Prefer video_url, then carousel, then still images.
EOF
)"
```

---

### Task 5: run_export

**Files:**
- Create: `lib/xsave_instagram/run_export.js`
- Create: `test/xsave_instagram_export_layout.test.js`
- Create: `test/xsave_instagram_export_resume.test.js`
- Create: `test/xsave_instagram_export_stats.test.js`
- Modify: `test/xsave_instagram_cli.test.js` (add one `--refresh` / `max_comment 0` `run_export` case)
- Test: those same files

**Interfaces:**
- Consumes: `parse_cli` fields; Task 2–4 helpers
- Produces:
  - `function doctor_hint(chrome_profile): string` — `gather doctor fix --platform instagram` plus `--chrome-profile` when set
  - `function default_output_dir(source, f2_root?): string` — `…/instagram/<source>`
  - `function resolve_output_dir(options, deps)`
  - `function describe_export_layout({ source, full_scan, item_limit, … })` — prints `source:` and `full_scan:`; no danmaku line
  - `function describe_export_stats(stats)` — no `danmaku` field
  - `async function run_export(options, deps)`
  - Default deps: `open_session`, `collect_list`, `fetch_comments`, `download_media`, `resolve_cookie`, `assert_logged_in_profile`, `prepare_list_page`
  - `collect_list({ page, source, url, limit, should_stop })` returns an item array
  - `like` / `collection` call `assert_logged_in_profile` and exit `1` on throw
  - Resume `should_stop` uses `find_existing_media(output_dir, shortcode)` unless `full_scan` or `source === "video"`

- [ ] **Step 1: Write the failing layout, resume, and stats tests**

Create `test/xsave_instagram_export_layout.test.js`:

```js
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  default_output_dir,
  describe_export_layout,
  resolve_output_dir,
} = require("../lib/xsave_instagram/run_export");

describe("xsave_instagram export layout", () => {
  it("lists output paths with source and full_scan and no danmaku", () => {
    const lines = describe_export_layout({
      source: "like",
      url: "https://www.instagram.com/example_user/",
      output_dir: "/tmp/ig-out",
      chrome_profile: "Profile 9",
      runtime_path: "/tmp/gather.runtime.yaml",
      max_comment: 500,
      dry_run: false,
      item_limit: 0,
    });
    const text = lines.join("\n");
    expect(text).toMatch(/source: like/);
    expect(text).toMatch(/full_scan: false/);
    expect(text).toMatch(/sidecar comments/);
    expect(text).not.toMatch(/danmaku/);
  });

  it("defaults instagram/<source> and uses an explicit output", () => {
    expect(default_output_dir("video", "/tmp/f2")).toBe(
      path.join("/tmp/f2", "instagram", "video"),
    );
    expect(resolve_output_dir({ output: "/tmp/ig-out", source: "like" })).toBe(
      path.resolve("/tmp/ig-out"),
    );
    expect(
      resolve_output_dir(
        { source: "like", output: "" },
        { f2_output_dir: "/tmp/f2" },
      ),
    ).toBe(path.join("/tmp/f2", "instagram", "like"));
  });
});
```

Create `test/xsave_instagram_export_resume.test.js`:

```js
import { describe, expect, it } from "vitest";

const { run_export } = require("../lib/xsave_instagram/run_export");

describe("xsave_instagram export resume", () => {
  it("passes source video to collect_list and skips resume stop", async () => {
    const seen = [];
    await run_export(
      {
        source: "video",
        url: "https://www.instagram.com/p/AbCdEfGhIjK/",
        output: "/tmp",
        dry_run: true,
        chrome_profile: "nori",
      },
      {
        resolve_cookie: async () => "dummy",
        collect_list: async (opts) => {
          seen.push(opts.source);
          expect(opts.should_stop).toBeUndefined();
          return [];
        },
        assert_logged_in_profile: async () => {},
        log: () => {},
      },
    );
    expect(seen).toEqual(["video"]);
  });

  it("fails like when the session user does not match the url", async () => {
    const result = await run_export(
      {
        source: "like",
        url: "https://www.instagram.com/other_user/",
        output: "/tmp",
        dry_run: true,
        chrome_profile: "nori",
      },
      {
        resolve_cookie: async () => "dummy",
        open_session: async () => ({ page: {}, close: async () => {} }),
        assert_logged_in_profile: async () => {
          throw new Error("source like requires the logged-in profile URL");
        },
        collect_list: async () => {
          throw new Error("should not collect");
        },
        log: () => {},
        error: () => {},
      },
    );
    expect(result.exit_code).toBe(1);
  });
});
```

Create `test/xsave_instagram_export_stats.test.js`:

```js
import { describe, expect, it } from "vitest";

const {
  describe_export_stats,
  empty_export_stats,
  run_export,
} = require("../lib/xsave_instagram/run_export");

describe("xsave_instagram export stats", () => {
  it("omits danmaku from the summary", () => {
    const text = describe_export_stats(empty_export_stats()).join("\n");
    expect(text).toMatch(/collected:/);
    expect(text).toMatch(/comments:/);
    expect(text).not.toMatch(/danmaku/);
  });

  it("counts download and comments from injected list items", async () => {
    const result = await run_export(
      {
        source: "post",
        url: "https://www.instagram.com/example_user/",
        output: "/tmp",
        dry_run: true,
        max_comment: 10,
        chrome_profile: "nori",
      },
      {
        resolve_cookie: async () => "dummy",
        collect_list: async () => [
          {
            shortcode: "AbCdEfGhIjK",
            video_url: "https://example.com/a.mp4",
            author: { username: "nori" },
          },
        ],
        log: () => {},
      },
    );
    expect(result.exit_code).toBe(0);
    expect(result.stats.collected).toBe(1);
    expect(result.stats.download).toBe(1);
    expect(result.stats.danmaku).toBeUndefined();
  });
});
```

Append to `test/xsave_instagram_cli.test.js`:

```js
  it("refresh re-downloads existing library media and skips comments at 0", async () => {
    const fs = require("node:fs/promises");
    const os = require("node:os");
    const path = require("node:path");
    const { run_export } = require("../lib/xsave_instagram/run_export");
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-ig-refresh-"));
    const media_name = `"nori","AbCdEfGhIjK","Nori","2026-01-01","desc"_video.mp4`;
    await fs.writeFile(path.join(temp_root, media_name), "video");
    const download_media = async ({ target_path }) => {
      await fs.writeFile(target_path, "new");
      return { ok: true };
    };
    try {
      const result = await run_export(
        {
          source: "like",
          url: "https://www.instagram.com/example_user/",
          output: temp_root,
          refresh: true,
          max_comment: 0,
          chrome_profile: "nori",
        },
        {
          resolve_cookie: async () => "dummy",
          collect_list: async () => [
            {
              shortcode: "AbCdEfGhIjK",
              video_url: "https://example.com/a.mp4",
              author: { username: "nori" },
            },
          ],
          download_media,
          fetch_comments: async () => {
            throw new Error("should not fetch comments when max_comment is 0");
          },
          open_session: async () => ({ page: {}, close: async () => {} }),
          assert_logged_in_profile: async () => {},
          log: () => {},
        },
      );
      expect(result.exit_code).toBe(0);
      expect(result.stats.download).toBe(1);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xsave_instagram_export_layout.test.js test/xsave_instagram_export_resume.test.js test/xsave_instagram_export_stats.test.js test/xsave_instagram_cli.test.js --testNamePattern="lists output|defaults instagram|passes source video|fails like|omits danmaku|counts download|refresh re-downloads"`

Expected: FAIL (`run_export` missing).

- [ ] **Step 3: Implement run_export**

Create `lib/xsave_instagram/run_export.js` with this full file:

```js
"use strict";

const fs = require("fs/promises");
const path = require("path");
const chalk = require("chalk");
const { find_existing_media, sidecar_paths, build_stem } = require("./media_path");
const {
  DEFAULT_RUNTIME_PATH,
  DEFAULT_CHROME_USER_DATA,
  DEFAULT_F2_OUTPUT_DIR,
} = require("../gather_doctor/constants");
const { plan_item } = require("./plan_item");
const { build_meta, build_comments, write_sidecars } = require("./sidecar");

function doctor_hint(chrome_profile) {
  const profile = String(chrome_profile || "").trim();
  if (profile)
    return `gather doctor fix --platform instagram --chrome-profile ${profile}`;
  return "gather doctor fix --platform instagram";
}

async function resolve_chrome_profile(options) {
  const explicit = String((options && options.chrome_profile) || "").trim();
  if (explicit) return explicit;
  const {
    read_runtime_config,
    get_platform_runtime,
  } = require("../gather_doctor/runtime_config");
  const runtime = await read_runtime_config(options && options.runtime_path);
  const entry = get_platform_runtime(runtime.data, "instagram");
  return entry && entry.chrome_profile
    ? String(entry.chrome_profile).trim()
    : "";
}

function resolve_item_limit(options) {
  const explicit = Number(options && options.limit);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const env = Number(process.env.COMMAND_BASE_F2_LIKE_LIMIT);
  if (Number.isInteger(env) && env > 0) return env;
  return 0;
}

function default_output_dir(source, f2_root) {
  return path.join(
    f2_root || DEFAULT_F2_OUTPUT_DIR,
    "instagram",
    String(source || ""),
  );
}

function resolve_output_dir(options = {}, deps = {}) {
  const explicit = String((options && options.output) || "").trim();
  if (explicit) return path.resolve(explicit);
  return default_output_dir(
    options && options.source,
    deps.f2_output_dir || options.f2_output_dir,
  );
}

function flatten_items(pages) {
  if (!Array.isArray(pages)) return [];
  if (pages[0] && pages[0].shortcode) return pages;
  return pages.flatMap((page) => (page && page.items) || []);
}

async function file_exists(file_path) {
  try {
    const stat = await fs.stat(file_path);
    return stat.isFile() && stat.size > 0;
  } catch (_error) {
    return false;
  }
}

function describe_export_layout({
  source,
  url,
  output_dir,
  chrome_profile,
  runtime_path,
  max_comment,
  dry_run,
  full_scan,
  item_limit,
} = {}) {
  const stem = '"<username>","<shortcode>","<full_name>","<taken_at>","<caption>"';
  const root = output_dir || process.cwd();
  const limit = Number(item_limit) || 0;
  return [
    "Export plan",
    `  source: ${source || ""}`,
    `  url: ${url || ""}`,
    `  dry_run: ${Boolean(dry_run)}`,
    `  output_dir: ${root}`,
    `  item_file_stem: ${stem}`,
    `  media video: ${path.join(root, `${stem}_video.mp4`)}`,
    `  media image: ${path.join(root, `${stem}_image_1.jpeg`)}`,
    `  sidecar meta: ${path.join(root, `${stem}_meta.json`)}`,
    `  sidecar comments: ${path.join(root, `${stem}_comments.json`)} (max ${Number(max_comment) || 0})`,
    "  existing media is reused; missing sidecars are filled",
    `  full_scan: ${Boolean(full_scan)}`,
    "  default list collect stops at the first already downloaded item",
    `  chrome_profile: ${chrome_profile || "(gather runtime)"}`,
    `  chrome_user_data: ${DEFAULT_CHROME_USER_DATA}`,
    `  runtime: ${runtime_path || DEFAULT_RUNTIME_PATH}`,
    "  cookie: exported from Chrome profile (value not printed)",
    `  chrome_cdp: ${process.env.COMMAND_BASE_CHROME_CDP || "http://127.0.0.1:9222"} (used when Chrome debug port is open)`,
    `  item_limit: ${limit || "none"}`,
  ];
}

function empty_export_stats() {
  return {
    collected: 0,
    download: 0,
    fill: 0,
    skip: 0,
    download_failed: 0,
    comments: 0,
  };
}

function describe_export_stats(stats, { dry_run, elapsed_ms } = {}) {
  const counts = stats || {};
  const lines = [
    "Export summary",
    `  collected: ${Number(counts.collected) || 0}`,
    `  download: ${Number(counts.download) || 0}`,
    `  fill: ${Number(counts.fill) || 0}`,
    `  skip: ${Number(counts.skip) || 0}`,
    `  download_failed: ${Number(counts.download_failed) || 0}`,
    `  comments: ${Number(counts.comments) || 0}`,
    `  elapsed_ms: ${Number(elapsed_ms) || 0}`,
  ];
  if (dry_run) lines.push("  dry_run: true");
  return lines;
}

function create_logger(options, deps) {
  return {
    log:
      deps.log ||
      ((text) => {
        if (!options.quiet) console.log(chalk.cyan(text));
      }),
    warn: deps.warn || ((text) => console.warn(chalk.yellow(text))),
    error: deps.error || ((text) => console.error(chalk.red(text))),
    debug:
      deps.debug ||
      ((text) => {
        if (options.debug) console.log(chalk.gray(text));
      }),
  };
}

function load_default_deps() {
  const chrome_client = require("./chrome_client");
  const download = require("./download_media");
  return {
    open_session: chrome_client.open_session,
    collect_list: chrome_client.collect_list,
    fetch_comments: chrome_client.fetch_comments,
    download_media: download.download_media,
    resolve_cookie: chrome_client.resolve_cookie_header,
    assert_logged_in_profile: chrome_client.assert_logged_in_profile,
    prepare_list_page: chrome_client.prepare_list_page,
  };
}

async function sidecar_exists_flags(stem_path) {
  const paths = sidecar_paths(stem_path);
  return { comments: await file_exists(paths.comments) };
}

async function run_export(options, deps = {}) {
  const resolved = { ...load_default_deps(), ...deps };
  const logger = create_logger(options || {}, deps);
  const chrome_profile = await resolve_chrome_profile(options);
  const output_dir = resolve_output_dir(options, resolved);
  const now = resolved.now || (() => new Date().toISOString());
  const items_out = [];
  const source = options && options.source;
  const item_limit = resolve_item_limit(options);
  const started_ms = Date.now();
  const stats = empty_export_stats();

  function finish(exit_code) {
    for (const line of describe_export_stats(stats, {
      dry_run: Boolean(options && options.dry_run),
      elapsed_ms: Date.now() - started_ms,
    }))
      logger.log(line);
    return { exit_code, items: items_out, stats };
  }

  for (const line of describe_export_layout({
    source,
    url: options && options.url,
    output_dir,
    chrome_profile,
    runtime_path: (options && options.runtime_path) || DEFAULT_RUNTIME_PATH,
    max_comment: options && options.max_comment,
    dry_run: options && options.dry_run,
    full_scan: options && options.full_scan,
    item_limit,
  }))
    logger.debug(line);

  logger.debug("Resolving Instagram cookie from Chrome profile");
  let cookie_header = "";
  try {
    cookie_header = await resolved.resolve_cookie({
      chrome_profile,
      cookie_file: options && options.cookie_file,
    });
  } catch (error) {
    logger.error(error.message || String(error));
    logger.error(doctor_hint(chrome_profile));
    return finish(1);
  }
  if (!cookie_header) {
    logger.error("Missing Instagram cookie");
    logger.error(doctor_hint(chrome_profile));
    return finish(1);
  }

  let session = null;
  let page = resolved.page || null;
  const needs_session = !options.dry_run || !deps.collect_list;
  if (needs_session && !page) {
    logger.debug("Opening Chrome session");
    logger.log("Complete any Instagram captcha in the Chrome window");
    try {
      session = await resolved.open_session({ cookie_header, chrome_profile });
      page = session.page;
    } catch (error) {
      logger.error(error.message || String(error));
      logger.error(doctor_hint(chrome_profile));
      return finish(1);
    }
  }

  if (
    (source === "like" || source === "collection") &&
    resolved.assert_logged_in_profile
  ) {
    try {
      await resolved.assert_logged_in_profile({
        page,
        url: options && options.url,
        source,
      });
    } catch (error) {
      logger.error(error.message || String(error));
      logger.error(doctor_hint(chrome_profile));
      if (session && session.close) await session.close();
      return finish(1);
    }
  }

  try {
    if (page && source !== "video" && resolved.prepare_list_page) {
      logger.debug("Preparing Instagram list page");
      await resolved.prepare_list_page(page, {
        source,
        url: options.url,
      });
    }
  } catch (error) {
    logger.error(error.message || String(error));
    logger.error(doctor_hint(chrome_profile));
    if (session && session.close) await session.close();
    return finish(1);
  }

  try {
    logger.debug("Collecting Instagram item list");
    const should_stop_list =
      options.full_scan || source === "video"
        ? undefined
        : async (items) => {
            for (const item of items || []) {
              const id = String((item && item.shortcode) || "");
              if (!id) continue;
              logger.debug(`Comparing recent item ${id} with local media`);
              const media = await find_existing_media(output_dir, id);
              if (!(media && media.media_path)) continue;
              logger.log(`Resume at downloaded item ${id}`);
              return true;
            }
            return false;
          };
    const pages = await resolved.collect_list({
      page,
      source,
      url: options && options.url,
      limit: item_limit,
      should_stop: should_stop_list,
    });
    const items = item_limit
      ? flatten_items(pages).slice(0, item_limit)
      : flatten_items(pages);
    logger.log(`Collected ${items.length} item(s) for source ${source}`);
    stats.collected = items.length;

    for (const item of items) {
      const id = String((item && item.shortcode) || "");
      try {
        const media = await find_existing_media(output_dir, id);
        const stem_path = media ? media.stem_path : build_stem(item, output_dir);
        const sidecar_exists = await sidecar_exists_flags(stem_path);
        const planned = plan_item({
          item,
          media,
          sidecar_exists,
          refresh: Boolean(options && options.refresh),
        });
        items_out.push({ shortcode: id, ...planned });
        logger.log(
          `${planned.action} ${id}${planned.reason ? ` (${planned.reason})` : ""}`,
        );
        if (options.dry_run) {
          if (planned.action === "skip") stats.skip += 1;
          else if (planned.action === "fill") stats.fill += 1;
          else if (planned.action === "download") stats.download += 1;
          if (planned.write_comments) stats.comments += 1;
          continue;
        }
        if (planned.action === "skip") {
          stats.skip += 1;
          continue;
        }

        if (planned.download) {
          logger.debug(`Downloading media for ${id}`);
          const target_path = `${stem_path}_video.mp4`;
          const downloaded = await resolved.download_media({
            item,
            target_path,
            cookie_header,
            page,
          });
          if (!downloaded || !downloaded.ok) {
            const reason = (downloaded && downloaded.reason) || "download_failed";
            logger.warn(`skip ${id} (${reason})`);
            stats.download_failed += 1;
            continue;
          }
        }

        let comments = [];
        if (planned.write_comments && Number(options.max_comment) > 0) {
          logger.debug(`Fetching comments for ${id}`);
          comments = build_comments(
            await resolved.fetch_comments({
              page,
              shortcode: id,
              max_comment: options.max_comment,
            }),
            options.max_comment,
          );
        }
        await write_sidecars({
          stem_path,
          meta: build_meta(item, now()),
          comments,
          write_comments: planned.write_comments && Number(options.max_comment) > 0,
        });
        if (planned.action === "fill") stats.fill += 1;
        else stats.download += 1;
        if (planned.write_comments && Number(options.max_comment) > 0)
          stats.comments += 1;
      } catch (error) {
        logger.warn(`skip ${id} (${error.message || error})`);
        stats.skip += 1;
      }
    }
  } finally {
    if (session && session.close) await session.close();
  }

  return finish(0);
}

module.exports = {
  doctor_hint,
  default_output_dir,
  describe_export_layout,
  describe_export_stats,
  empty_export_stats,
  resolve_chrome_profile,
  resolve_output_dir,
  run_export,
};
```

`load_default_deps` will throw until Task 6 adds `chrome_client`. Tests that inject deps still work if `load_default_deps` is only called when a default is missing. Change `run_export` start to:

```js
  const resolved = deps.collect_list
    ? {
        download_media: require("./download_media").download_media,
        ...deps,
      }
    : { ...load_default_deps(), ...deps };
```

Use that exact guard so Task 5 tests pass before `chrome_client` exists.

- [ ] **Step 4: Run export tests**

Run: `npx vitest run test/xsave_instagram_export_layout.test.js test/xsave_instagram_export_resume.test.js test/xsave_instagram_export_stats.test.js test/xsave_instagram_cli.test.js test/xsave_instagram_plan_item.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/xsave_instagram/run_export.js test/xsave_instagram_export_layout.test.js test/xsave_instagram_export_resume.test.js test/xsave_instagram_export_stats.test.js test/xsave_instagram_cli.test.js
git commit -m "$(cat <<'EOF'
feat: run xsave_instagram export from source and output

Resume on shortcode, check like/collection against the session user,
and keep comment fetches off when max_comment is 0.
EOF
)"
```

---

### Task 6: chrome_client

**Files:**
- Create: `lib/xsave_instagram/chrome_client.js`
- Create: `test/xsave_instagram_chrome_client.test.js`
- Test: `test/xsave_instagram_chrome_client.test.js`

**Interfaces:**
- Consumes: Playwright, `gather_doctor/cookie_export` with `platform_key: "instagram"`
- Produces:
  - `function normalize_username(value): string`
  - `function extract_profile_username(url): string`
  - `function normalize_media_node(node): item | null`
  - `function harvest_items_from_payload(payload): item[]`
  - `async function resolve_cookie_header({ chrome_profile, cookie_file })`
  - `async function read_session_username(page)`
  - `async function assert_logged_in_profile({ page, url, source })` — throws `source <source> requires the logged-in profile URL`
  - `function default_persistent_user_data_dir()` — `~/Library/Application Support/command_base/xsave_instagram/chrome`
  - `async function open_session({ cookie_header, chrome_profile, … })` — CDP, else persistent profile, else cookie context
  - `async function collect_list({ page, source, url, limit, should_stop })` — `post` visits `/{user}/` then `/{user}/reels/`; `like` visits `/{user}/` liked activity (`https://www.instagram.com/your_activity/liked` when session matches); `collection` visits `/{user}/saved/all-posts/`; `video` opens the given item URL. Intercept `/graphql/query` JSON and normalize nodes. Call `should_stop(items)` after each harvest batch.
  - `async function fetch_comments({ page, shortcode, max_comment })`
  - `async function prepare_list_page(page, { source, url })`
  - Cookie header domain: `.instagram.com`

Do not hit live Instagram in tests. Inject `page.evaluate` / `page.goto` / `page.on`.

- [ ] **Step 1: Write the failing chrome_client tests**

Create `test/xsave_instagram_chrome_client.test.js`:

```js
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  assert_logged_in_profile,
  default_persistent_user_data_dir,
  extract_profile_username,
  harvest_items_from_payload,
  normalize_media_node,
  normalize_username,
} = require("../lib/xsave_instagram/chrome_client");

describe("xsave_instagram chrome_client", () => {
  it("normalizes usernames and profile urls", () => {
    expect(normalize_username("@Nori/")).toBe("nori");
    expect(
      extract_profile_username("https://www.instagram.com/Example_User/"),
    ).toBe("example_user");
  });

  it("harvests shortcode items from a GraphQL payload", () => {
    const items = harvest_items_from_payload({
      data: {
        user: {
          edge_owner_to_timeline_media: {
            edges: [
              {
                node: {
                  id: "99",
                  shortcode: "AbCdEfGhIjK",
                  __typename: "GraphVideo",
                  taken_at_timestamp: 1700000000,
                  video_url: "https://example.com/a.mp4",
                  display_url: "https://example.com/a.jpg",
                  edge_media_to_caption: {
                    edges: [{ node: { text: "hello" } }],
                  },
                  owner: { username: "nori", id: "1", full_name: "Nori" },
                  edge_liked_by: { count: 3 },
                  edge_media_to_comment: { count: 2 },
                },
              },
            ],
          },
        },
      },
    });
    expect(items).toHaveLength(1);
    expect(items[0].shortcode).toBe("AbCdEfGhIjK");
    expect(items[0].video_url).toBe("https://example.com/a.mp4");
    expect(normalize_media_node(null)).toBe(null);
  });

  it("asserts like/collection against the session username", async () => {
    await expect(
      assert_logged_in_profile({
        page: {
          evaluate: async () => "nori",
        },
        url: "https://www.instagram.com/other_user/",
        source: "like",
      }),
    ).rejects.toThrow(/source like requires the logged-in profile URL/);
    await assert_logged_in_profile({
      page: { evaluate: async () => "Nori" },
      url: "https://www.instagram.com/nori/",
      source: "collection",
    });
  });

  it("uses a dedicated persistent user-data dir", () => {
    const dir = default_persistent_user_data_dir();
    expect(dir).toBe(
      path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "command_base",
        "xsave_instagram",
        "chrome",
      ),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xsave_instagram_chrome_client.test.js`

Expected: FAIL (module missing).

- [ ] **Step 3: Implement chrome_client**

Create `lib/xsave_instagram/chrome_client.js`. This file is long; keep it in one module and export every name listed in Interfaces.

```js
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const repo_root = path.resolve(__dirname, "..", "..");
const { DEFAULT_CHROME_USER_DATA } = require("../gather_doctor/constants");

function load_playwright() {
  try {
    return require("playwright");
  } catch (_error) {
    return require(path.join(repo_root, "node_modules", "playwright"));
  }
}

function normalize_username(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function extract_profile_username(url) {
  try {
    const parsed = new URL(url);
    const first = String(parsed.pathname.split("/").filter(Boolean)[0] || "");
    return normalize_username(first);
  } catch (_error) {
    return "";
  }
}

function caption_from_node(node) {
  const edges =
    (node &&
      node.edge_media_to_caption &&
      Array.isArray(node.edge_media_to_caption.edges) &&
      node.edge_media_to_caption.edges) ||
    [];
  return String((edges[0] && edges[0].node && edges[0].node.text) || "").trim();
}

function carousel_from_node(node) {
  const edges =
    (node &&
      node.edge_sidecar_to_children &&
      Array.isArray(node.edge_sidecar_to_children.edges) &&
      node.edge_sidecar_to_children.edges) ||
    [];
  return edges
    .map((edge) => {
      const child = edge && edge.node;
      if (!child) return null;
      if (child.video_url)
        return { url: String(child.video_url), type: "video" };
      if (child.display_url)
        return { url: String(child.display_url), type: "image" };
      return null;
    })
    .filter(Boolean);
}

function normalize_media_node(node) {
  if (!node || typeof node !== "object") return null;
  const shortcode = String(node.shortcode || node.code || "").trim();
  if (!shortcode) return null;
  const owner = node.owner || node.user || {};
  const image_urls = [];
  if (node.display_url) image_urls.push(String(node.display_url));
  return {
    shortcode,
    pk: String(node.id || node.pk || ""),
    typename: String(node.__typename || ""),
    author: {
      username: String(owner.username || ""),
      full_name: String(owner.full_name || owner.username || ""),
    },
    caption: caption_from_node(node) || String(node.caption || ""),
    taken_at: node.taken_at_timestamp || node.taken_at || "",
    like_count:
      (node.edge_liked_by && node.edge_liked_by.count) || node.like_count || 0,
    comment_count:
      (node.edge_media_to_comment && node.edge_media_to_comment.count) ||
      node.comment_count ||
      0,
    video_url: String(node.video_url || "").trim(),
    image_urls,
    carousel: carousel_from_node(node),
    is_prohibited: Boolean(node.is_prohibited),
  };
}

function walk_for_nodes(value, found) {
  if (!value || typeof value !== "object") return;
  if (value.shortcode || value.code) {
    const item = normalize_media_node(value);
    if (item) found.push(item);
  }
  if (Array.isArray(value)) {
    for (const entry of value) walk_for_nodes(entry, found);
    return;
  }
  for (const key of Object.keys(value)) walk_for_nodes(value[key], found);
}

function harvest_items_from_payload(payload) {
  const found = [];
  walk_for_nodes(payload, found);
  const seen = new Set();
  const items = [];
  for (const item of found) {
    if (seen.has(item.shortcode)) continue;
    seen.add(item.shortcode);
    items.push(item);
  }
  return items;
}

async function resolve_cookie_header(options = {}) {
  if (options.cookie_file) {
    if (!fs.existsSync(options.cookie_file))
      throw new Error("Missing Instagram cookie");
    const raw = fs.readFileSync(options.cookie_file, "utf8").trim();
    if (raw) return raw;
    throw new Error("Missing Instagram cookie");
  }
  if (!options.chrome_profile) return "";
  const cookie_export = require("../gather_doctor/cookie_export");
  const { list_chrome_profiles } = require("../gather_doctor/chrome_profile");
  const listed = await list_chrome_profiles("", {
    chrome_profile: options.chrome_profile,
  });
  const profile = listed.profiles && listed.profiles[0];
  const directory = profile ? profile.directory : options.chrome_profile;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xsave-ig-ck-"));
  const cookies_path = path.join(tmp, "cookies.txt");
  const exported = await cookie_export.export_netscape_cookies({
    chrome_profile: directory,
    output_path: cookies_path,
    platform_key: "instagram",
  });
  if (!exported.ok) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error("cookie export failed");
  }
  const header = await cookie_export.netscape_to_cookie_header(
    cookies_path,
    "instagram",
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  return header;
}

function header_to_cookies(header) {
  return String(header || "")
    .split(";")
    .map((part) => {
      const text = part.trim();
      const idx = text.indexOf("=");
      if (idx < 1) return null;
      return {
        name: text.slice(0, idx),
        value: text.slice(idx + 1),
        domain: ".instagram.com",
        path: "/",
      };
    })
    .filter(Boolean);
}

async function read_session_username(page) {
  if (!page || typeof page.evaluate !== "function") return "";
  const raw = await page.evaluate(() => {
    const input = document.querySelector('input[name="username"]');
    if (input && input.value) return String(input.value);
    const alt = document.querySelector(
      'img[alt$="profile picture"], img[alt$="的头像"]',
    );
    const from_alt = alt && alt.getAttribute("alt");
    if (from_alt) return String(from_alt).replace(/'s profile picture.*$/i, "");
    return "";
  });
  return normalize_username(raw);
}

async function assert_logged_in_profile({ page, url, source } = {}) {
  const wanted = extract_profile_username(url);
  const session = await read_session_username(page);
  if (!wanted || !session || wanted !== session) {
    throw new Error(`source ${source} requires the logged-in profile URL`);
  }
}

function default_persistent_user_data_dir() {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "command_base",
    "xsave_instagram",
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

async function resolve_profile_source_dir({
  chrome_profile,
  chrome_user_data_dir,
  profile_source_dir,
} = {}) {
  if (profile_source_dir) return profile_source_dir;
  const wanted = String(chrome_profile || "").trim();
  if (!wanted) return "";
  const { list_chrome_profiles } = require("../gather_doctor/chrome_profile");
  const listed = await list_chrome_profiles(chrome_user_data_dir || "", {
    chrome_profile: wanted,
  });
  const directory =
    listed.profiles && listed.profiles[0]
      ? listed.profiles[0].directory
      : wanted;
  const root = listed.root || DEFAULT_CHROME_USER_DATA;
  return path.join(root, directory);
}

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
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
    chromiumSandbox: true,
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

async function open_cookie_session({ cookie_header, playwright } = {}) {
  if (!cookie_header) throw new Error("missing instagram cookie");
  const { chromium } = playwright || load_playwright();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
  });
  await context.addCookies(header_to_cookies(cookie_header));
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    async close() {
      await browser.close();
    },
  };
}

function chrome_cdp_url() {
  return (
    String(process.env.COMMAND_BASE_CHROME_CDP || "").trim() ||
    "http://127.0.0.1:9222"
  );
}

async function try_open_cdp_session(playwright) {
  const { chromium } = playwright || load_playwright();
  if (!chromium || typeof chromium.connectOverCDP !== "function") return null;
  try {
    const browser = await chromium.connectOverCDP(chrome_cdp_url());
    const context =
      browser.contexts && browser.contexts()[0] ? browser.contexts()[0] : null;
    if (!context) {
      await browser.close();
      return null;
    }
    const page =
      typeof context.newPage === "function"
        ? await context.newPage()
        : context.pages && context.pages()[0];
    if (!page) {
      await browser.close();
      return null;
    }
    if (typeof page.setDefaultTimeout === "function")
      page.setDefaultTimeout(30000);
    return {
      browser,
      context,
      page,
      async close() {
        await browser.close();
      },
    };
  } catch (_error) {
    return null;
  }
}

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

function list_page_urls(source, url) {
  const username = extract_profile_username(url);
  if (source === "video") return [String(url || "")];
  if (source === "like")
    return ["https://www.instagram.com/your_activity/liked"];
  if (source === "collection" && username)
    return [`https://www.instagram.com/${username}/saved/all-posts/`];
  if (source === "post" && username)
    return [
      `https://www.instagram.com/${username}/`,
      `https://www.instagram.com/${username}/reels/`,
    ];
  return [String(url || "")];
}

function attach_graphql_intercept(page, bucket) {
  if (!page || typeof page.on !== "function") return;
  page.on("response", async (response) => {
    try {
      const url = String((response && response.url && response.url()) || "");
      if (!/graphql\/query/i.test(url)) return;
      const json = await response.json();
      bucket.push(...harvest_items_from_payload(json));
    } catch (_error) {
      /* ignore non-json */
    }
  });
}

async function prepare_list_page(page, { source, url } = {}) {
  const targets = list_page_urls(source, url);
  if (!page || typeof page.goto !== "function") return;
  if (targets[0]) await page.goto(targets[0], { waitUntil: "domcontentloaded" });
}

async function collect_list({
  page,
  source,
  url,
  limit,
  should_stop,
} = {}) {
  const items = [];
  const seen = new Set();
  const intercepted = [];
  attach_graphql_intercept(page, intercepted);
  const targets = list_page_urls(source, url);
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

async function fetch_comments({ page, shortcode, max_comment } = {}) {
  const limit = Number(max_comment) || 0;
  if (!limit || !page || typeof page.evaluate !== "function") return [];
  const payload = await page.evaluate(
    async ({ code, cap }) => {
      const response = await fetch(
        `/api/v1/media/${code}/comments/?can_support_threading=true`,
        { credentials: "include" },
      );
      const json = await response.json().catch(() => ({}));
      const list = Array.isArray(json.comments) ? json.comments : [];
      return list.slice(0, cap);
    },
    { code: shortcode, cap: limit },
  );
  return Array.isArray(payload) ? payload.slice(0, limit) : [];
}

module.exports = {
  assert_logged_in_profile,
  collect_list,
  default_persistent_user_data_dir,
  extract_profile_username,
  fetch_comments,
  harvest_items_from_payload,
  normalize_media_node,
  normalize_username,
  open_session,
  prepare_list_page,
  read_session_username,
  resolve_cookie_header,
};
```

After this file exists, remove the Task 5 `deps.collect_list` guard in `run_export` if you prefer always calling `load_default_deps`. Either is fine as long as injected tests still pass.

- [ ] **Step 4: Run chrome_client and export tests**

Run: `npx vitest run test/xsave_instagram_chrome_client.test.js test/xsave_instagram_export_layout.test.js test/xsave_instagram_export_resume.test.js test/xsave_instagram_export_stats.test.js test/xsave_instagram_cli.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/xsave_instagram/chrome_client.js test/xsave_instagram_chrome_client.test.js lib/xsave_instagram/run_export.js
git commit -m "$(cat <<'EOF'
feat: add xsave_instagram Chrome harvest and session check

Normalize GraphQL media nodes, persist a local Chrome user-data
dir, and require like/collection URLs to match the logged-in user.
EOF
)"
```

---

### Task 7: rewrite_command and gather

**Files:**
- Create: `lib/xsave_instagram/rewrite_command.js`
- Create: `test/xsave_instagram_rewrite_command.test.js`
- Modify: `bin/gather` (`F2_COMMANDS`, `PLATFORM_ALIASES`, `PLATFORM_COMMANDS`, `PLATFORM_HANDLE_BASE_URLS`, `DEFAULT_CONFIG_LINES`, `rewrite_f2_command_text`, `infer_command_platform_keys`, `build_runtime_cookie_args`)
- Modify: `test/gather.test.js` (add Instagram config helper + three cases)
- Test: `test/xsave_instagram_rewrite_command.test.js`, `test/gather.test.js`

**Interfaces:**
- Consumes: gather command text / config URLs
- Produces:
  - `function rewrite_xsave_instagram_command_text(command_text: string): string`
  - `PLATFORM_COMMANDS.instagram = { command: "xsave_instagram", build_args: (url) => ["post", url], label: "instagram" }`
  - `PLATFORM_ALIASES.ig = "instagram"`
  - `PLATFORM_HANDLE_BASE_URLS.instagram = "https://www.instagram.com/"`
  - `F2_COMMANDS` includes `"xsave_instagram"`
  - `rewrite_f2_command_text` runs Douyin rewrite then Instagram rewrite
  - `build_runtime_cookie_args` injects `--chrome-profile` for `xsave_instagram` + `instagram`
  - gather `--refresh` does not add `--refresh` for Instagram
  - `instagram_likes_export` lines are unchanged

Exact `bin/gather` edits:

1. `F2_COMMANDS`:

```js
const F2_COMMANDS = new Set([
  "f2",
  F2_COMPAT_COMMAND,
  "xsave_douyin",
  "xsave_instagram",
]);
```

2. Add to `DEFAULT_CONFIG_LINES` after the douyin example:

```js
  "  instagram:",
  "    - name: Example Instagram user",
  "      handle: https://www.instagram.com/example_user/",
```

3. `PLATFORM_ALIASES.ig = "instagram";`

4. In `PLATFORM_COMMANDS`:

```js
  instagram: {
    command: "xsave_instagram",
    build_args: (url) => ["post", url],
    label: "instagram",
  },
```

5. `PLATFORM_HANDLE_BASE_URLS.instagram = "https://www.instagram.com/";`

6. Replace `rewrite_f2_command_text` with:

```js
function rewrite_f2_command_text(command_text) {
  const {
    rewrite_xsave_douyin_command_text,
  } = require("../lib/xsave_douyin/rewrite_command");
  const {
    rewrite_xsave_instagram_command_text,
  } = require("../lib/xsave_instagram/rewrite_command");
  return rewrite_xsave_instagram_command_text(
    rewrite_xsave_douyin_command_text(command_text),
  );
}
```

7. In `infer_command_platform_keys`, after the douyin block:

```js
  if (
    /\bxsave_instagram\b/.test(normalized_command) ||
    normalized_command.includes("instagram.com") ||
    normalized_command.includes("instagr.am")
  ) {
    add_platform("instagram");
  }
```

8. In `build_runtime_cookie_args`, after the douyin branch:

```js
  if (command_name === "xsave_instagram" && platform_key === "instagram") {
    const entry = get_platform_runtime(runtime_data, platform_key);
    const profile =
      entry && entry.chrome_profile
        ? String(entry.chrome_profile).trim()
        : "";
    if (!profile) return [];
    return ["--chrome-profile", profile];
  }
```

Do not change `build_refresh_args`.

- [ ] **Step 1: Write the failing rewrite and gather tests**

Create `test/xsave_instagram_rewrite_command.test.js`:

```js
import { describe, expect, it } from "vitest";

const {
  rewrite_xsave_instagram_command_text,
} = require("../lib/xsave_instagram/rewrite_command");

describe("xsave_instagram rewrite_command", () => {
  it("keeps already-valid source plus url", () => {
    expect(
      rewrite_xsave_instagram_command_text(
        "xsave_instagram post https://www.instagram.com/example_user/ --dry-run",
      ),
    ).toBe(
      "xsave_instagram post https://www.instagram.com/example_user/ --dry-run",
    );
  });

  it("does not rewrite instagram_likes_export", () => {
    expect(
      rewrite_xsave_instagram_command_text(
        "instagram_likes_export my_account --content-type liked",
      ),
    ).toBe("instagram_likes_export my_account --content-type liked");
  });

  it("leaves douyin commands unchanged", () => {
    expect(
      rewrite_xsave_instagram_command_text(
        "xsave_douyin post https://www.douyin.com/user/EXAMPLE_ID",
      ),
    ).toBe("xsave_douyin post https://www.douyin.com/user/EXAMPLE_ID");
  });
});
```

In `test/gather.test.js`, add next to the other config helpers:

```js
async function write_instagram_config_file(temp_root) {
  const config_path = path.join(temp_root, "gather.instagram.config.yaml");
  const config_text = [
    "source:",
    "  instagram:",
    "    - name: Example Instagram user",
    "      handle: https://www.instagram.com/example_user/",
    "",
  ].join("\n");
  await fs.writeFile(config_path, config_text, "utf8");
  return config_path;
}
```

Add these tests inside the existing gather describe that already covers douyin:

```js
  it("supports ig as an alias for instagram and builds xsave_instagram post", async () => {
    const temp_root = await create_temp_dir();
    try {
      const config_path = await write_instagram_config_file(temp_root);
      const result = await run_cli([
        "--dry-run",
        "--state-file",
        path.join(temp_root, "gather.state.json"),
        "--platform",
        "ig",
        config_path,
      ]);
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain(
        "xsave_instagram post https://www.instagram.com/example_user/",
      );
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("does not pass gather --refresh through to xsave_instagram", async () => {
    const temp_root = await create_temp_dir();
    try {
      const config_path = await write_instagram_config_file(temp_root);
      const result = await run_cli([
        "--dry-run",
        "--refresh",
        "--state-file",
        path.join(temp_root, "gather.state.json"),
        "--platform",
        "instagram",
        config_path,
      ]);
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain("xsave_instagram post ");
      expect(result.stdout).not.toMatch(/xsave_instagram[^\n]*--refresh/);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("injects runtime chrome-profile into xsave_instagram commands", async () => {
    const temp_root = await create_temp_dir();
    const runtime_path = path.join(temp_root, "gather.runtime.yaml");
    try {
      await fs.writeFile(
        runtime_path,
        [
          "version: 1",
          "platform:",
          "  instagram:",
          '    chrome_profile: "Profile 9"',
          "",
        ].join("\n"),
        "utf8",
      );
      const config_path = await write_instagram_config_file(temp_root);
      const result = await run_cli(
        [
          "--dry-run",
          "--state-file",
          path.join(temp_root, "gather.state.json"),
          "--platform",
          "instagram",
          config_path,
        ],
        { GATHER_RUNTIME_PATH: runtime_path },
      );
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain(
        "xsave_instagram post https://www.instagram.com/example_user/",
      );
      expect(result.stdout).toMatch(/--chrome-profile ["']?Profile 9["']?/);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xsave_instagram_rewrite_command.test.js test/gather.test.js --testNamePattern="keeps already-valid|does not rewrite instagram_likes|supports ig as an alias|does not pass gather --refresh through to xsave_instagram|injects runtime chrome-profile into xsave_instagram"`

Expected: FAIL (helper missing; gather has no `instagram` platform).

- [ ] **Step 3: Implement rewrite helper and gather wiring**

Create `lib/xsave_instagram/rewrite_command.js`:

```js
"use strict";

const ALLOWED_SOURCES = ["like", "post", "collection", "video"];

function tokenize_command(text) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(text || ""))))
    tokens.push(match[1] || match[2] || match[3]);
  return tokens;
}

function quote_token(token) {
  const text = String(token);
  if (/[\s"']/.test(text)) return `"${text.replace(/"/g, '\\"')}"`;
  return text;
}

function rewrite_xsave_instagram_command_text(command_text) {
  const text = String(command_text || "").trim();
  const tokens = tokenize_command(text);
  if (tokens.length === 0) return text;
  if (tokens[0] !== "xsave_instagram") return text;

  const rest = tokens.slice(1);
  let source = "";
  let url = "";
  const kept = [];
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (ALLOWED_SOURCES.includes(tok) && !source) {
      source = tok;
      continue;
    }
    if (!url && /instagram\.com|instagr\.am|https?:\/\//i.test(tok)) {
      url = tok;
      continue;
    }
    kept.push(tok);
  }

  const out = ["xsave_instagram"];
  if (source) out.push(source);
  if (url) out.push(url);
  for (const token of kept) out.push(quote_token(token));
  return out.join(" ");
}

module.exports = {
  rewrite_xsave_instagram_command_text,
  tokenize_command,
};
```

Apply the exact `bin/gather` edits listed in Interfaces.

- [ ] **Step 4: Run rewrite and gather tests**

Run: `npx vitest run test/xsave_instagram_rewrite_command.test.js test/gather.test.js test/xsave_instagram_cli.test.js`

Expected: PASS. If `gather.test.js` has a snapshot of `DEFAULT_CONFIG_LINES` / init output, update it to include the Instagram example.

- [ ] **Step 5: Commit**

```bash
git add lib/xsave_instagram/rewrite_command.js test/xsave_instagram_rewrite_command.test.js bin/gather test/gather.test.js
git commit -m "$(cat <<'EOF'
feat: emit gather Instagram commands as xsave_instagram post

Recognize ig as instagram, inject --chrome-profile, and leave
instagram_likes_export lines alone.
EOF
)"
```

---

### Task 8: gather doctor adapter

**Files:**
- Modify: `lib/gather_doctor/constants.js`
- Create: `lib/gather_doctor/adapter/instagram.js`
- Modify: `lib/gather_doctor/adapter/index.js`
- Create: `test/gather_doctor_adapter_instagram.test.js`
- Test: `test/gather_doctor_adapter_instagram.test.js`

**Interfaces:**
- Consumes: `check_repo_command`, `chrome_check_for_platform`, `runtime_browser_patch`, `cookie_export`
- Produces:
  - `PLATFORM_ALIASES.ig = "instagram"`
  - `PLATFORM_KEYS` includes `"instagram"`
  - `HOST_PATTERNS.instagram = ["instagram.com", "cdninstagram.com"]`
  - `PLATFORM_HANDLE_BASE_URLS.instagram = "https://www.instagram.com/"`
  - `PLATFORM_PROBE_URLS.instagram = "https://www.instagram.com/"`
  - adapter `{ platform_key: "instagram", check, fix }`
  - check: `xsave_instagram` on PATH, Chrome cookies, optional offline-skipped probe
  - fix: export cookies via yt-dlp for `instagram`, write `runtime_patch` with `chrome_profile` (no f2 cookie write)
  - `next_command` / hint: `gather doctor fix --platform instagram`

Exact constants.js additions:

```js
  ig: "instagram",
```

inside `PLATFORM_ALIASES`; `"instagram"` in `PLATFORM_KEYS` after `"douyin"`; hosts / handle / probe as above.

`lib/gather_doctor/adapter/index.js`:

```js
const instagram = require("./instagram");
// ...
  instagram,
```

- [ ] **Step 1: Write the failing doctor tests**

Create `test/gather_doctor_adapter_instagram.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/gather_doctor_adapter_instagram.test.js`

Expected: FAIL (`No adapter for platform: instagram` or missing key).

- [ ] **Step 3: Implement constants and adapter**

Update `lib/gather_doctor/constants.js` as listed in Interfaces.

Create `lib/gather_doctor/adapter/instagram.js`:

```js
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const {
  status_result,
  worst_status,
  check_repo_command,
  chrome_check_for_platform,
  runtime_browser_patch,
} = require("./common");
const cookie_export = require("../cookie_export");
const { PLATFORM_PROBE_URLS } = require("../constants");

async function check(context) {
  const checks = [];
  checks.push(await check_repo_command("xsave_instagram"));
  const chrome = chrome_check_for_platform("instagram", context);
  checks.push(chrome.check);
  let next_command = "";
  if (checks.some((entry) => entry.status === "fail"))
    next_command = "gather doctor fix --platform instagram";
  if (!context.offline && chrome.selected) {
    checks.push({
      name: "probe",
      status: "ok",
      message: `probe url ${
        (context.probe_urls && context.probe_urls.instagram) ||
        PLATFORM_PROBE_URLS.instagram
      }`,
    });
  }
  return status_result({
    platform_key: "instagram",
    status: worst_status(checks.map((entry) => entry.status)),
    checks,
    next_command,
    selected_profile: chrome.selected,
    profile_matches: chrome.matches,
  });
}

async function fix(context) {
  const actions = [];
  const selected =
    (context && context.selected_profile) ||
    chrome_check_for_platform("instagram", context).selected;
  if (!selected) {
    actions.push({
      type: "profile",
      ok: false,
      detail: "No Chrome profile with cookies for instagram",
    });
    return { ok: false, actions, runtime_patch: null };
  }
  const temp_cookies = path.join(
    os.tmpdir(),
    "gather_doctor_instagram_cookies.txt",
  );
  const export_result = await cookie_export.export_netscape_cookies({
    chrome_profile: selected.directory,
    output_path: temp_cookies,
    platform_key: "instagram",
    dry_run: context && context.dry_run,
  });
  actions.push({
    type: "cookie_export",
    ok: export_result.ok,
    detail: "export instagram cookies via yt-dlp",
    error: export_result.error || "",
  });
  if (!export_result.ok && !(context && context.dry_run))
    return { ok: false, actions, runtime_patch: null };
  if (!(context && context.dry_run)) {
    const header = await cookie_export.netscape_to_cookie_header(
      temp_cookies,
      "instagram",
    );
    try {
      await fs.unlink(temp_cookies);
    } catch (_error) {
      /* ignore */
    }
    if (!header) {
      actions.push({
        type: "cookie_convert",
        ok: false,
        detail: "Netscape export had no matching hosts",
      });
      return { ok: false, actions, runtime_patch: null };
    }
  }
  const runtime_patch = runtime_browser_patch(selected);
  actions.push({
    type: "runtime",
    ok: true,
    detail: `map instagram -> ${selected.directory}`,
  });
  return { ok: true, actions, runtime_patch };
}

module.exports = {
  platform_key: "instagram",
  check,
  fix,
};
```

Register it in `lib/gather_doctor/adapter/index.js`.

- [ ] **Step 4: Run doctor and related tests**

Run: `npx vitest run test/gather_doctor_adapter_instagram.test.js test/gather.test.js test/xsave_instagram_cli.test.js test/xsave_instagram_chrome_client.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/gather_doctor/constants.js lib/gather_doctor/adapter/instagram.js lib/gather_doctor/adapter/index.js test/gather_doctor_adapter_instagram.test.js
git commit -m "$(cat <<'EOF'
feat: add gather doctor support for instagram

Check xsave_instagram and Chrome cookies, then write runtime
chrome_profile without touching f2 config.
EOF
)"
```

After this commit succeeds, merge the task branch back into the original branch, remove the worktree, and delete the task branch.

---

## Spec coverage

| Spec section | Task |
|---|---|
| Invocation + infer `video` + short URL + mismatches | Task 1 |
| Options, no `--max-danmaku`, `--max-comment 0`, `--limit` | Task 1 |
| Parsed option field names | Task 1 + Task 5 |
| `post` = Posts + Reels; `collection` = all saved | Task 6 (`list_page_urls`) |
| `like` / `collection` session user match | Task 5 + Task 6 |
| Architecture modules, shortcode identity, no `xsave_douyin` import | Tasks 1–6 |
| Default `instagram/<source>`; debug layout; no danmaku | Task 5 |
| Errors (parse + runtime cookie / session / doctor hint) | Task 1 + Task 5 |
| gather emit, alias `ig`, chrome-profile, no `--refresh` passthrough | Task 7 |
| `instagram_likes_export` not rewritten | Task 7 |
| gather doctor adapter, hosts, fix hint | Task 8 |
| Help examples | Task 1 |
| Tests listed in the spec | Tasks 1–8 |