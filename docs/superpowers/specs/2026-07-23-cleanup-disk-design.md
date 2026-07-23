# cleanup_disk Design

## Summary

Add a macOS disk cleanup orchestrator at `bin/cleanup_disk` for daily inspection and tiered cleanup. The tool is **rule-driven**: built-in defaults cover known hotspots on this machine, an optional local override file lets rules evolve, and a `discover` subcommand uses mature analyzers (`gdu-go`, Spotlight/`mdfind`, `du`) to suggest new rules without auto-writing config.

Safety is conservative by default: `report` / `discover` are read-only; `clean` without `--yes` only prints a plan; real mutation requires `--yes`. Large-file and high-risk rules default to `action: report` and are never deleted by `clean`.

## Goals

- Provide one entry point for system-oriented disk hygiene on this Mac (not only developer caches).
- Support both daily `report` inspection and explicit `clean` with risk/kind filters.
- Keep cleanup scope as a **maintainable YAML rule list** that can change as the system changes.
- Use `discover` + external analyzers to propose new rules from live disk analysis.
- Reuse existing commands (`cleanup_dev_cache`, optionally `cleanup_xcode`) via `delegate` rules.
- Match existing CLI conventions: colorful output, `--debug`, `--quiet`, `--dry-run`, unknown options fail.

## Non-goals

- Do not replace `cleanup_xcode` or `cleanup_dev_cache`.
- Do not auto-apply discover suggestions to config in v1 (no `--apply`).
- Do not implement an interactive TUI.
- Do not support non-macOS Trash semantics in v1.
- Do not auto-delete iCloud media libraries, Docker VM images, or editor DB files; those stay report-only unless the user changes the rule.

## Recommended approach

**Orchestrator over a YAML rule library** (not a single monolithic cleaner, not discover-only).

Why:

- Matches the dual use case: daily report + tiered clean.
- Config stays the source of truth; discover only suggests.
- Reuses existing cleanup tools for known-safe profiles.
- Aligns with `cleanup_dev_cache` safety patterns (`trash` default, explicit confirmation).

## Alternatives considered

### 1. Monolithic cleaner that absorbs existing commands

Pros: one binary surface.  
Cons: duplicates logic, fights existing names, harder to maintain.

### 2. Discover/report only

Pros: safest, fastest to ship.  
Cons: fails the “tiered clean” half of the product goal.

## Architecture

```
cleanup_disk
├── config/cleanup_disk/
│   ├── defaults.yaml   # shipped defaults (machine-informed)
│   └── local.yaml      # optional local overrides (gitignored)
├── report              # read-only scan + size summary
├── discover            # read-only hotspot discovery → suggested YAML
└── clean               # plan by default; mutate only with --yes
         │
         ├─ cache / temp / artifact → trash|delete (if rule allows)
         ├─ large_file / action:report → always skip on clean
         └─ delegate → forward to cleanup_dev_cache (etc.)
```

Config merge: load `defaults.yaml`, then merge `local.yaml` by rule `id` (local wins for same id; new ids append).

## Rule model

Each rule describes what to scan, how risky it is, and whether mutation is allowed.

```yaml
version: 1
rule:
  - id: jetbrains_cache
    path: "~/Library/Caches/JetBrains"
    kind: cache           # cache | temp | artifact | large_file | delegate
    risk: low             # low | medium | high
    action: trash         # report | trash | delete | delegate
    min_age: 0d           # optional
    min_size: 100M        # optional; skip if below threshold
    enabled: true
    note: "IDE rebuildable cache"

  - id: docker_raw
    path: "~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw"
    kind: large_file
    risk: high
    action: report
    min_size: 1G
    note: "User must prune Docker manually"

  - id: idea_hprof
    glob: "~/java_error_in_idea.hprof"
    kind: artifact
    risk: low
    action: trash
    note: "Crash dump; usually disposable"

  - id: dev_cache_bundle
    kind: delegate
    risk: low
    action: delegate
    delegate_to: cleanup_dev_cache
    delegate_args: ["report", "--profile", "xcode", "--profile", "temp_cache"]
```

