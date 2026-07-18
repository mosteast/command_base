# YAML Patch Transaction Core First Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review, harden, and finally verify the committed YAML Patch Task 8 transaction core without starting any later batch.

**Architecture:** Treat the committed subtree compiler, current-snapshot transaction planner, diff generator, and reproducible manifest as one review unit. Close only the specification and quality gaps in that unit, reuse the existing query/profile/range/proof modules, and keep all file-writing, CLI, migration, and benchmark work outside this batch.

**Tech Stack:** Node.js CommonJS, yaml@2.8.0 CST/source tokens, Vitest, Prettier

---

## Authoritative Context

- Resume thread: `codex://threads/019f7357-b68a-71f3-9b43-ad8f554eee26`
- Original implementation thread: `codex://threads/019f6fca-e03d-7220-acb6-15e80afd953b`
- Source plan: `docs/superpowers/plans/2026-07-17-yaml-patch-general-requirement.md`, Task 8 only.
- Source specification: `docs/superpowers/specs/2026_07_17_yaml_patch_general_requirement_design.md`.
- Branch and baseline: `feat/yaml_patch_v2_general` at `6eb8308`.
- Tasks 1-7 are complete. Do not reimplement or amend them unless a Task 8 regression proves a specific defect.
- Task 8 implementation is committed as `6eb8308` (`feat: plan composable yaml transactions`). Its three focused test files currently pass 22/22 and all eight source/test files pass Prettier.
- Task 8 has not completed its specification review, code-quality review, or final regression gate. The commit alone does not prove those gates.

Committed Task 8 review unit:

```text
Modify: lib/yaml_patch/index.js
Create: lib/yaml_patch/diff.js
Create: lib/yaml_patch/manifest.js
Create: lib/yaml_patch/subtree_edit.js
Create: lib/yaml_patch/transaction.js
Create: test/yaml_patch_diff_manifest.test.js
Create: test/yaml_patch_subtree_edit.test.js
Create: test/yaml_patch_transaction.test.js
```

## Batch Boundary

This batch includes only:

- E-013 through E-019: complete subtree add/delete/copy/move and safe relocation boundaries.
- T-001 through T-009: ordered current-snapshot transactions, handles, declared participants, deterministic planning, and per-step validation.
- The Task 8 proof, preview, diff, manifest, replay-binding, limit, and public-library contracts needed to return a complete dry-run plan.
- Focused regression verification and, only when review finds defects, one narrowly scoped hardening commit.

This batch explicitly excludes:

- Task 9 multi-file locks, writes, durable journals, crash recovery, and recovery commands.
- Task 10 shared CLI/request dispatch, stdin, help, capabilities, glob expansion, and artifact output.
- Task 11 migration planning and resumable batches.
- Task 12 corpus, benchmarks, complete protocol documentation, and whole-spec acceptance audit.
- Any broad refactor that is not required to close a Critical or Important Task 8 defect.

---

### Task 1: Re-establish and preserve the committed Task 8 baseline

**Files:**

- Inspect: `lib/yaml_patch/index.js`
- Inspect: `lib/yaml_patch/diff.js`
- Inspect: `lib/yaml_patch/manifest.js`
- Inspect: `lib/yaml_patch/subtree_edit.js`
- Inspect: `lib/yaml_patch/transaction.js`
- Inspect: `test/yaml_patch_diff_manifest.test.js`
- Inspect: `test/yaml_patch_subtree_edit.test.js`
- Inspect: `test/yaml_patch_transaction.test.js`

- [ ] **Step 1: Confirm the baseline commit and exact dirty-file set**

  Run:

  ```bash
  git branch --show-current
  git rev-parse --short HEAD
  git status --short
  ```

  Expected: branch `feat/yaml_patch_v2_general`, commit `6eb8308`, and only this plan file is untracked. Preserve commit `6eb8308`; do not reset or reconstruct its Task 8 files.

- [ ] **Step 2: Re-run the focused Task 8 tests**

  Run:

  ```bash
  npx vitest run test/yaml_patch_subtree_edit.test.js test/yaml_patch_transaction.test.js test/yaml_patch_diff_manifest.test.js
  ```

  Expected: 3 files and 22 tests PASS. Any failure is a Task 8 blocker and must be investigated before review.

