# gather_setup Design

## Summary

Add a standalone `gather_setup` command that checks and configures the platforms `gather` depends on. Logic lives in per-platform adapters under `lib/gather_setup/`. A shared `gather.runtime.yaml` (next to existing gather state) records Chrome profile mappings and cookie file paths. `gather`, `xsave_yt_dlp`, and `xsave_gallery_dl` consume that runtime so exports use the right auth materials without re-prompting.

## Goals

- Give one entry point to verify gather can run across youtube, bilibili, rumble, bitchute, douyin, x_f2, and x_gallery_dl.
- Default to `check` (static + live probe); explicit `setup` writes config and can install/upgrade tools.
- Automate any step that can be automated or compressed (profile scan, cookie export, brew install/upgrade).
- Keep secrets out of logs: report cookie host presence only, never cookie values.
- Match existing CLI conventions: `--debug`, `--quiet`, `--dry-run`, unknown options fail, colorful output.

## Non-goals

- Do not download real media as a “test”.
- Do not silently overwrite cookies or run brew without confirmation (unless `--yes`).
- Do not invent a second f2 config path; write into f2’s existing config.
- Do not inject Chrome browser cookies for rumble/bitchute in v1 unless `xsave_yt_dlp`’s cookie mode is extended in the same change (today only youtube/bilibili use browser cookies).
- Do not absorb `gather init` or rewrite gather source lists / state pointers.

## Recommended approach

**Per-platform adapters + shared runtime YAML** (not a thin export-only CLI, not a single monolithic script).

Why:

- Platform auth differs (yt-dlp browser cookies, gallery-dl Netscape file, f2 conf).
- Runtime file lets `gather` and direct `xsave_*` invocations stay consistent.
- Tests can isolate adapters without live network.

## Alternatives considered

### 1. Export cookies only; avoid changing gather

Pros: smaller diff.  
Cons: Chrome profile mapping is not a durable fact; gather keeps reading Default.

### 2. Monolithic `bin/gather_setup` with all logic inline

Pros: fastest first cut.  
Cons: hard to test per platform; repeats the size problem already visible in `gather`.

## Architecture

```
bin/gather_setup
└── lib/gather_setup/
    ├── runtime_config.js      # read/write gather.runtime.yaml
    ├── chrome_profile.js      # list profiles; host scan via copied Cookies DB
    ├── cookie_export.js       # Netscape export from a profile
    ├── brew_install.js        # brew install / upgrade
    ├── read_runtime_cli.js    # bash-friendly runtime queries
    └── adapter/
        ├── youtube.js
        ├── bilibili.js
        ├── rumble.js
        ├── bitchute.js
        ├── douyin.js
        ├── x_f2.js
        └── x_gallery_dl.js
```

Consumers:

- `gather` injects `--cookies-from-browser chrome:<profile>` for youtube/bilibili when building `xsave_yt_dlp` jobs.
- `xsave_yt_dlp` reads runtime when the user did not pass cookie flags.
- `xsave_gallery_dl` prefers the runtime cookie path over `~/Downloads/cookies.txt` when flags are omitted.
- f2 platforms: setup writes cookies into f2’s existing conf (`~/.f2/conf.yaml` or current official path verified at implement time).

## Default paths

Aligned with gather:

| Role | Path |
|------|------|
| gather config | `.../main/saved/state/gather.config.yaml` |
| gather state | `.../main/saved/state/gather.state.json` |
| gather runtime | `.../main/saved/state/gather.runtime.yaml` |

## Runtime file shape

Records facts, not secrets:

```yaml
version: 1
updated_at: "2026-08-23T00:00:00.000Z"
platform:
  youtube:
    chrome_profile: "Profile 2"
    cookies_from_browser: "chrome:Profile 2"
  bilibili:
    chrome_profile: "Default"
    cookies_from_browser: "chrome:Default"
  x_gallery_dl:
    chrome_profile: "Profile 1"
    cookies_file: "/Users/.../Downloads/cookies.txt"
  douyin:
    chrome_profile: "Profile 1"
    f2_config: "~/.f2/conf.yaml"
  x_f2:
    chrome_profile: "Profile 1"
    f2_config: "~/.f2/conf.yaml"
```

## CLI contract

```
gather_setup [check] [options]
gather_setup setup [options]
```

Shared flags: `--config`, `--platform`, `--exclude-platform`, `--chrome-profile`, `--offline` (check), `--yes` (setup), `--dry-run`, `--quiet`, `--debug`, `-h`, `-v`.

Platform aliases match gather (`yt`, `bili`, `dy`, `x`, …).

### check (default)

1. Repo commands on PATH: `xsave_yt_dlp`, `xsave_gallery_dl`, `f2_compat`.
2. External binaries: `yt-dlp`; `gallery-dl >= 1.31.10`; `f2` via `COMMAND_BASE_F2_UPSTREAM` or `~/.local/bin/f2`.
3. Scan Chrome profiles (or `--chrome-profile`); report hosts only.
4. Parse gather config; verify output dirs writable.
5. Unless `--offline`: no-media probe using the first live handle from config when available.
6. Per-platform `ok` / `warn` / `fail` plus next command. Any `fail` → non-zero exit.

### setup

1. Same diagnosis as check.
2. Print write/install plan; confirm unless `--yes`; `--dry-run` stops after the plan.
3. Write `gather.runtime.yaml`. Multiple profiles with the same host → confirm; `--yes` picks most recently used.
4. Export Netscape cookies to tool-expected paths; write f2 conf for douyin / x_f2.
5. Missing or old tools → brew install/upgrade (confirmed). Brew failure stops that platform; keep earlier writes.
6. Locked Chrome Cookies DB → copy then read; on failure tell user to quit Chrome.
7. Re-run check after setup.

## Error handling

- Never print cookie values or full Netscape file contents.
- Classify probe failures: missing tool, cookie expired/auth, rate limit, other.
- Chrome lock: copy-then-query; fail with clear quit-Chrome guidance.
- Confirmation required for writes and brew unless `--yes`.

## Testing

Vitest, no live network:

- `test/gather_setup_cli.test.js`
- `test/gather_setup_chrome_profile.test.js`
- `test/gather_setup_runtime.test.js`
- `test/gather_setup_adapter_yt_dlp.test.js`
- `test/gather_setup_adapter_gallery_dl.test.js`
- `test/gather_setup_adapter_f2.test.js`

Also extend gather and xsave tests for runtime injection / fallback. Cover `--dry-run` and `--yes`.

## Implementation notes

- Touching two or more repo-owned source files → task branch + isolated git worktree, then merge back.
- New files only under `bin/`, `lib/gather_setup/`, `test/`, and this design doc under `docs/superpowers/specs/`.