### Field rules

| Field | Meaning |
|-------|---------|
| `id` | Stable key for merge and discover dedupe |
| `path` / `glob` | Exactly one for non-delegate rules; `~` and globs supported |
| `kind` | Classification; drives filtering and default policy |
| `risk` | Sort order and `--risk` filter (clean only rules with risk ≤ selected) |
| `action` | `report` never mutates; `trash`/`delete` need `--yes`; `delegate` forwards |
| `enabled` | Soft-disable without deleting the rule |
| `min_size` / `min_age` | Optional match thresholds |
| `delegate_to` / `delegate_args` | Required when `action: delegate` |

### Risk filter semantics

`--risk low` means only `risk: low`.  
`--risk medium` means `low` and `medium`.  
`--risk high` means all risks.  
Default for `clean` when unspecified: `low` only (most conservative mutation set).

### v1 default rules (from live machine survey)

Pre-seed `defaults.yaml` from observed hotspots, with safe actions:

**`action: trash` (low risk caches/artifacts)** when enabled and matched:

- `~/Library/Caches/JetBrains`
- `~/Library/Caches/CocoaPods`
- `~/Library/Caches/Google`
- `~/Library/Caches/ms-playwright`
- `~/Library/Caches/pip`
- `~/Library/Caches/Yarn`
- `~/Library/Caches/Homebrew` (optional; regenerateable)
- `~/.cache` (as a whole or well-known subdirs if preferred at implement time)
- `~/java_error_in_idea.hprof`

**`action: report` (high impact / user decision)**:

- Docker `Docker.raw`
- Cursor `state.vscdb` / `.backup`
- iCloud `Mobile Documents/.../saved/video` tree (or a parent `saved` path)
- Large home dirs that are projects/data: `~/code_base` (report-only context, not a clean target)

**`action: delegate`**:

- v1 ships a delegate rule that invokes `cleanup_dev_cache report` only (read-only). Mutating delegation to `cleanup_dev_cache clean` is out of scope for v1; users run that command directly.

Exact path strings may be refined during implementation as long as the action/risk policy above is preserved.

## CLI surface

Command: `bin/cleanup_disk`

```bash
cleanup_disk report   [options]
cleanup_disk discover [options]
cleanup_disk clean    [options]
```

If no subcommand is given, default to `report`.

### Required global options

- `-h`, `--help`
- `-v`, `--version` (version number only)
- `--debug`
- `--quiet`
- `-d`, `--dry-run`
- Unknown options must fail

### Subcommand options

| Option | Applies to | Description |
|--------|------------|-------------|
| `--config <path>` | all | Extra config file; still merge with defaults |
| `--rule <id>` | report/clean | Repeatable; only listed rules |
| `--kind <k>` | report/clean | Filter by kind |
| `--risk <r>` | report/clean | Risk ceiling for inclusion (see semantics) |
| `--min-size <s>` | report/discover | Raise/override size floor |
| `--yes` | clean | Required for real mutation |
| `--action trash\|delete` | clean | Override rule action where mutation is allowed |
| `--top <n>` | discover | Top N items (default 30) |
| `--root <path>` | discover | Scan root (default `$HOME`) |

### Examples (help format)

```bash
# Daily inspection of all enabled rules
$0 report

# Discover hotspots and print suggested YAML snippets
$0 discover --root ~ --top 40

# Preview cleaning low-risk caches only
$0 clean --risk low --kind cache

# Apply low-risk cache cleanup after review
$0 clean --risk low --kind cache --yes

# Report a single rule
$0 report --rule jetbrains_cache --debug
```

## Safety model

1. `report` and `discover` never mutate the filesystem.
2. `clean` without `--yes` prints the plan only (same spirit as dry-run).
3. `clean --yes` still defaults to trash semantics unless a rule or `--action delete` requests permanent delete.
4. Rules with `action: report` are always skipped by `clean`.
5. Path guards reject dangerous targets such as `/`, `/Users`, `$HOME`, `/private/var/folders`, and other over-broad parents.
6. Empty / missing / non-matching targets are skipped with a clear status, not treated as success-to-delete.
7. Trash failures must not silently fall back to permanent delete.
8. Delegate rules inherit the callee’s own safety model; `cleanup_disk` must pass through dry-run/`--yes` intent where the callee supports it.

