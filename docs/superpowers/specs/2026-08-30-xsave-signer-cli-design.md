# xsave `--signer` CLI Design

## Summary

Add `--signer` to `xsave_instagram` and `xsave_douyin` so `like` and `collection` can export the **currently logged-in account** without a profile URL. Instagram likes open `your_activity/interactions/likes`. Gather defaults stay `post <url>`. `instagram_likes_export` is unchanged.

This extends `2026-08-30-xsave-instagram-cli-design.md` and `2026-08-30-xsave-douyin-cli-design.md`. Those specs still apply except where this document overrides the URL requirement for `like` / `collection`.

## Goals

- `xsave_instagram like --signer` and `xsave_douyin like --signer` export the logged-in user's likes.
- The same flag works for `collection`.
- A profile URL is still required when `--signer` is omitted.
- Instagram's likes list URL is the real Your Activity page, not `/your_activity/liked`.

## Non-goals

- Changing gather's default Instagram/Douyin command (`post <url>`).
- Auto-appending `--signer` from gather.
- Accepting `--signer` on `post` or `video`.
- Inferring `like` from `--signer` alone (no source token).
- Inferring `--signer` from a missing URL.
- Exporting another user's likes on Instagram (the product has no public list).
- Rewriting `instagram_likes_export`.
- Extracting a shared `lib/xsave_core/`.
- Live Instagram or Douyin login tests in the unit suite.

## Recommended approach

**Shared boolean `--signer` on both CLIs.** When `source` is `like` or `collection`, omit the URL and open the logged-in account's list.

Why:

- Matches the requested invocation.
- Keeps source tokens as list origin; `--signer` only answers "whose list".
- Avoids a silent meaning change when a URL is missing.

## Alternatives considered

### 1. New sources `self-like` / `self-collection`

Pros: no new flag.  
Cons: source set no longer matches across the two commands; "who" leaks into source names.

### 2. Treat a missing URL as signer

Pros: shorter command.  
Cons: `Missing URL` becomes a silent behavior change; conflicts with the existing required-URL contract.

## Invocation

Existing forms stay valid:

```
xsave_instagram <source> <url> [options]
xsave_instagram <item-url> [options]
xsave_douyin <source> <url> [options]
xsave_douyin <video-url> [options]
```

New forms (both commands):

```
<command> like --signer [options]
<command> collection --signer [options]
```

`--signer` is valid only with `like` or `collection`. Other flags may appear before or after source and `--signer`.

## Parse rules

`--signer` is a boolean option. Default `false`. Unknown options still fail.

`parse_cli` on both packages returns the existing fields plus `signer: boolean`.

1. Options are not positionals. `--signer` is consumed in option parsing.
2. If `signer` is true and the resolved `source` is `post` or `video`, fail: `source <source> does not accept --signer`.
3. If `signer` is true and the resolved `source` is `like` or `collection`:
   - Zero URL positionals is success. `url` is `""`.
   - Any extra positional (including a profile or item URL) fails: `Unexpected argument <token>`.
4. If `signer` is true but there is no source token and no inferable item/video URL, keep the current errors (`Missing URL` and/or `Missing source`). Do not infer `like`.
5. If `signer` is false, keep the current URL rules, including `Missing URL` when `like` / `collection` have no URL.
6. Source/URL mismatch checks run only when `url` is non-empty.

## Pages and session

Cookie / Chrome session resolution is unchanged. A missing cookie still uses the existing missing-cookie path. `--signer` does not skip login.

### Instagram

| source | `--signer` | Page |
|---|---|---|
| `like` | yes | `https://www.instagram.com/your_activity/interactions/likes/` |
| `collection` | yes | Read the session username, then `https://www.instagram.com/{user}/saved/all-posts/` |
| `like` | no | Same likes URL as above (fix the current `/your_activity/liked` path). Still require a profile URL that matches the session user |
| `collection` | no | `/{username}/saved/all-posts/` from the profile URL. Still require that URL to match the session user |

When `signer` is true, skip `assert_logged_in_profile` (there is no URL to match). Still require a readable session user for `collection` so the saved URL can be built. If the session username is empty, fail with `source collection requires a logged-in Instagram session`.

