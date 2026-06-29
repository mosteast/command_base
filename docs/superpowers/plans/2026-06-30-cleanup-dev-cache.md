# cleanup_dev_cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable `cleanup_dev_cache` CLI that reports and safely cleans common macOS developer cache directories using built-in profiles plus explicit path and glob targets.

**Architecture:** Implement a standalone Bash CLI in `bin/cleanup_dev_cache`, reusing the logging and command style from `cleanup_xcode` while adding a generic target resolution pipeline. Cover the command with focused Vitest CLI tests that exercise report output, dry-run cleanup, safety guards, and trash behavior through a temporary trash directory.

**Tech Stack:** Bash, Node.js child process tests, Vitest

---

### Task 1: Add CLI regression tests first

**Files:**
- Create: `test/cleanup_dev_cache.test.js`
- Test: `test/cleanup_dev_cache.test.js`

- [ ] **Step 1: Write the failing tests for report, dry-run cleanup, and safety checks**

Add `test/cleanup_dev_cache.test.js` with CLI coverage for:
- report with `--path`
- clean with `--dry-run`
- clean defaulting to Trash
- dangerous path rejection
- unknown profile rejection

- [ ] **Step 2: Run the new test file to verify it fails**

Run: `npx vitest run test/cleanup_dev_cache.test.js`
Expected: FAIL because `bin/cleanup_dev_cache` does not exist yet.

- [ ] **Step 3: Commit the failing test skeleton**

```bash
git add test/cleanup_dev_cache.test.js
git commit -m "test: add cleanup_dev_cache cli coverage"
```

### Task 2: Implement the cleanup_dev_cache CLI

**Files:**
- Create: `bin/cleanup_dev_cache`
- Modify: `test/cleanup_dev_cache.test.js`
- Reference: `bin/cleanup_xcode`

- [ ] **Step 1: Create the CLI skeleton with help, version, logging, and command dispatch**

Implement:
- `report` and `clean` subcommands
- `-h`, `--help`
- `-v`, `--version`
- `--debug`
- `--quiet`
- `-d`, `--dry-run`
- `--yes`
- `--action trash|delete`
- repeatable `--profile`, `--path`, and `--glob`

- [ ] **Step 2: Add target collection, profile expansion, realpath normalization, and safety guards**

Implement built-in profiles:
- `xcode`
- `simulator`
- `chrome_clone`
- `temp_cache`

Implement:
- path and glob expansion
- candidate de-duplication
- resolved-path reporting
- directory-only validation
- dangerous-path rejection

- [ ] **Step 3: Add report output and cleanup execution with Trash-by-default behavior**

Implement:
- target summary output
- size lookup
- total matched size
- overall confirmation for `clean`
- default Trash behavior
- explicit delete behavior
- per-target result lines
- non-zero exit code on partial cleanup failure

- [ ] **Step 4: Make the CLI executable**

Run: `chmod +x bin/cleanup_dev_cache`
Expected: no output

- [ ] **Step 5: Run the targeted CLI test file to verify it passes**

Run: `npx vitest run test/cleanup_dev_cache.test.js`
Expected: PASS

- [ ] **Step 6: Commit the implementation**

```bash
git add bin/cleanup_dev_cache test/cleanup_dev_cache.test.js
git commit -m "feat: add cleanup_dev_cache cli"
```

### Task 3: Verify real command behavior in the worktree

**Files:**
- Modify: none
- Test: `bin/cleanup_dev_cache`

- [ ] **Step 1: Run report against an explicit path target**

Run: `bin/cleanup_dev_cache report --path "$HOME/Library/Developer/Xcode/DerivedData"`
Expected: PASS and print a resolved target entry.

- [ ] **Step 2: Run a dry-run cleanup for temp cache targets**

Run: `bin/cleanup_dev_cache clean --profile temp_cache --dry-run --yes`
Expected: PASS and print planned Trash operations without deleting anything.

- [ ] **Step 3: Run report for Chrome clone targets in debug mode**

Run: `bin/cleanup_dev_cache report --profile chrome_clone --debug`
Expected: PASS and print debug logging for glob expansion and target resolution.

- [ ] **Step 4: Commit any final polish if verification changed code**

```bash
git status --short
# If there are intentional follow-up edits:
git add bin/cleanup_dev_cache test/cleanup_dev_cache.test.js
git commit -m "chore: polish cleanup_dev_cache verification output"
```
