# xsave_instagram CLI Design

## Summary

Add `xsave_instagram` as a Chrome/Playwright media-library exporter parallel to `xsave_douyin`. Public invocation is positional `source` + URL. Shared flags use the same names. There is no `--max-danmaku`. `gather` gains an `instagram` platform that emits `xsave_instagram post <url>`. `instagram_likes_export` is unchanged.

## Goals

- Everyday use is `xsave_instagram like <url>` or `xsave_instagram <item-url>`.
- Source names match `xsave_douyin`: `like`, `post`, `collection`, `video`.
- Shared option names match sibling `xsave_*` commands where they overlap.
- `post` exports a profile's published Posts and Reels.
- `like` and `collection` require a profile URL that is the logged-in session user.
- `gather` emits and recognizes the new command. `gather doctor` can check and fix Instagram Chrome/cookie state.

## Non-goals

- Multiple URLs in one invocation.
- `--source` as a flag alias of the positional source.
- Instagram-only sources: `reel`, `story`, `highlight`, `tagged`.
- `--max-danmaku` (unknown option; fail).
- Passing gather's own `--refresh` through to `xsave_instagram`.
- Rewriting `instagram_likes_export` into `xsave_instagram`.
- Extracting a shared `lib/xsave_core/`.
- Changing `lib/xsave_douyin/*`.
- Live Instagram login/GraphQL tests in the unit suite.

## Recommended approach

**Independent `lib/xsave_instagram/` package that copies the `xsave_douyin` module split, not its internals.**

Why:

- Instagram GraphQL, shortcode IDs, Posts+Reels merge, and session-user checks do not fit Douyin `aweme_id` / danmaku paths.
- A parallel package keeps Douyin regression surface at zero.
- Callers get the same invocation shape without sharing implementation types.

## Alternatives considered

### 1. CLI wrapper around instaloader / `instagram_likes_export`

Pros: faster first command.  
Cons: different session model and export behavior; a second rewrite would be needed to match `xsave_douyin`.

### 2. Shared `lib/xsave_core/` used by both platforms

Pros: less duplicated CLI/export skeleton later.  
Cons: first version would refactor a working Douyin exporter.

### 3. Thin Instagram adapter that calls `xsave_douyin` internals

Pros: looks small.  
Cons: leaks `aweme_id`, danmaku, and `/video/<id>` into Instagram.

## Invocation

```
xsave_instagram <source> <url> [options]
xsave_instagram <item-url> [options]
```

Allowed `source` values: `like`, `post`, `collection`, `video`.

| source | Meaning |
|---|---|
| `like` | Liked items of the logged-in account. URL must be that account's profile |
| `post` | Published Posts grid plus Reels for the profile URL |
| `collection` | All saved items of the logged-in account (every collection). URL must be that account's profile. There is no per-collection picker |
| `video` | One item: `/p/<code>` or `/reel/<code>` |

Parse rules:

1. Options may appear before or after source and URL. They are not positionals.
2. Collect remaining non-option tokens as positionals.
3. If the first positional is an allowed source, that is `source`. The next token is `url`. Any further positional is an error (`Unexpected argument`).
4. If the first positional is not an allowed source, treat it as `url` and infer `source` as `video` only when the URL is an item URL. Otherwise fail with `Missing source`.
5. A short URL never infers `source`. It requires an explicit source, including `video` for a single-item short link.
6. After source and URL are known, reject mismatches:
   - `video` + profile URL → `source video does not match profile URL`
   - `like|post|collection` + item URL → `source <source> does not match item URL`
   - Short URLs are not mismatches; they are allowed with any explicit source.

URL classification (parse time), in this order:

1. **Short URL:** hostname is `instagr.am` or `l.instagram.com` (exact host, case-insensitive). Classify as short even if the path looks like `/p/<code>`. Never infer `source`.
2. **Item URL:** host is `instagram.com` or ends with `.instagram.com`, and the path contains `/p/<code>` or `/reel/<code>`. `<code>` is one or more of `[A-Za-z0-9_-]`.
3. **Profile URL:** host is `instagram.com` or ends with `.instagram.com`, the first path segment is a username, and the path is not an item URL. Reserved first segments are not usernames: `p`, `reel`, `reels`, `stories`, `explore`, `accounts`, `direct`, `tv`.
4. Anything else is neither item nor profile. It never infers `source`. An explicit source is allowed (same as a short URL).

Examples:

```
# Likes / works / collections
$0 like https://www.instagram.com/example_user/
$0 post https://www.instagram.com/example_user/
$0 collection https://www.instagram.com/example_user/

# Single item; `video` is optional when the path is /p/<code> or /reel/<code>
$0 https://www.instagram.com/p/AbCdEfGhIjK/
$0 https://www.instagram.com/reel/AbCdEfGhIjK/
$0 video https://instagr.am/p/AbCdEfGhIjK/

# Invalid
$0 https://www.instagram.com/example_user/
$0 like https://www.instagram.com/p/AbCdEfGhIjK/
```