`list_page_urls("like")` must return the `interactions/likes` URL even when `url` is empty.

### Douyin

When `signer` is true:

1. Open the existing Chrome session.
2. Resolve the logged-in `sec_user_id` from that session (`resolve_session_sec_user_id`). Use the same extraction already used when a profile URL redirects to `/user/<sec_user_id>`.
3. Pass that `sec_user_id` into the existing like / collection collect path. Do not read `sec_user_id` from the (empty) CLI URL.

If the session is open but `sec_user_id` cannot be resolved, fail with `source <source> requires a logged-in Douyin session`.

When `signer` is false, keep today's URL-required collect. Do not add Instagram's "URL must be the session user" check to Douyin.

## Export behavior

Unchanged except for how the list page / `sec_user_id` is chosen:

- Default output: `instagram/like`, `instagram/collection`, `douyin/like`, `douyin/collection`.
- `--limit`, `--full-scan`, `--refresh`, `--max-comment`, `--dry-run`, `--output`, `--cookie-file`, `--chrome-profile` behave as today.
- Plan / download / sidecar / stats are unchanged.

## Errors

Parse failures: one reason line on stderr, then help, exit `1`.

| Condition | Message |
|---|---|
| `like` / `collection` plus `--signer` plus a positional URL | `Unexpected argument <token>` |
| `post` / `video` plus `--signer` | `source <source> does not accept --signer` |
| `--signer` with no source and no inferable item URL | existing `Missing URL` / `Missing source` |
| `like` / `collection` without `--signer` and without URL | existing `Missing URL` |

Runtime failures exit `1` from `run_export` (no extra help).

| Condition | Message |
|---|---|
| Instagram `like` / `collection` without `--signer`, URL is not the session user | existing `source <source> requires the logged-in profile URL` |
| Instagram `collection --signer` but session username is empty | `source collection requires a logged-in Instagram session` |
| Douyin `--signer` but no `sec_user_id` | `source <source> requires a logged-in Douyin session` |
| Missing cookie / Chrome failed | existing wording plus doctor hint |

## gather

Do not change defaults. `build_args` stays `["post", url]`.

Do not auto-append `--signer`.

`rewrite_xsave_instagram_command_text` and `rewrite_xsave_douyin_command_text` must keep `--signer` and must not invent a URL for `like --signer` / `collection --signer`. A line that is already `xsave_* like --signer` stays valid.

Users who want likes via gather put `xsave_instagram like --signer` (or the Douyin equivalent) in their own command config.

## Help

Add `--signer` to Options: boolean, default false. Describe it as exporting the logged-in account for `like` and `collection`.

Add usage lines for the signer forms.

Add these examples on both commands:

```
# Download the logged-in account's likes
$0 like --signer

# Download the logged-in account's collections
$0 collection --signer
```

Keep the existing URL examples.

## Testing

Inject Chrome / collect helpers. Do not hit live Instagram or Douyin.

| File | Coverage |
|---|---|
| `test/xsave_instagram_cli.test.js` | `like --signer` and `collection --signer` parse with `url === ""` and `signer === true`; extra URL is `Unexpected argument`; `post --signer` and `video --signer` fail; `--signer` without source keeps `Missing URL` / `Missing source`; help lists `--signer` |
| `test/xsave_douyin_cli.test.js` | Same parse matrix |
| `test/xsave_instagram_export_*.test.js` or a focused chrome/list test | `list_page_urls("like")` is `…/your_activity/interactions/likes/`; collection + signer uses the session username; `run_export` does not call `assert_logged_in_profile` when `signer` is true |
| Douyin export / chrome test | `--signer` resolves `sec_user_id` from the session and does not require a CLI URL |
| rewrite tests | `xsave_* like --signer` is kept; no URL is invented |

`gather.test.js` stays on `xsave_instagram post <url>`. Do not add a default `--signer` assertion that would lock a gather change.

Leave `instagram_likes_export` tests unchanged.

## Caller follow-up

Existing `xsave_* <source> <url>` callers need no change. Callers that want the logged-in likes list should switch to `like --signer`. Gather-generated Instagram/Douyin lines stay `post <url>`.