- [ ] **Step 3: Confirm the current files are formatted**

  Run:

  ```bash
  npx prettier --check lib/yaml_patch/index.js lib/yaml_patch/diff.js lib/yaml_patch/manifest.js lib/yaml_patch/subtree_edit.js lib/yaml_patch/transaction.js test/yaml_patch_diff_manifest.test.js test/yaml_patch_subtree_edit.test.js test/yaml_patch_transaction.test.js
  ```

  Expected: all matched files use Prettier code style.

---

### Task 2: Complete the Task 8 specification review

**Files:**

- Review: `docs/superpowers/specs/2026_07_17_yaml_patch_general_requirement_design.md`
- Review/Modify: `lib/yaml_patch/subtree_edit.js`
- Review/Modify: `lib/yaml_patch/transaction.js`
- Review/Modify: `lib/yaml_patch/diff.js`
- Review/Modify: `lib/yaml_patch/manifest.js`
- Review/Modify: `lib/yaml_patch/index.js`
- Review/Modify: `test/yaml_patch_subtree_edit.test.js`
- Review/Modify: `test/yaml_patch_transaction.test.js`
- Review/Modify: `test/yaml_patch_diff_manifest.test.js`

- [ ] **Step 1: Audit every in-scope requirement against direct code and test evidence**

  Use this matrix as the minimum review checklist:

  | Requirement | Required evidence                                                                                                                                 |
  | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
  | E-013       | Add, delete, copy, and move complete mapping/sequence subtrees within and across files.                                                           |
  | E-014-E-016 | Unknown descendants, tags, owned comments, separator comments, original child bytes, and indentation-only relocation are preserved exactly.       |
  | E-017-E-018 | Unsafe block scalars, flow collections, directives/tag handles, external aliases, and anchor collisions fail before either candidate is produced. |
  | E-019       | Delete behavior depends only on explicit selection and preconditions, with no business-policy guesses.                                            |
  | T-001-T-002 | Versioned multi-file requests apply operations in declaration order against the current candidate snapshot.                                       |
  | T-003-T-005 | Bind/result handles survive reorder and cross-file movement, resolve relative paths, and cannot escape one transaction.                           |
  | T-006       | Syntax, source ranges, and handles are checked after every operation; invalid intermediate candidates cannot reach the final result.              |
  | T-007       | Identical inputs yield byte-identical candidates, proofs, diffs, operation order, and reproducible manifest digests.                              |
  | T-008-T-009 | The complete participant set is validated before source loading, and no operation can read or write an undeclared YAML source.                    |

  A passing test name is not sufficient evidence. Trace each assertion through the production path it claims to verify.

- [ ] **Step 2: Close every confirmed specification gap with TDD**

  Add the smallest failing assertion to one of the three Task 8 test files, run that single file to observe RED, then make the minimum source change needed for GREEN. Do not weaken an error code, byte-preservation assertion, digest binding, or participant check to make a test pass.

- [ ] **Step 3: Re-run the complete Task 8 focused set**

  Run:

  ```bash
  npx vitest run test/yaml_patch_subtree_edit.test.js test/yaml_patch_transaction.test.js test/yaml_patch_diff_manifest.test.js
  ```

  Expected: all Task 8 tests PASS and the specification review reports no missing E-013-E-019 or T-001-T-009 behavior.

---

### Task 3: Complete the Task 8 code-quality review

**Files:**

- Review/Modify: the eight Task 8 source/test files listed in Task 1.

- [ ] **Step 1: Review the Task 8 diff for release-blocking defects**

  Inspect the complete `907b88d..6eb8308` diff and require all of the following:

  - Public APIs are exported from `lib/yaml_patch/index.js` and reuse existing errors, canonical digests, queries, profiles, range sets, and proof builders.
  - Request objects, operation objects, handles, participants, preconditions, and limits reject malformed or unknown fields with stable YAML Patch errors rather than raw `TypeError` values.
  - Source snapshots and locators remain digest-bound; no stale target can silently edit a same-shaped later snapshot.
  - A transaction performs no filesystem write, lock, rename, journal, or recovery action. Task 8 is planning/dry-run infrastructure only.
  - Final no-op normalization removes intermediate changes from file proofs and produces deterministic candidates, diffs, and manifest bindings.
  - Preview and manifest data are bounded, clone caller-owned input before canonicalization, and exclude runtime timestamps, random IDs, and absolute path differences from the reproducible digest.
  - Error paths do not leave one side of a cross-file move observable as a successful candidate.

