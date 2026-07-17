# Lossless YAML Patch Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build the approved first-version lossless YAML patch core and `yamlpatch` CLI with exact-target extraction, full-candidate validation, byte-preservation proof, and guarded atomic writes.

**Architecture:** Add a focused CommonJS package under `lib/yaml_patch`, with stable plain-object boundaries between source reading, parser adaptation, node indexing/query, fragment packaging, patch validation/proof, and atomic writing. The CLI emits versioned JSON on stdout and diagnostics on stderr; all write paths reuse original buffers and replace exactly one proven byte range.

**Tech Stack:** Node.js, yaml@2.8.0, yargs, chalk, Vitest

---

### Task 1: Pin and enforce the parser contract

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `lib/yaml_patch/error.js`
- Create: `lib/yaml_patch/source.js`
- Create: `lib/yaml_patch/parser.js`
- Create: `test/yaml_patch_source_parser.test.js`

- [x] **Step 1: Write failing tests**

Cover exact parser version enforcement, fatal UTF-8 decoding, optional BOM handling, UTF-16-to-byte offsets for ASCII/CJK/emoji, multi-document parsing, normalized errors/warnings, and source digests.

- [x] **Step 2: Verify RED**

Run: `npx vitest run test/yaml_patch_source_parser.test.js`

Expected: FAIL because `lib/yaml_patch/source.js` and `parser.js` do not exist.

- [x] **Step 3: Implement the source and parser adapters**

Expose named functions returning plain objects. Use `TextDecoder("utf-8", { fatal: true })`, `YAML.parseAllDocuments()`, `keepSourceTokens`, and `LineCounter`; reject parser package versions other than `2.8.0` and normalize every parser diagnostic to a stable protocol shape.

- [x] **Step 4: Verify GREEN**

Run: `npx vitest run test/yaml_patch_source_parser.test.js`

Expected: PASS.

### Task 2: Index, query, and resolve exact edit ranges

**Files:**

- Create: `lib/yaml_patch/node_index.js`
- Create: `lib/yaml_patch/query.js`
- Create: `lib/yaml_patch/edit_range.js`
- Create: `test/yaml_patch_query_range.test.js`

- [x] **Step 1: Write failing tests**

Cover document index, node type, sequence index, mapping pair index plus key raw digest, unique string-key shorthand, raw scalar matching, source line/column/byte ranges, duplicate-key ambiguity, scalar-token limits, node-value ranges, mapping-value lookup, implicit values, flow/block collections, block scalars, anchors/tags, and unsupported edit units/shapes.

- [x] **Step 2: Verify RED**

Run: `npx vitest run test/yaml_patch_query_range.test.js`

Expected: FAIL because the index/query/range modules do not exist.

- [x] **Step 3: Implement minimal deterministic indexing and querying**

Traverse YAML nodes without semantic alias expansion, keep parser objects private to the index implementation, generate stable structural path steps, encode opaque locators, and require exactly one result for write-oriented lookup.

- [x] **Step 4: Implement edit-range contract checks**

Use `[node.range[0], node.range[1])` for `node-value`; use `[srcToken.offset, srcToken.offset + srcToken.source.length)` for supported scalar tokens; cross-check the source slice, node class, token type, UTF-16 boundaries, and excluded tag/anchor prefixes before returning a byte range.

- [x] **Step 5: Verify GREEN**

Run: `npx vitest run test/yaml_patch_query_range.test.js`

Expected: PASS.

### Task 3: Extract and compile a one-range patch

**Files:**

- Create: `lib/yaml_patch/fragment.js`
- Create: `lib/yaml_patch/patch.js`
- Create: `lib/yaml_patch/validate.js`
- Create: `lib/yaml_patch/proof.js`
- Create: `test/yaml_patch_fragment_patch.test.js`

- [x] **Step 1: Write failing tests**

Cover raw fragment extraction, manifest/context creation, no-op round trips, source/target conflict detection, same-node-class enforcement, full-candidate parsing, warning baselines, cross-boundary anchor/alias rejection, byte limits, outside-range proof, text diff, invalid fragment/result, and one-operation-only declarative patches.

- [x] **Step 2: Verify RED**

Run: `npx vitest run test/yaml_patch_fragment_patch.test.js`

