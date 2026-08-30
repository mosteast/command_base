# xsave_douyin CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the F2-shaped `xsave_douyin` CLI with positional source + URL, rename `--path` / `--check-all`, add `--limit` / `--refresh` / `--cookie-file`, and make `gather` emit and rewrite the new form.

**Architecture:** `parse_cli` reads positionals and the new flags. `run_export` uses `source` / `output` / `full_scan` / `limit` / `refresh` / `cookie_file` and maps `source === "video"` to chrome_client's existing `"one"` detail path. `plan_item` honors `refresh`. A small `rewrite_xsave_douyin_command_text` helper rewrites `f2 dy` and old `xsave_douyin -M` strings; `bin/gather` calls it and changes Douyin `build_args` to `["post", url]`.

**Tech Stack:** Node.js, yargs (already used), Vitest, existing `lib/xsave_douyin/*` and `bin/gather`.

## Global Constraints

- Invocation: `xsave_douyin <source> <url> [options]` or `xsave_douyin <video-url> [options]`.
- Allowed sources: `like`, `post`, `collection`, `video`. `one` is not a source.
- Infer `video` only when the URL path contains `/video/<id>` (`id` is one or more digits). Short host `v.douyin.com` never infers source.
- No aliases for `-M`, `--mode`, `-u`, `--url`, `-p`, `--path`, `--check-all`, or `one`.
- Parsed fields only: `source`, `url`, `output`, `full_scan`, `limit`, `refresh`, `cookie_file`, `chrome_profile`, `max_comment`, `max_danmaku`, `dry_run`, `quiet`, `debug`.
- `--max-comment 0` / `--max-danmaku 0` mean do not fetch. Do not use `Number(value) || DEFAULT`.
- `--limit` must be a positive integer. When omitted, fall back to `COMMAND_BASE_F2_LIKE_LIMIT` if that env var is a positive integer; otherwise `limit` is `0` (no limit). Do not document the env var in help.
- Default output is `…/douyin/<source>` (`video` uses `douyin/video`, not `douyin/one`).
- chrome_client may keep an internal `"one"` token. `run_export` maps `video` → `"one"` at that boundary only.
- gather `--refresh` still does not add `--refresh` to `xsave_douyin`.
- Naming: `snake_case` files/vars/functions; `function` keyword for pure helpers; named exports.
- Two or more repo-owned source files → isolated git worktree from the original branch, commit there, merge back, delete the worktree and task branch.
- Do not commit files under `tmp/`.

## File structure

| Path | Responsibility |
|------|----------------|
| `lib/xsave_douyin/parse_cli.js` | Help text, positional source/URL parse, new flags |
| `lib/xsave_douyin/run_export.js` | New option field names, `video`→`"one"` mapping, limit/refresh/cookie wiring |
| `lib/xsave_douyin/plan_item.js` | `--refresh` re-download + rewrite sidecars |
| `lib/xsave_douyin/rewrite_command.js` | Rewrite `f2 dy` / old `xsave_douyin -M` command strings |
| `bin/gather` | Douyin `build_args`; call rewrite helper |
| `lib/xsave_douyin/chrome_client.js` | Unchanged public API (`mode: "one"` stays internal) |
| `docs/superpowers/specs/2026-08-30-xsave-douyin-cli-design.md` | Approved spec (read-only) |

---

### Task 1: parse_cli grammar and help

**Files:**
- Modify: `lib/xsave_douyin/parse_cli.js`
- Modify: `test/xsave_douyin_cli.test.js` (help + parse cases only)
- Test: `test/xsave_douyin_cli.test.js`

**Interfaces:**
- Consumes: yargs, `package.json` version
- Produces:
  - `ALLOWED_SOURCES = ["like", "post", "collection", "video"]`
  - `function parse_cli(argv: string[]): { help?: true, version?: true, version_text?: string, source: string, url: string, output: string, full_scan: boolean, limit: number, refresh: boolean, cookie_file: string, chrome_profile: string, max_comment: number, max_danmaku: number, dry_run: boolean, quiet: boolean, debug: boolean }`
  - `function build_help_text(script_name?: string): string`
  - Error messages exactly as in the spec

Create the isolated worktree before editing (original branch is the workspace branch at start; expected files listed in File structure). Link `node_modules` into the worktree.