- [ ] **Step 2: Fix only Critical and Important Task 8 findings**

  For each confirmed finding, add a focused failing regression test first, observe RED, implement the smallest correction, and observe GREEN. Record Minor findings for a later batch instead of expanding this plan.

- [ ] **Step 3: Run dependency and Task 7 regression tests**

  Run:

  ```bash
  npx vitest run \
    test/yaml_patch_addressable.test.js \
    test/yaml_patch_mapping_edit.test.js \
    test/yaml_patch_multi_range_proof.test.js \
    test/yaml_patch_operation_contract.test.js \
    test/yaml_patch_profile_reference.test.js \
    test/yaml_patch_profile_schema.test.js \
    test/yaml_patch_profile_validation.test.js \
    test/yaml_patch_protocol.test.js \
    test/yaml_patch_query_ast.test.js \
    test/yaml_patch_query_cursor.test.js \
    test/yaml_patch_query_range.test.js \
    test/yaml_patch_scalar_style.test.js \
    test/yaml_patch_sequence_edit.test.js \
    test/yaml_patch_source_parser.test.js \
    test/yaml_patch_subtree_edit.test.js \
    test/yaml_patch_transaction.test.js \
    test/yaml_patch_diff_manifest.test.js
  ```

  Expected: every listed test file PASS. This is deliberately focused; do not run the full repository test suite for this batch.

---

### Task 4: Verify and close the first batch

**Files:**

- Commit if modified: `lib/yaml_patch/index.js`
- Commit if modified: `lib/yaml_patch/diff.js`
- Commit if modified: `lib/yaml_patch/manifest.js`
- Commit if modified: `lib/yaml_patch/subtree_edit.js`
- Commit if modified: `lib/yaml_patch/transaction.js`
- Commit if modified: `test/yaml_patch_diff_manifest.test.js`
- Commit if modified: `test/yaml_patch_subtree_edit.test.js`
- Commit if modified: `test/yaml_patch_transaction.test.js`

- [ ] **Step 1: Perform final mechanical checks**

  Run:

  ```bash
  npx prettier --check lib/yaml_patch/index.js lib/yaml_patch/diff.js lib/yaml_patch/manifest.js lib/yaml_patch/subtree_edit.js lib/yaml_patch/transaction.js test/yaml_patch_diff_manifest.test.js test/yaml_patch_subtree_edit.test.js test/yaml_patch_transaction.test.js
  git diff --check
  git status --short
  ```

  Expected: formatting and whitespace checks pass. If review required fixes, the status contains no implementation files outside the eight-file Task 8 unit. If review found no defects, only this plan file remains untracked.

- [ ] **Step 2: Re-run the three Task 8 tests immediately before commit**

  Run:

  ```bash
  npx vitest run test/yaml_patch_subtree_edit.test.js test/yaml_patch_transaction.test.js test/yaml_patch_diff_manifest.test.js
  ```

  Expected: all Task 8 tests PASS with no skipped or todo tests.

- [ ] **Step 3: Commit only confirmed Task 8 review fixes**

  Run:

  ```bash
  git add lib/yaml_patch/index.js lib/yaml_patch/diff.js lib/yaml_patch/manifest.js lib/yaml_patch/subtree_edit.js lib/yaml_patch/transaction.js test/yaml_patch_diff_manifest.test.js test/yaml_patch_subtree_edit.test.js test/yaml_patch_transaction.test.js
  git commit -m "fix: harden yaml transaction planning"
  ```

  Run this step only when the reviews produced verified code or test fixes. Do not create an empty commit when `6eb8308` already passes both reviews. Do not stage Task 9-12 work or unrelated user changes.

- [ ] **Step 4: Stop at the batch boundary**

  Report baseline commit `6eb8308`, any follow-up fix commit, focused and regression test counts, specification-review verdict, quality-review verdict, and any deferred Minor findings. Do not begin multi-file writing or recovery in the same task.

## Completion Criteria

The first batch is complete only when:

- E-013-E-019 and T-001-T-009 have direct implementation and regression-test evidence.
- The specification review and code-quality review both pass.
- The focused Task 8 tests and the listed dependency regressions pass from the final worktree.
- Prettier and `git diff --check` pass.
- Commit `6eb8308` remains the Task 8 implementation baseline, and any confirmed review fixes are committed separately.
- Task 9-12 remain unstarted.