Expected: FAIL because extraction and patch modules do not exist.

- [x] **Step 3: Implement extraction and candidate compilation**

Write `fragment.yaml`, `manifest.json`, and `context.json` with exclusive creation unless `refresh` is true. Build candidates only as `before + replacement + after`; treat the full candidate parse as authoritative and preserve the original target bytes for no-op edits.

- [x] **Step 4: Implement validation and proof**

Reject new parse errors/warnings, changed source/target digests, target class changes, aliases or anchors crossing the target boundary, unsupported custom-tag semantic operations, and byte-limit overflow. Return versioned proof entries with deleted/inserted/touched bytes and before/after unchanged-region digests.

- [x] **Step 5: Verify GREEN**

Run: `npx vitest run test/yaml_patch_fragment_patch.test.js`

Expected: PASS.

### Task 4: Add guarded atomic writing

**Files:**

- Create: `lib/yaml_patch/writer.js`
- Create: `test/yaml_patch_writer.test.js`

- [x] **Step 1: Write failing tests**

Cover exclusive cooperative locks, token-owned lock cleanup, stale-lock refusal, same-directory temporary files, file and directory fsync, mode preservation, symlink/multi-hard-link rejection, failure cleanup, final digest verification, and write-disabled platforms.

- [x] **Step 2: Verify RED**

Run: `npx vitest run test/yaml_patch_writer.test.js`

Expected: FAIL because the writer does not exist.

- [x] **Step 3: Implement the writer**

Acquire a `wx` lock, re-read and revalidate after locking, create a randomized `wx` temporary file in the source directory, preserve supported metadata, fsync, rename, fsync the directory where supported, verify the final digest, and remove only lock/temp files owned by the current operation.

- [x] **Step 4: Verify GREEN**

Run: `npx vitest run test/yaml_patch_writer.test.js`

Expected: PASS.

### Task 5: Expose the core and CLI protocol

**Files:**

- Create: `lib/yaml_patch/protocol.js`
- Create: `lib/yaml_patch/index.js`
- Create: `lib/yaml_patch/cli.js`
- Create: `bin/yamlpatch`
- Create: `test/yamlpatch_cli.test.js`

- [x] **Step 1: Write failing CLI tests**

Cover `inspect`, `find`, `extract`, `apply`, `patch`, `validate`, and `capabilities`; strict unknown options; help contents and examples; version-only output; debug stderr; quiet behavior; JSON-only stdout; glob inputs for read-only commands; extract refresh semantics; dry-run default; explicit `--write`; and stable error envelopes/exit codes.

- [x] **Step 2: Verify RED**

Run: `npx vitest run test/yamlpatch_cli.test.js`

Expected: FAIL because `bin/yamlpatch` does not exist.

- [x] **Step 3: Implement protocol and CLI orchestration**

Use `{ ok, protocol_version, result }` success envelopes and `{ ok: false, protocol_version, code, message, recoverable, next_action, details }` failures. Keep machine JSON uncolored on stdout, put optional colored diagnostics on stderr, and make all boolean options false except apply's inherent dry-run behavior.

- [x] **Step 4: Verify GREEN and focused regression**

Run: `npx vitest run test/yamlpatch_cli.test.js test/yaml_patch_source_parser.test.js test/yaml_patch_query_range.test.js test/yaml_patch_fragment_patch.test.js test/yaml_patch_writer.test.js`

Expected: PASS.

### Task 6: Final requirement and runtime verification

**Files:**

- Modify: none

- [x] **Step 1: Verify parser pin and package lock**

Run: `node -p "require('yaml/package.json').version"`

Expected: exactly `2.8.0`.

- [x] **Step 2: Verify CLI surface**

Run: `bin/yamlpatch --version && bin/yamlpatch --help`

Expected: version-only first line, followed by complete help with usage, description, options, edit-unit values, and examples.

- [x] **Step 3: Verify an extract/apply no-op and a dry-run scalar patch**

Use a temporary UTF-8 YAML fixture, compare source digests before/after no-op apply, then check that a scalar replacement reports a one-range proof while preserving bytes outside the target.

- [x] **Step 4: Re-read the approved design and audit coverage**

Confirm all 13 items in section 15 are implemented and every second-stage item is either rejected with a stable error or absent from the CLI.