- [ ] **Step 1: Write the failing parse and help tests**

In `test/xsave_douyin_cli.test.js`, replace the help test and the parse-related tests (`requires mode and url`, `parses max-comment`, `leaves chrome-profile empty`, `parses --check-all`) with:

```js
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
    expect(result.stdout).toMatch(/# Download liked videos/);
    expect(result.stdout).toMatch(/\$0 like /);
    expect(result.stdout).toMatch(/\$0 post /);
    expect(result.stdout).toMatch(/\$0 --full-scan like /);
    expect(result.stdout).toMatch(/\$0 --dry-run collection /);
    expect(result.stdout).not.toMatch(/-M/);
    expect(result.stdout).not.toMatch(/-u,/);
    expect(result.stdout).not.toMatch(/--check-all/);
    expect(result.stdout).not.toMatch(/, one|mode: one|-M one/);
    expect(result.stdout).not.toMatch(/COMMAND_BASE_F2_LIKE_LIMIT/);
  });

  it("parses source and url positionals", () => {
    const options = parse_cli([
      "like",
      "https://v.douyin.com/example/",
      "--max-comment",
      "12",
      "--max-danmaku",
      "34",
    ]);
    expect(options.source).toBe("like");
    expect(options.url).toBe("https://v.douyin.com/example/");
    expect(options.max_comment).toBe(12);
    expect(options.max_danmaku).toBe(34);
    expect(options.output).toBe("");
    expect(options.full_scan).toBe(false);
    expect(options.limit).toBe(0);
    expect(options.refresh).toBe(false);
    expect(options.cookie_file).toBe("");
    expect(options.chrome_profile).toBe("");
  });

  it("infers video from a /video/<id> url", () => {
    const options = parse_cli(["https://www.douyin.com/video/123"]);
    expect(options.source).toBe("video");
    expect(options.url).toBe("https://www.douyin.com/video/123");
  });

  it("accepts explicit video with a short url", () => {
    const options = parse_cli(["video", "https://v.douyin.com/AbCdEf/"]);
    expect(options.source).toBe("video");
    expect(options.url).toBe("https://v.douyin.com/AbCdEf/");
  });

  it("requires source for short and user urls", () => {
    expect(() => parse_cli(["https://v.douyin.com/kIg44MNOKz8/"])).toThrow(
      /Missing source/,
    );
    expect(() =>
      parse_cli(["https://www.douyin.com/user/MS4wLjABAAAA"]),
    ).toThrow(/Missing source/);
  });

  it("rejects unknown source, extra args, and mismatches", () => {
    expect(() =>
      parse_cli(["one", "https://www.douyin.com/video/123"]),
    ).toThrow(/Invalid source one/);
    expect(() =>
      parse_cli(["like", "https://v.douyin.com/a/", "extra"]),
    ).toThrow(/Unexpected argument extra/);
    expect(() =>
      parse_cli(["video", "https://www.douyin.com/user/MS4wLjABAAAA"]),
    ).toThrow(/source video does not match user URL/);
    expect(() =>
      parse_cli(["like", "https://www.douyin.com/video/123"]),
    ).toThrow(/source like does not match video URL/);
  });

  it("rejects removed F2 flags", () => {
    expect(() =>
      parse_cli(["-M", "like", "-u", "https://v.douyin.com/example/"]),
    ).toThrow(/Unknown option/);
    expect(() =>
      parse_cli(["like", "https://v.douyin.com/example/", "--check-all"]),
    ).toThrow(/Unknown option/);
    expect(() =>
      parse_cli(["like", "https://v.douyin.com/example/", "--path", "/tmp"]),
    ).toThrow(/Unknown option/);
  });

  it("parses output full-scan limit refresh and cookie-file", () => {
    const options = parse_cli([
      "--full-scan",
      "--refresh",
      "--limit",
      "3",
      "--output",
      "/tmp/dy-out",
      "--cookie-file",
      "/tmp/cookies.txt",
      "post",
      "https://www.douyin.com/user/MS4wLjABAAAA",
    ]);
    expect(options.source).toBe("post");
    expect(options.output).toBe("/tmp/dy-out");
    expect(options.full_scan).toBe(true);
    expect(options.limit).toBe(3);
    expect(options.refresh).toBe(true);
    expect(options.cookie_file).toBe("/tmp/cookies.txt");
  });

  it("keeps --max-comment 0 and --max-danmaku 0", () => {
    const options = parse_cli([
      "like",
      "https://v.douyin.com/example/",
      "--max-comment",
      "0",
      "--max-danmaku",
      "0",
    ]);
    expect(options.max_comment).toBe(0);
    expect(options.max_danmaku).toBe(0);
  });

  it("rejects invalid --limit", () => {
    expect(() =>
      parse_cli(["like", "https://v.douyin.com/example/", "--limit", "0"]),
    ).toThrow(/Invalid --limit/);
  });

  it("requires source and url", async () => {
    const result = await run_cli(["--dry-run"]);
    expect(result.exit_code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Missing URL/);
  });
```

