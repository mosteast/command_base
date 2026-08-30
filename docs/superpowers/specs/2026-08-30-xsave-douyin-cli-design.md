# xsave_douyin CLI Design

## Summary

Replace the F2-shaped `xsave_douyin -M <mode> -u <url>` surface with positional source + URL. Infer `video` from `/video/<id>` URLs. Rename `--path` and `--check-all`. Add `--limit`, `--refresh`, and `--cookie-file`. Update `gather` to emit and rewrite the new form. Do not keep F2 flag aliases.

## Goals

- Everyday use is `xsave_douyin like <url>` or `xsave_douyin <video-url>`.
- Source names describe list origin (`like`, `post`, `collection`, `video`), not F2 mode.
- Option names match sibling `xsave_*` commands where they overlap.
- Missing power controls (`--limit`, `--refresh`, `--cookie-file`) are first-class flags.
- `gather` emits the new form and rewrites `f2 dy -M … -u …` into it.

## Non-goals

- Multiple URLs in one invocation.
- `--source` as a flag alias of the positional source.
- Passing gather's own `--refresh` through to `xsave_douyin` (still yt-dlp platforms only).
- Changing Chrome session, download, sidecar, or resume algorithms except where a renamed option or new flag is wired in.
- Keeping `-M`, `--mode`, `-u`, `--url`, `--path`, `--check-all`, or `one` as aliases.

## Recommended approach

**Positional source + URL, infer `video` when the URL is a video page.**

Why:

- A user page can be likes, works, or collections; that choice belongs in the first token.
- A `/video/<id>` URL already is a single item; requiring a source is ceremony.
- One invocation shape is easier than F2 flags plus a parallel modern alias set.

## Alternatives considered

### 1. URL only, `--source` when needed

Pros: shortest for single videos.  
Cons: omitting `--source` on a user page is easy to get wrong (works vs likes).

### 2. Keep `-M` / `-u` as aliases

Pros: smaller gather/test churn.  
Cons: two ways to say the same thing; F2 names stay in help and muscle memory.

## Invocation

```
xsave_douyin <source> <url> [options]
xsave_douyin <video-url> [options]
```

Allowed `source` values: `like`, `post`, `collection`, `video`.

Parse rules:

1. Options may appear before or after source and URL. They are not positionals.
2. Collect remaining non-option tokens as positionals.
3. If the first positional is an allowed source, that is `source`. The next token is `url`. Any further positional is an error (`Unexpected argument`).
4. If the first positional is not an allowed source, treat it as `url` and infer `source` as `video` only when the URL path contains `/video/<id>` (`id` is one or more digits). Otherwise fail with `Missing source`.
5. A short URL (`v.douyin.com`) never infers `source`. It requires an explicit source, including `video` for a single-item short link.
6. After source and URL are known, reject mismatches:
   - `video` + user URL (`/user/<id>`) → `source video does not match user URL`
   - `like|post|collection` + `/video/<id>` → `source <source> does not match video URL`
   - Short URLs are not mismatches; they are allowed with any explicit source.
7. `one` is not a source. Passing it fails as `Invalid source one`.

Examples:

```
# Likes / works / collections
$0 like https://v.douyin.com/kIg44MNOKz8/
$0 post https://www.douyin.com/user/MS4wLjABAAAA
$0 collection https://www.douyin.com/user/MS4wLjABAAAA

# Single item; `video` is optional when the path is /video/<id>
$0 https://www.douyin.com/video/123
$0 video https://v.douyin.com/AbCdEf/

# Invalid
$0 https://www.douyin.com/user/MS4wLjABAAAA
$0 like https://www.douyin.com/video/123
```

## Options

Keep:

| Option | Behavior |
|---|---|
| `--chrome-profile <name>` | Same as today; omit to use gather runtime |
| `--max-comment <n>` | Per-item comment cap. Default `500`. `0` means do not fetch comments |
| `--max-danmaku <n>` | Per-item danmaku cap. Default `500`. `0` means do not fetch danmaku |
| `-d, --dry-run` | Plan only |
| `--quiet` / `--debug` | Repo standard |
| `-h` / `-v` | Repo standard |

Rename:

| Old | New | Behavior |
|---|---|---|
| `-p, --path` | `-o, --output <dir>` | Output root. Default remains the existing Douyin library: `…/douyin/<source>` (`video` uses `douyin/video`, not `douyin/one`) |
| `--check-all` | `--full-scan` | Scan the whole list; default still stops at the first already-downloaded item |

Add:

| Option | Behavior |
|---|---|
| `--limit <n>` | Process at most `n` items. `n` must be a positive integer. When omitted, fall back to `COMMAND_BASE_F2_LIKE_LIMIT` if that env var is a positive integer; otherwise no limit. Do not document the env var in help |
| `--refresh` | Re-download existing media and rewrite that item's sidecars. Default still skips existing media and only fills missing sidecars |
| `--cookie-file <path>` | Use this cookie file. Chrome may still open; do not export a cookie from the profile when this flag is set. A missing file fails at run time with the existing missing-cookie error path |

Remove with no aliases: `-M`, `--mode`, `-u`, `--url`, `-p`, `--path`, `--check-all`, `one`.

Unknown options still fail.

`--max-comment 0` and `--max-danmaku 0` must not fall back to `500`. Today's `Number(value) \|\| DEFAULT` treats `0` as missing and is a bug to fix in this change.

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
| `max_danmaku` | number | `--max-danmaku` |
| `dry_run` | boolean | `--dry-run` |
| `quiet` | boolean | `--quiet` |
| `debug` | boolean | `--debug` |

Help/version still short-circuit as `{ help: true }` and `{ version: true, version_text }`.

`run_export` and debug layout lines use these names. They must not read `mode`, `path`, or `check_all`.

At the `chrome_client` boundary, `source === "video"` maps to the existing detail path that today keys off `"one"`. List sources `like` / `post` / `collection` keep their current API paths. `chrome_client` may keep an internal `"one"` token for that mapping; public CLI and `run_export` options do not.

Default output directory is `…/douyin/<source>`. Single-item default therefore moves from `douyin/one` to `douyin/video`. Callers that passed an explicit output path are unchanged.

## Errors

On parse failure: one reason line on stderr, then help, exit `1`.

| Condition | Message |
|---|---|
| No URL | `Missing URL` |
| User or short URL without source | `Missing source. Use like, post, collection, or a /video/ URL` |
| Unknown source token | `Invalid source <x>. Allowed: like, post, collection, video` |
| Extra positional | `Unexpected argument <token>` |
| `video` + `/user/` URL | `source video does not match user URL` |
| `like\|post\|collection` + `/video/` URL | `source <source> does not match video URL` |
| `--limit` not a positive integer | `Invalid --limit <x>. Use a positive integer` |
| `--max-comment` / `--max-danmaku` not an integer `>= 0` | `Invalid --max-comment <x>` / `Invalid --max-danmaku <x>` |
| Unknown option | existing `Unknown option` wording |

## gather

- Default Douyin works export: `build_args` is `["post", url]`.
- Runtime `--chrome-profile` injection is unchanged.
- `f2 dy …` / `f2_compat dy …` rewrite must produce the new form, not a prefix-only swap:
  - `f2 dy -M like -u <url>` → `xsave_douyin like <url>`
  - `f2 dy -M post -u <url>` → `xsave_douyin post <url>`
  - `f2 dy -M collection -u <url>` → `xsave_douyin collection <url>`
  - `f2 dy -M one -u <url>` → `xsave_douyin video <url>` when the URL is not already a `/video/<id>` path; if it is, `xsave_douyin <url>` is also valid. Prefer `xsave_douyin video <url>` so short links stay explicit.
  - Preserve other already-valid flags (`--chrome-profile`, `--dry-run`, …). Drop `-M`/`--mode`/`-u`/`--url`/`--path`/`--check-all` after translation (`--path` → `--output`, `--check-all` → `--full-scan`).
- When gather normalizes a command for display or execution, also rewrite already-migrated-prefix lines that still use F2 flags, e.g. `xsave_douyin -M post -u <url>` → `xsave_douyin post <url>`.
- gather `--refresh` still does not add `--refresh` to `xsave_douyin`.

## Help

Usage, description, every option (enum values listed; booleans default false), and examples with `#` comments. Examples use `$0 like <url>` / `$0 post <url>` / `$0 <video-url>` / `$0 --full-scan like <url>` / `$0 --dry-run collection <url>`. Do not mention F2 flags or `one`.

## Testing

- `parse_cli`: source+URL, inferred video URL, short URL requires source, mismatches, removed F2 flags fail, `--output` / `--full-scan` / `--limit` / `--refresh` / `--cookie-file`, `--max-comment 0` stays `0`.
- CLI help: new usage and examples; no `-M`, `-u`, `--check-all`, `one`.
- `run_export`: reads `source` / `output` / `full_scan` / `limit` / `refresh` / `cookie_file`; `--refresh` re-downloads existing media; `--limit` caps items; debug layout uses the new field names.
- `gather`: default `xsave_douyin post <url>`; runtime still injects `--chrome-profile`; `f2 dy -M like -u <url>` becomes `xsave_douyin like <url>`.

## Caller follow-up

Any saved gather config or script that still runs `xsave_douyin -M … -u …` will fail until rewritten. gather's own generated and rewritten commands are updated in this change. Manual configs that already use the old flags need the same rewrite gather applies to `f2 dy` lines.
