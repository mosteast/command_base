# cleanup_dev_cache Design

## Summary

Add a new CLI command at `bin/cleanup_dev_cache` for reporting and cleaning large developer cache directories on macOS. The command should default to reporting only, require an explicit `clean` subcommand for mutation, and default to moving matched directories to Trash instead of permanently deleting them.

The command should support:

- built-in cleanup profiles for common macOS developer cache locations
- explicit custom directories via `--path`
- explicit custom glob patterns via `--glob`
- dry-run, confirmation, debug, and quiet output modes

The first version should target directory-level cleanup only. It should not attempt to selectively delete files inside a matched directory.

## Goals

- Provide one reusable command for common macOS developer cache cleanup tasks.
- Keep the default behavior safe and reviewable.
- Reuse the CLI conventions already present in `bin/cleanup_xcode`.
- Let the user combine built-in profile targets with custom path or glob targets.
- Make it easy to inspect what will be touched before cleanup runs.

## Non-goals

- Do not replace `cleanup_xcode` in the first version.
- Do not add profile configuration files or external rule loading yet.
- Do not implement partial cleanup inside a matched directory.
- Do not implement simulator-runtime-aware pruning policies in the first version.
- Do not support non-macOS trash semantics in the first version.

## Recommended approach

Create a new Bash command, `bin/cleanup_dev_cache`, instead of extending `cleanup_xcode`.

Why this approach:

- The new command name matches the broader scope better than `cleanup_xcode`.
- It avoids turning `cleanup_xcode` into a mixed-purpose command with an inaccurate name.
- It allows the first version to reuse the same CLI style while keeping future expansion simple.

## Alternatives considered

### 1. Extend `cleanup_xcode`

Pros:

- Reuses more existing code directly.
- Avoids adding a new command name.

Cons:

- The command name becomes misleading once it includes Chrome clone and generic temp cache cleanup.
- The option surface will become harder to understand over time.

### 2. Implement a Node.js command

Pros:

- Easier long-term extensibility for structured rules, glob expansion, and richer reporting.
- Closer to some newer CLIs in this repo.

Cons:

- Higher first-version implementation cost.
- Less aligned with the current `cleanup_xcode` operator experience.

## Command surface

The command should expose two subcommands:

```bash
cleanup_dev_cache report [options]
cleanup_dev_cache clean [options]
```

Behavior rules:

- The user must explicitly choose `report` or `clean`.
- `report` is non-mutating and should only scan and summarize.
- `clean` is mutating and should run only after explicit confirmation, unless `--yes` is provided.
- `clean` should default to `--action trash`.

## CLI options

Required global options:

- `-h`, `--help`
- `-v`, `--version`
- `--debug`
- `--quiet`
- `-d`, `--dry-run`

Recommended command options:

- `--yes`
- `--action trash|delete`
- `--profile <name>` repeatable
- `--path <directory>` repeatable
- `--glob <pattern>` repeatable

Examples section in help should include:

```bash
# Report Xcode and simulator cache sizes
$0 report --profile xcode --profile simulator

# Preview moving Chrome clone directories to Trash
$0 clean --profile chrome_clone --dry-run

# Clean temp caches plus one explicit directory
$0 clean --profile temp_cache --path ~/Library/Developer/Xcode/DerivedData --yes

# Report custom matches from a glob
$0 report --glob '/private/var/folders/*/*/*/X/com.google.Chrome.code_sign_clone'
```

## Built-in profiles

The first version should ship with four built-in profiles.

### `xcode`

Targets:

- `~/Library/Developer/Xcode/DerivedData`
- `~/Library/Developer/Xcode/Archives`
- `~/Library/Developer/Xcode/iOS DeviceSupport`
- `~/Library/Developer/Xcode/SourcePackages`
- `~/Library/Caches/org.swift.swiftpm`

Notes:

- These are generally rebuildable caches or artifacts.
- First version should treat them as directory targets, not apply keep-count logic.

### `simulator`

Targets:

- `~/Library/Developer/CoreSimulator/Devices`

Optional extra action in report output:

- mention whether `xcrun simctl` is available
- mention that `delete unavailable` is outside the first version's main cleanup path unless explicitly expanded later

Notes:

- First version should not attempt selective simulator pruning.
- It should only treat the directory as a cleanup candidate.

### `chrome_clone`

Targets:

- `/private/var/folders/*/*/*/X/com.google.Chrome.code_sign_clone`

Notes:

- This profile is meant to catch the large Chrome code-sign clone directories observed during investigation.
- The glob should be expanded to concrete directories before reporting or cleaning.

### `temp_cache`

Targets:

- `/private/var/folders/*/*/*/T/metro-cache`
- `/private/var/folders/*/*/*/T/node-compile-cache`
- `/private/var/folders/*/*/*/T/jest_dx`
- `/private/var/folders/*/*/*/T/maestro_xctestrunner_xcodebuild_output*`

Notes:

- These are common developer temp caches that are safe to regenerate.
- This profile is intended to complement, not replace, profile-specific cleanup like `xcode`.

## Custom target support

The command should allow the user to augment built-in targets with:

- `--path <directory>`
- `--glob <pattern>`

Rules:

- Both options should be repeatable.
- `--path` should accept literal directory paths, including paths with spaces.
- `--glob` should be expanded by Bash with `nullglob` behavior so unmatched globs disappear cleanly.
- All resolved targets should be merged with profile targets and de-duplicated by resolved absolute path.

## Target resolution pipeline

Both `report` and `clean` should use the same resolution pipeline.

### Step 1: collect raw candidates

Collect candidates from:

- selected built-in profiles
- all `--path` arguments
- all `--glob` expansions

### Step 2: normalize

For each candidate:

- check whether it exists
- resolve it to an absolute canonical path
- verify that it is a directory

### Step 3: annotate

Track metadata for each resolved target:

- source kind: `profile`, `path`, or `glob`
- source label: profile name or raw argument
- resolved path
- existence status
- size, when available

### Step 4: de-duplicate

De-duplicate by resolved path while preserving the full set of source labels for reporting.

## Safety model

The command must be conservative by default.

### Default mutation behavior

- `report` never mutates.
- `clean` mutates only after explicit confirmation, unless `--yes` is set.
- `clean` defaults to `--action trash`.

### Trash behavior

For `--action trash`:

- Prefer a macOS Trash-compatible implementation.
- The implementation may use AppleScript or a local helper if one already exists in the repo.
- If a target cannot be moved to Trash safely, the command must fail that target explicitly.
- It must not silently fall back to permanent deletion.

### Delete behavior

For `--action delete`:

- Permanent deletion must be explicit.
- Only resolved concrete directories may be deleted.
- Never delete using unresolved profile roots or raw globs.

### Path guards

Before any mutation, reject dangerous targets such as:

- `/`
- `/Users`
- `$HOME`
- `/private/var/folders`
- broad parent directories that are clearly above the intended cleanup scope

The script should also reject:

- empty paths
- non-directory targets
- unresolved paths

## Report output

`report` should print:

- command version
- selected profiles
- custom path and glob inputs
- each resolved target with:
  - source
  - resolved path
  - size
  - status
- a total matched size summary when available

The output should stay readable in standard mode and more verbose in debug mode.

## Clean output

`clean` should:

1. run the same resolution logic as `report`
2. print the final target list and total size
3. warn about the selected action
4. request one overall confirmation unless `--yes` is set
5. execute per target
6. print one result line per target:
   - `trashed`
   - `deleted`
   - `skipped`
   - `failed`

At the end, print a summary:

- number of successful targets
- number of skipped targets
- number of failed targets

## Logging

Follow the style already used by `cleanup_xcode`:

- colorful output
- `DEBUG` lines before steps
- `DEBUG` lines before IO operations
- quiet mode suppresses normal info output

Suggested debug checkpoints:

- parsing options
- expanding profiles
- expanding globs
- resolving real paths
- checking target sizes
- performing Trash or delete operations

## Error handling

The script should fail clearly when:

- an unknown option is provided
- an unknown profile is provided
- `clean` is requested with no resolved targets
- `--action` has an invalid value
- a target fails path safety checks
- a Trash or delete operation fails for a target

For partial failures during cleanup:

- continue per-target where safe
- return a non-zero exit code if any target fails

## Implementation structure

Implement the command as a standalone Bash script at:

- `bin/cleanup_dev_cache`

Recommended internal structure:

1. constants and global flags
2. help and version output
3. logger helpers
4. CLI parsing
5. profile registration helpers
6. target collection
7. target normalization and safety validation
8. reporting
9. cleanup execution
10. command dispatch

## Verification plan

### Command-level verification

Run at least:

```bash
/Users/hailang/code_base/command_base/bin/cleanup_dev_cache report --profile xcode
/Users/hailang/code_base/command_base/bin/cleanup_dev_cache report --profile chrome_clone --debug
/Users/hailang/code_base/command_base/bin/cleanup_dev_cache clean --profile temp_cache --dry-run
/Users/hailang/code_base/command_base/bin/cleanup_dev_cache clean --glob '/private/var/folders/*/*/*/X/com.google.Chrome.code_sign_clone' --dry-run --yes
```

### Safety verification

Verify that:

- unmatched globs do not trigger deletion
- invalid paths fail before mutation
- default action remains `trash`
- unknown options fail immediately
- paths with spaces are handled correctly

## Open implementation notes

- The first version should share behavioral conventions with `cleanup_xcode`, but it does not need to refactor shared code yet.
- If Trash support is awkward in Bash for protected directories, it is acceptable to keep the first version limited to locations that can be safely moved to Trash and fail clearly elsewhere.
- If later versions need richer per-profile logic, the command can be migrated to Node.js without changing the top-level CLI shape.