Leave the existing `prints only the version number`, `rejects unknown options`, and `run_export` integration tests in this file for now.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xsave_douyin_cli.test.js --testNamePattern="prints help|parses source|infers video|accepts explicit video|requires source for short|rejects unknown source|rejects removed F2|parses output full-scan|keeps --max-comment|rejects invalid --limit|requires source and url"`

Expected: FAIL (old help still has `-M`, `parse_cli` still requires `--mode` / `--url`).

- [ ] **Step 3: Replace `lib/xsave_douyin/parse_cli.js`**

```js
"use strict";

const package_json = require("../../package.json");

const ALLOWED_SOURCES = ["like", "post", "collection", "video"];
const LIST_SOURCES = ["like", "post", "collection"];
const DEFAULT_CHROME_PROFILE = "";
const DEFAULT_MAX_COMMENT = 500;
const DEFAULT_MAX_DANMAKU = 500;

function build_help_text(script_name) {
  const name = script_name || "xsave_douyin";
  return [
    "Usage",
    `  ${name} <source> <url> [options]`,
    `  ${name} <video-url> [options]`,
    "",
    "Description",
    "  Export Douyin likes, posts, collections, or a single video through Chrome.",
    "  Existing media is not re-downloaded unless --refresh is set. Missing sidecars are filled.",
    "  Invisible items are skipped even when a local file exists.",
    "  After the list page loads, compare recent items with local files",
    "  and resume from the last already downloaded position.",
    "  After each run, print counts for collected, download, fill, skip, and sidecars.",
    "",
    "Options",
    "      <source>                 List source: like, post, collection, video",
    "      <url>                    Douyin user, short URL, or video URL",
    "  -o, --output <dir>           Output root (default: douyin/<source> library)",
    "      --chrome-profile <name>  Chrome profile name or directory (default: gather runtime Douyin profile)",
    "      --max-comment <n>        Max comments per item (default: 500; 0 skips comments)",
    "      --max-danmaku <n>        Max flying danmaku per item (default: 500; 0 skips danmaku)",
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
    "  # Download liked videos",
    "  $0 like https://v.douyin.com/kIg44MNOKz8/",
    "",
    "  # Download a user's public posts",
    "  $0 post https://www.douyin.com/user/MS4wLjABAAAA",
    "",
    "  # Download a single video",
    "  $0 https://www.douyin.com/video/123",
    "",
    "  # Scan the entire list instead of resuming at already downloaded items",
    "  $0 --full-scan like https://v.douyin.com/kIg44MNOKz8/",
    "",
    "  # Preview collection export without writing files",
    "  $0 --dry-run collection https://www.douyin.com/user/MS4wLjABAAAA",
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
  return /:\/\//.test(text) || /douyin\.com/i.test(text);
}

function url_pathname(url) {
  try {
    return new URL(url).pathname;
  } catch (_error) {
    return String(url || "");
  }
}

function is_video_url(url) {
  return /\/video\/\d+/.test(url_pathname(url));
}

function is_user_url(url) {
  return /\/user\/[^/]+/.test(url_pathname(url));
}

function is_short_url(url) {
  try {
    return new URL(url).hostname.toLowerCase() === "v.douyin.com";
  } catch (_error) {
    return /v\.douyin\.com/i.test(String(url || ""));
  }
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
  if (is_video_url(first) && !is_short_url(first))
    return { source: "video", url: first };
  throw new Error(
    "Missing source. Use like, post, collection, or a /video/ URL",
  );
}

function assert_source_url_match(source, url) {
  if (source === "video" && is_user_url(url))
    throw new Error("source video does not match user URL");
  if (LIST_SOURCES.includes(source) && is_video_url(url))
    throw new Error(`source ${source} does not match video URL`);
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
    .option("max-danmaku", {
      type: "number",
      default: DEFAULT_MAX_DANMAKU,
      describe: "Max danmaku per item",
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
    max_danmaku: parse_non_negative_int(
      parsed["max-danmaku"],
      "--max-danmaku",
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
  DEFAULT_MAX_DANMAKU,
  build_help_text,
  parse_cli,
};
```

- [ ] **Step 4: Run the parse and help tests**

Run: `npx vitest run test/xsave_douyin_cli.test.js --testNamePattern="prints help|parses source|infers video|accepts explicit video|requires source for short|rejects unknown source|rejects removed F2|parses output full-scan|keeps --max-comment|rejects invalid --limit|requires source and url|prints only the version|rejects unknown options"`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/xsave_douyin/parse_cli.js test/xsave_douyin_cli.test.js
git commit -m "$(cat <<'EOF'
feat: parse xsave_douyin as source plus URL

Drop F2 -M/-u flags. Infer video from /video/<id> URLs and expose
--output, --full-scan, --limit, --refresh, and --cookie-file.
EOF
)"
```

---

### Task 2: run_export option fields and video mapping

**Files:**
- Modify: `lib/xsave_douyin/run_export.js`
- Modify: `test/xsave_douyin_cli.test.js` (every `run_export({ mode, path, … })` fixture)
- Modify: `test/xsave_douyin_export_layout.test.js`
- Modify: `test/xsave_douyin_export_resume.test.js`
- Modify: `test/xsave_douyin_export_stats.test.js`
- Test: those same files

**Interfaces:**
- Consumes: `parse_cli` fields from Task 1; chrome_client still takes `mode`
- Produces:
  - `function chrome_mode(source: string): string` — `"video"` → `"one"`, else `source`
  - `function default_output_dir(source: string, f2_root?: string): string` — `…/douyin/<source>`
  - `function resolve_output_dir(options, deps)` reads `options.output`, not `options.path`
  - `function describe_export_layout({ source, full_scan, item_limit, … })` prints `source:` and `full_scan:`
  - `run_export` reads `options.source`, `options.output`, `options.full_scan`, `options.limit`, `options.refresh`, `options.cookie_file`
  - `collect_list` / `attach_list_intercept` / `prepare_list_page` receive `mode: chrome_mode(source)`

- [ ] **Step 1: Write the failing layout and mapping tests**

In `test/xsave_douyin_export_layout.test.js`, change fixtures and assertions:

```js
    const lines = describe_export_layout({
      source: "like",
      url: "https://v.douyin.com/example/",
      output_dir: "/tmp/dy-out",
      chrome_profile: "Profile 9",
      runtime_path: "/tmp/gather.runtime.yaml",
      max_comment: 500,
      max_danmaku: 200,
      dry_run: false,
      item_limit: 0,
    });
    const text = lines.join("\n");
    expect(text).toMatch(/source: like/);
    expect(text).not.toMatch(/mode: like/);
    expect(text).toMatch(/full_scan: false/);
```

```js
      {
        source: "like",
        url: "https://v.douyin.com/example/",
        output: "/tmp/dy-out",
        debug: true,
        dry_run: true,
        chrome_profile: "Profile 9",
        runtime_path: "/tmp/gather.runtime.yaml",
        max_comment: 12,
        max_danmaku: 34,
      },
```

```js
    expect(default_output_dir("video", "/tmp/f2")).toBe(
      path.join("/tmp/f2", "douyin", "video"),
    );
    expect(resolve_output_dir({ output: "/tmp/dy-out", source: "like" })).toBe(
      path.resolve("/tmp/dy-out"),
    );
    expect(
      resolve_output_dir({ source: "like", output: "" }, { f2_output_dir: "/tmp/f2" }),
    ).toBe(path.join("/tmp/f2", "douyin", "like"));
```

In `test/xsave_douyin_export_resume.test.js`, add:

```js
  it("maps source video to chrome_client mode one", async () => {
    const seen = [];
    await run_export(
      {
        source: "video",
        url: "https://www.douyin.com/video/123",
        output: "/tmp",
        dry_run: true,
        chrome_profile: "nori",
      },
      {
        resolve_cookie: async () => "dummy",
        collect_list: async (opts) => {
          seen.push(opts.mode);
          return [];
        },
        log: () => {},
      },
    );
    expect(seen).toEqual(["one"]);
  });
```

In every remaining `run_export({…})` fixture in `test/xsave_douyin_cli.test.js`, `test/xsave_douyin_export_resume.test.js`, and `test/xsave_douyin_export_stats.test.js`, replace:

- `mode:` → `source:` (`"one"` becomes `"video"`)
- `path:` → `output:`
- `check_all:` → `full_scan:`

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xsave_douyin_export_layout.test.js test/xsave_douyin_export_resume.test.js --testNamePattern="lists output|defaults like|uses an explicit|maps source video"`

Expected: FAIL (`describe_export_layout` still prints `mode:`, `resolve_output_dir` still reads `path`, `collect_list` still gets `mode: "video"`).

- [ ] **Step 3: Update `run_export.js`**

Add next to the other helpers:

```js
function chrome_mode(source) {
  return source === "video" ? "one" : String(source || "");
}

function resolve_item_limit(options) {
  const explicit = Number(options && options.limit);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const env = Number(process.env.COMMAND_BASE_F2_LIKE_LIMIT);
  if (Number.isInteger(env) && env > 0) return env;
  return 0;
}
```

Replace `default_output_dir` / `resolve_output_dir` / layout / collect wiring:

```js
function default_output_dir(source, f2_root) {
  return path.join(
    f2_root || DEFAULT_F2_OUTPUT_DIR,
    "douyin",
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
```

In `describe_export_layout`, rename the `mode` argument to `source` and `check_all` to `full_scan`. Print:

```js
    `  source: ${source || ""}`,
    `  full_scan: ${Boolean(full_scan)}`,
```

In `run_export`:

```js
  const source = options && options.source;
  const list_mode = chrome_mode(source);
  const item_limit = resolve_item_limit(options);
```

Use `list_mode` everywhere chrome_client currently gets `options.mode` (`!== "one"`, `attach_list_intercept`, `prepare_list_page`, `collect_list`, resume skip when `list_mode === "one"`).

Log: `Collected ${items.length} item(s) for source ${source}`.

Layout call uses `source` and `full_scan: options && options.full_scan`.

Resume stop: `options.full_scan || list_mode === "one"`.

Pass `refresh: Boolean(options && options.refresh)` into `plan_item` (Task 3 will honor it; passing it now is required so Task 3 does not revisit this call).

Honor zero caps when fetching sidecars:

```js
        if (planned.write_comments && Number(options.max_comment) > 0) {
```

```js
        if (planned.write_danmaku && Number(options.max_danmaku) > 0) {
```

Export `chrome_mode` from `module.exports`.

- [ ] **Step 4: Run export tests**

Run: `npx vitest run test/xsave_douyin_cli.test.js test/xsave_douyin_export_layout.test.js test/xsave_douyin_export_resume.test.js test/xsave_douyin_export_stats.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/xsave_douyin/run_export.js test/xsave_douyin_cli.test.js test/xsave_douyin_export_layout.test.js test/xsave_douyin_export_resume.test.js test/xsave_douyin_export_stats.test.js
git commit -m "$(cat <<'EOF'
feat: drive xsave_douyin export from source and output

Map source video to the existing chrome detail path and stop reading
mode, path, and check_all.
EOF
)"
```

---

### Task 3: `--refresh` in plan_item

**Files:**
- Modify: `lib/xsave_douyin/plan_item.js`
- Modify: `test/xsave_douyin_plan_item.test.js`
- Modify: `test/xsave_douyin_cli.test.js` (one `run_export` refresh case)
- Test: `test/xsave_douyin_plan_item.test.js`, `test/xsave_douyin_cli.test.js`

**Interfaces:**
- Consumes: `plan_item({ item, media, sidecar_exists, refresh })` call from Task 2
- Produces: when `refresh` is true and the item is visible, `action` is `"download"`, `download` is true, and all sidecar writes are true, even if media already exists. Invisible items still skip.

- [ ] **Step 1: Write the failing tests**

Append to `test/xsave_douyin_plan_item.test.js`:

```js
  it("re-downloads existing media when refresh is set", () => {
    const planned = plan_item({
      item: visible_item,
      media: { media_path: "/tmp/a.mp4", stem_path: "/tmp/a" },
      sidecar_exists: { comments: true, danmaku: true },
      refresh: true,
    });
    expect(planned).toEqual({
      action: "download",
      reason: "refresh",
      download: true,
      write_meta: true,
      write_comments: true,
      write_danmaku: true,
    });
  });

  it("still skips invisible items when refresh is set", () => {
    const planned = plan_item({
      item: { aweme_id: "1", is_prohibited: true },
      media: { media_path: "/tmp/a.mp4", stem_path: "/tmp/a" },
      refresh: true,
    });
    expect(planned.action).toBe("skip");
    expect(planned.download).toBe(false);
  });
```

Append to `test/xsave_douyin_cli.test.js`:

```js
  it("refresh re-downloads existing library media", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-refresh-"));
    const media_name = `"uid","1","name","2026-01-01","desc"_video.mp4`;
    await fs.writeFile(path.join(temp_root, media_name), "video");
    const download_media = vi.fn(async ({ target_path }) => {
      await fs.writeFile(target_path, "new");
      return { ok: true };
    });
    try {
      const result = await run_export(
        {
          source: "like",
          url: "https://v.douyin.com/example/",
          output: temp_root,
          refresh: true,
          max_comment: 0,
          max_danmaku: 0,
          chrome_profile: "nori",
        },
        {
          resolve_cookie: async () => "dummy",
          collect_list: async () => [
            {
              aweme_list: [
                {
                  aweme_id: "1",
                  video: {
                    play_addr: { url_list: ["https://example.com/a.mp4"] },
                  },
                },
              ],
            },
          ],
          download_media,
          fetch_comments: async () => {
            throw new Error("should not fetch comments when max_comment is 0");
          },
          fetch_danmaku: async () => {
            throw new Error("should not fetch danmaku when max_danmaku is 0");
          },
          open_session: async () => ({ page: {}, close: async () => {} }),
          attach_list_intercept: () => [],
          prepare_list_page: async () => {},
          log: () => {},
        },
      );
      expect(result.exit_code).toBe(0);
      expect(download_media).toHaveBeenCalled();
      expect(result.stats.download).toBe(1);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xsave_douyin_plan_item.test.js test/xsave_douyin_cli.test.js --testNamePattern="re-downloads existing media when refresh|still skips invisible|refresh re-downloads"`

Expected: FAIL (`plan_item` still returns `fill` when media exists).

- [ ] **Step 3: Honor refresh in `plan_item`**

Replace `lib/xsave_douyin/plan_item.js` with:

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
      write_danmaku: false,
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
      write_danmaku: !exists.danmaku,
    };
  }
  return {
    action: "download",
    reason: refresh && media && media.media_path ? "refresh" : "",
    download: true,
    write_meta: true,
    write_comments: true,
    write_danmaku: true,
  };
}

module.exports = { plan_item };
```

Confirm `run_export` already calls `plan_item({ item, media, sidecar_exists, refresh: Boolean(options && options.refresh) })` from Task 2. If that argument is missing, add it.

- [ ] **Step 4: Run plan and refresh tests**

Run: `npx vitest run test/xsave_douyin_plan_item.test.js test/xsave_douyin_cli.test.js test/xsave_douyin_export_stats.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/xsave_douyin/plan_item.js test/xsave_douyin_plan_item.test.js test/xsave_douyin_cli.test.js
git commit -m "$(cat <<'EOF'
feat: refresh xsave_douyin media and sidecars

--refresh re-downloads existing visible items. max_comment 0 and
max_danmaku 0 skip sidecar fetches.
EOF
)"
```

---

### Task 4: gather emit and rewrite

**Files:**
- Create: `lib/xsave_douyin/rewrite_command.js`
- Create: `test/xsave_douyin_rewrite_command.test.js`
- Modify: `bin/gather` (`PLATFORM_COMMANDS.douyin.build_args`, `rewrite_f2_command_text`)
- Modify: `test/gather.test.js` (every expected `xsave_douyin -M … -u …` string)
- Test: `test/xsave_douyin_rewrite_command.test.js`, `test/gather.test.js`

**Interfaces:**
- Consumes: command text strings from gather config / `f2 dy` lines
- Produces:
  - `function rewrite_xsave_douyin_command_text(command_text: string): string`
  - `PLATFORM_COMMANDS.douyin.build_args = (url) => ["post", url]`
  - `rewrite_f2_command_text` returns `rewrite_xsave_douyin_command_text(command_text)`
  - `--chrome-profile` injection unchanged
  - gather `--refresh` still does not add `--refresh` to `xsave_douyin`

- [ ] **Step 1: Write the failing rewrite tests**

Create `test/xsave_douyin_rewrite_command.test.js`:

```js
import { describe, expect, it } from "vitest";

const {
  rewrite_xsave_douyin_command_text,
} = require("../lib/xsave_douyin/rewrite_command");

describe("xsave_douyin rewrite_command", () => {
  it("rewrites f2 dy F2 flags to positional source and url", () => {
    expect(
      rewrite_xsave_douyin_command_text(
        "f2 dy -M like -u https://v.douyin.com/kIg44MNOKz8/",
      ),
    ).toBe("xsave_douyin like https://v.douyin.com/kIg44MNOKz8/");
    expect(
      rewrite_xsave_douyin_command_text(
        "f2_compat dy -M post -u https://www.douyin.com/user/MS4wLjABAAAA",
      ),
    ).toBe("xsave_douyin post https://www.douyin.com/user/MS4wLjABAAAA");
    expect(
      rewrite_xsave_douyin_command_text(
        "f2 dy -M collection -u https://www.douyin.com/user/MS4wLjABAAAA --dry-run",
      ),
    ).toBe(
      "xsave_douyin collection https://www.douyin.com/user/MS4wLjABAAAA --dry-run",
    );
    expect(
      rewrite_xsave_douyin_command_text(
        "f2 dy -M one -u https://v.douyin.com/AbCdEf/",
      ),
    ).toBe("xsave_douyin video https://v.douyin.com/AbCdEf/");
  });

  it("rewrites already-prefixed xsave_douyin F2 flags", () => {
    expect(
      rewrite_xsave_douyin_command_text(
        "xsave_douyin -M post -u https://www.douyin.com/user/EXAMPLE_ID",
      ),
    ).toBe("xsave_douyin post https://www.douyin.com/user/EXAMPLE_ID");
    expect(
      rewrite_xsave_douyin_command_text(
        "xsave_douyin --check-all -M like -u https://v.douyin.com/a/ --path /tmp/out",
      ),
    ).toBe(
      "xsave_douyin like https://v.douyin.com/a/ --full-scan --output /tmp/out",
    );
  });

  it("leaves non-douyin f2 commands on f2_compat", () => {
    expect(rewrite_xsave_douyin_command_text("f2 x -M like -u https://x.com/a")).toBe(
      "f2_compat x -M like -u https://x.com/a",
    );
  });
});
```

In `test/gather.test.js`, change every expected command string:

- `"xsave_douyin -M post -u https://www.douyin.com/user/EXAMPLE_ID"` → `"xsave_douyin post https://www.douyin.com/user/EXAMPLE_ID"`
- `"xsave_douyin -M like -u https://v.douyin.com/EXAMPLE/"` → `"xsave_douyin like https://v.douyin.com/EXAMPLE/"`
- `"xsave_douyin -M like -u https://v.douyin.com/kIg44MNOKz8/"` → `"xsave_douyin like https://v.douyin.com/kIg44MNOKz8/"`

Keep the `--chrome-profile` assertion. Keep `not.toContain("f2_compat dy")`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xsave_douyin_rewrite_command.test.js test/gather.test.js --testNamePattern="rewrites f2 dy|rewrites already-prefixed|supports douyin_f2|rewrites bare f2 Douyin|injects runtime chrome-profile"`

Expected: FAIL (helper missing; gather still emits `-M post -u`).

- [ ] **Step 3: Implement rewrite helper and gather wiring**

Create `lib/xsave_douyin/rewrite_command.js`:

```js
"use strict";

const F2_MODE_TO_SOURCE = {
  like: "like",
  post: "post",
  collection: "collection",
  one: "video",
};
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

function rewrite_xsave_douyin_command_text(command_text) {
  const text = String(command_text || "").trim();
  const tokens = tokenize_command(text);
  if (tokens.length === 0) return text;

  let start = 0;
  if (tokens[0] === "f2" || tokens[0] === "f2_compat") {
    if (tokens[1] === "dy") start = 2;
    else if (tokens[0] === "f2") return `f2_compat${text.slice(2)}`;
    else return text;
  } else if (tokens[0] === "xsave_douyin") {
    start = 1;
  } else {
    return text;
  }

  const rest = tokens.slice(start);
  let source = "";
  let url = "";
  const kept = [];
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (tok === "-M" || tok === "--mode") {
      const raw = rest[i + 1] || "";
      source = F2_MODE_TO_SOURCE[raw] || raw;
      i += 1;
      continue;
    }
    if (tok.startsWith("--mode=")) {
      const raw = tok.slice("--mode=".length);
      source = F2_MODE_TO_SOURCE[raw] || raw;
      continue;
    }
    if (tok === "-u" || tok === "--url") {
      url = rest[i + 1] || "";
      i += 1;
      continue;
    }
    if (tok.startsWith("--url=")) {
      url = tok.slice("--url=".length);
      continue;
    }
    if (tok === "-p" || tok === "--path") {
      kept.push("--output", rest[i + 1] || "");
      i += 1;
      continue;
    }
    if (tok.startsWith("--path=")) {
      kept.push(`--output=${tok.slice("--path=".length)}`);
      continue;
    }
    if (tok === "--check-all") {
      kept.push("--full-scan");
      continue;
    }
    kept.push(tok);
  }

  if (!source && ALLOWED_SOURCES.includes(kept[0])) source = kept.shift();
  if (!url) {
    const index = kept.findIndex((token) =>
      /douyin\.com|https?:\/\//i.test(token),
    );
    if (index >= 0) url = kept.splice(index, 1)[0];
  }

  const out = ["xsave_douyin"];
  if (source) out.push(source);
  if (url) out.push(url);
  for (const token of kept) out.push(quote_token(token));
  return out.join(" ");
}

module.exports = {
  rewrite_xsave_douyin_command_text,
  tokenize_command,
};
```

In `bin/gather`:

```js
  douyin: {
    command: "xsave_douyin",
    build_args: (url) => ["post", url],
    label: "douyin",
  },
```

Replace `rewrite_f2_command_text` with:

```js
function rewrite_f2_command_text(command_text) {
  const {
    rewrite_xsave_douyin_command_text,
  } = require("../lib/xsave_douyin/rewrite_command");
  return rewrite_xsave_douyin_command_text(command_text);
}
```

Do not change `build_refresh_args`. Do not add `--refresh` for douyin.

- [ ] **Step 4: Run rewrite and gather tests**

Run: `npx vitest run test/xsave_douyin_rewrite_command.test.js test/gather.test.js test/xsave_douyin_cli.test.js test/xsave_douyin_export_layout.test.js test/xsave_douyin_export_resume.test.js test/xsave_douyin_export_stats.test.js test/xsave_douyin_plan_item.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/xsave_douyin/rewrite_command.js test/xsave_douyin_rewrite_command.test.js bin/gather test/gather.test.js
git commit -m "$(cat <<'EOF'
feat: emit and rewrite gather Douyin commands in the new form

Default works export is xsave_douyin post <url>. f2 dy and old
-M/-u lines become positional source plus URL.
EOF
)"
```

After this commit succeeds, merge the task branch back into the original branch, remove the worktree, and delete the task branch.

---

## Spec coverage

| Spec section | Task |
|---|---|
| Invocation + infer `video` + mismatches + no F2 aliases | Task 1 |
| Options keep/rename/add, `--max-comment 0`, `--limit` | Task 1 |
| Parsed option field names | Task 1 + Task 2 |
| `video` → chrome `"one"`; default `douyin/video` | Task 2 |
| Errors | Task 1 |
| `--refresh` + sidecar rewrite; zero caps skip fetch | Task 3 |
| gather `["post", url]`, rewrite `f2 dy` and old `-M` lines | Task 4 |
| Help examples | Task 1 |
| gather `--refresh` not passed through | Task 4 (no `build_refresh_args` change) |