## `discover` pipeline

1. Dependency check: prefer `gdu-go`; if missing, warn and fall back to `mdfind` + `/usr/bin/du`.
2. Shallow directory ranking under `--root` (and known hotspot subtrees such as `Library/Caches`, common dotdirs) via `gdu-go -n -p --si --depth 1` where practical.
3. Large-file pass via Spotlight: `mdfind` with size threshold from `--min-size` (default 1G).
4. Filter out paths already covered by existing rules, protected system paths, and obvious non-candidates (e.g. `.app` bundles).
5. Heuristic classification:
   - path contains `Cache`/`cache` → `kind: cache`, suggest `action: trash`, `risk: low|medium`
   - `*.hprof` / obvious dumps → `kind: artifact`, `action: trash`
   - otherwise large items → `kind: large_file`, `action: report`, `risk: high`
6. Print a human summary plus pasteable YAML snippets with suggested new `id` values.
7. v1 does **not** write config files.

## Report / clean behavior

### Report

For each matched enabled rule (after filters):

- resolve path/glob
- compute size when available
- print: id, kind, risk, action, path, size, status, note
- print totals by kind and grand total reclaimable vs report-only

### Clean

1. Resolve the same candidate set as report.
2. Drop `action: report` rules.
3. Print the plan and total size.
4. If `--yes` is absent, exit 0 after the plan (or exit non-zero only on resolution errors — prefer 0 for “plan only”).
5. If `--yes` is set, execute per target: trash / delete / delegate.
6. Per-target results: `trashed`, `deleted`, `delegated`, `skipped`, `failed`.
7. Non-zero exit if any target fails.

## Implementation structure

- `bin/cleanup_disk` — Bash orchestrator (style aligned with `cleanup_dev_cache`)
- `config/cleanup_disk/defaults.yaml` — shipped rules
- `config/cleanup_disk/local.yaml` — optional, listed in `.gitignore`
- Reuse `lib/file/trash.js` for trash actions
- Prefer assembling existing commands for delegate targets

Suggested internal stages:

1. constants / logging / colors
2. help / version
3. CLI parse (fail on unknown options)
4. load + merge config
5. resolve + guard targets
6. report
7. discover
8. clean
9. dispatch

## Logging

Follow existing cleanup commands:

- colorful info/warn/error
- `DEBUG` before each stage and before IO when `--debug`
- `--quiet` suppresses info

## Error handling

Fail clearly when:

- unknown option / unknown subcommand
- invalid `--action`, `--risk`, or `--kind`
- config YAML missing/invalid `version` or malformed rules
- clean mutation requested against path-guard failures
- trash/delete/delegate fails for a target (continue others; non-zero at end)

## Verification plan

```bash
bin/cleanup_disk report
bin/cleanup_disk report --rule jetbrains_cache --debug
bin/cleanup_disk discover --root "$HOME" --top 20
bin/cleanup_disk clean --risk low --kind cache
bin/cleanup_disk clean --risk low --kind cache --dry-run
# mutation only in controlled fixtures / explicit local testing:
# bin/cleanup_disk clean --rule idea_hprof --yes
```

Automated tests should cover:

- config merge by `id`
- risk/kind/rule filters
- path guards
- clean without `--yes` does not mutate
- discover does not emit duplicates for paths already in defaults
- unknown options fail

## Open implementation notes

- Full-home `gdu-go` scans can be very slow; discover should prefer segmented hotspot scans over one unbounded home walk.
- Homebrew installs the Go analyzer as `gdu-go` (not `gdu`, which may be GNU coreutils).
- If YAML parsing in pure Bash is awkward, a small Node helper under `lib/` is acceptable as long as the user-facing command remains `bin/cleanup_disk`.
- Exact default rule list can be trimmed if a path proves unsafe; prefer flipping `action` to `report` or `enabled: false` over deleting the rule id.