## Options

| Option | Behavior |
|---|---|
| `-o, --output <dir>` | Output root. Default is the existing f2 library: `…/instagram/<source>` (`video` uses `instagram/video`). Empty means that default |
| `--chrome-profile <name>` | Chrome profile name or directory. Omit to use gather runtime `instagram` |
| `--max-comment <n>` | Per-item comment cap. Default `500`. `0` means do not fetch comments. Must be an integer `>= 0`. Do not treat `0` as missing |
| `--limit <n>` | Process at most `n` items. `n` must be a positive integer. When omitted, fall back to `COMMAND_BASE_F2_LIKE_LIMIT` if that env var is a positive integer; otherwise no limit. Do not document the env var in help |
| `--full-scan` | Scan the whole list; default stops at the first already-downloaded item |
| `--refresh` | Re-download existing media and rewrite that item's sidecars. Default still skips existing media and only fills missing sidecars |
| `--cookie-file <path>` | Use this cookie file. Chrome may still open; do not export a cookie from the profile when this flag is set. A missing file fails at run time with the missing-cookie error path |
| `-d, --dry-run` | Plan only |
| `--quiet` / `--debug` | Repo standard |
| `-h` / `-v` | Repo standard |

No `--max-danmaku`. Unknown options fail. No aliases for removed or Douyin-only flags.

Default output is under the same f2 root as `xsave_douyin` (`DEFAULT_F2_OUTPUT_DIR`), not `instagram_likes_export`'s `saved/video/instagram` tree.

## Parsed options

`parse_cli` returns only:

| Field | Type | Source |
|---|---|---|
| `source` | string | `like` / `post` / `collection` / `video` |
| `url` | string | positional |
| `output` | string | `--output`; empty means default library |
| `full_scan` | boolean | `--full-scan` |
| `limit` | number | `--limit` or env fallback; `0` means no limit |
| `refresh` | boolean | `--refresh` |
| `cookie_file` | string | `--cookie-file`; empty when omitted |
| `chrome_profile` | string | `--chrome-profile`; empty means gather runtime |
| `max_comment` | number | `--max-comment` |
| `dry_run` | boolean | `--dry-run` |
| `quiet` | boolean | `--quiet` |
| `debug` | boolean | `--debug` |

Help/version short-circuit as `{ help: true }` and `{ version: true, version_text }`.

There is no `max_danmaku`, `mode`, `path`, or `check_all` field.

`run_export` and debug layout lines use these names. `chrome_client` uses the same public source tokens (`like` / `post` / `collection` / `video`). It does not map `video` to an internal `"one"`.

## Architecture

`bin/xsave_instagram` only parses, prints help/version, and calls `run_export`. Implementation lives in `lib/xsave_instagram/`. It must not require `lib/xsave_douyin/*`.

| Module | Responsibility |
|---|---|
| `parse_cli` | Help text, positional source/URL parse, shared flags |
| `chrome_client` | Persistent Chrome session; intercept Instagram GraphQL/list responses; fetch comments; assert session user for `like` / `collection` |
| `run_export` | Cookie, collect, plan, download, sidecars, stats |
| `plan_item` | `skip` / `fill` / `download`; `--refresh` re-downloads and rewrites sidecars |
| `media_path` | Find existing media by shortcode |
| `sidecar` | `{stem}_meta.json` and `{stem}_comments.json` |
| `download_media` | Image / video / carousel per item |
| `rewrite_command` | Normalize `xsave_instagram` command strings for gather |

Item identity is Instagram `shortcode`, with `pk` as a secondary key. Filenames include the shortcode. Resume matches files by shortcode in the name. Do not use `aweme_id`.

Persistent Chrome user-data default: `~/Library/Application Support/command_base/xsave_instagram/chrome`. First use seeds `Default/` from the chosen Chrome profile. Later runs reuse the dir. Do not delete it.

`instagram_likes_export` is out of scope.

## Data flow

1. Parse CLI to `source` / `url` / flags.
2. Resolve cookie: `--cookie-file` if set; otherwise export from the Chrome profile. An empty `--chrome-profile` reads gather runtime `instagram`.
3. Open the persistent Chrome session when the run is not a fully injected dry-run.
4. For `like` and `collection`, read the session user and compare it to the profile username in the URL. Compare case-insensitively; ignore a leading `@` and a trailing slash. Mismatch fails the run.
5. Collect items. `post` merges Posts and Reels. `video` loads one item. Default list collect stops at the first already-downloaded item. `--full-scan` scans the whole list. `--limit` caps processed items.
6. For each item, `plan_item` then download and/or fill sidecars. Invisible items skip. `max_comment === 0` does not fetch comments.
7. Print counts: `collected`, `download`, `fill`, `skip`, `download_failed`, `comments`. No `danmaku` count. `--dry-run` plans without writing and exits `0`.

Debug layout prints `source:` and `full_scan:`. It must not print a danmaku sidecar line.

## Errors

On parse failure: one reason line on stderr, then help, exit `1`.

| Condition | Message |
|---|---|
| No URL | `Missing URL` |
| Profile or short URL without source | `Missing source. Use like, post, collection, or a /p/ or /reel/ URL` |
| Unknown source token | `Invalid source <x>. Allowed: like, post, collection, video` |
| Extra positional | `Unexpected argument <token>` |
| `video` + profile URL | `source video does not match profile URL` |
| `like\|post\|collection` + item URL | `source <source> does not match item URL` |
| `--limit` not a positive integer | `Invalid --limit <x>. Use a positive integer` |
| `--max-comment` not an integer `>= 0` | `Invalid --max-comment <x>` |
| Unknown option, including `--max-danmaku` | existing `Unknown option` wording |

Runtime failures exit `1` from `run_export` (no extra help). Doctor hint is `gather doctor fix --platform instagram`, plus `--chrome-profile <name>` when a profile is known.

| Condition | Message |
|---|---|
| No cookie | `Missing Instagram cookie` plus doctor hint |
| Cookie file missing | existing missing-cookie path |
| `like` / `collection` URL is not the logged-in profile | `source <source> requires the logged-in profile URL` |
| Chrome failed to open | existing session error text plus doctor hint |

A single-item download failure increments `download_failed` and does not abort the run.

## gather

- Platform key: `instagram`. Alias: `ig`.
- Handle base: `https://www.instagram.com/`. `@name` and `name` become `https://www.instagram.com/name/`.
- Default works export: `build_args` is `["post", url]`.
- Runtime `--chrome-profile` injection matches `xsave_douyin` when runtime has `instagram.chrome_profile`.
- `xsave_instagram` is treated like `xsave_douyin` for chrome-profile injection (same F2-family command set).
- `infer_command_platform_keys` maps `xsave_instagram` and `instagram.com` / `instagr.am` URLs to `instagram`.
- `rewrite_xsave_instagram_command_text` keeps already-valid `xsave_instagram <source> <url>` lines. It does not rewrite `instagram_likes_export`. There is no `f2 ig` history to migrate.
- gather `--refresh` does not add `--refresh` to `xsave_instagram`.

## gather doctor

- New adapter for `instagram`.
- Check: `xsave_instagram` on PATH, Chrome profile, Instagram cookie export, and a light login/profile probe.
- `gather doctor fix --platform instagram` writes runtime `chrome_profile` and exports cookies for the session.
- Cookie hosts: `instagram.com`, `cdninstagram.com`.
- Probe URL: an Instagram profile from config when present; otherwise `https://www.instagram.com/`.

## Help

Usage, description, every option (enum values listed; booleans default false), and examples with `#` comments.

Examples must include:

```
# Download liked posts
$0 like https://www.instagram.com/example_user/

# Download a user's posts and reels
$0 post https://www.instagram.com/example_user/

# Download a single post
$0 https://www.instagram.com/p/AbCdEfGhIjK/

# Scan the entire list instead of resuming at already downloaded items
$0 --full-scan like https://www.instagram.com/example_user/

# Preview collection export without writing files
$0 --dry-run collection https://www.instagram.com/example_user/
```

Do not mention `--max-danmaku`, F2 flags, `one`, or `COMMAND_BASE_F2_LIKE_LIMIT`.

## Testing

Inject `collect_list` / `download_media` / `open_session`. Do not hit live Instagram in unit tests.

| File | Coverage |
|---|---|
| `test/xsave_instagram_cli.test.js` | Help/version; source+URL; infer `video` from `/p/` and `/reel/`; short URL requires source; mismatches; `--max-danmaku` is unknown; `--max-comment 0` stays `0`; `--output` / `--full-scan` / `--limit` / `--refresh` / `--cookie-file` |
| `test/xsave_instagram_export_layout.test.js` | Debug layout uses `source:` and `full_scan:`; default `instagram/<source>`; no danmaku line |
| `test/xsave_instagram_export_resume.test.js` | Default stop at first downloaded item; `--full-scan` continues; `video` is a single item |
| `test/xsave_instagram_export_stats.test.js` | Stats fields; no `danmaku` |
| `test/xsave_instagram_plan_item.test.js` | skip / fill / download; `--refresh` re-downloads; invisible items still skip |
| `test/xsave_instagram_rewrite_command.test.js` | Normalize `xsave_instagram`; do not rewrite `instagram_likes_export` |
| `test/xsave_instagram_media_path.test.js` | Find media by shortcode |
| `test/xsave_instagram_sidecar.test.js` | meta + comments; no danmaku file |
| `test/gather.test.js` | Default `xsave_instagram post <url>`; inject `--chrome-profile`; gather `--refresh` is not passed through |
| doctor adapter tests | `instagram` is registered; fix hint uses `--platform instagram` |

Leave `instagram_likes_export` tests unchanged.

## Caller follow-up

Callers that already run `instagram_likes_export` need no change. New gather Instagram entries use `xsave_instagram post <url>`. Manual `like` / `collection` lines must use the logged-in profile URL.
