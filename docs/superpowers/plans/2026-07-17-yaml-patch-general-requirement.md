# YAML Patch General Requirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing lossless v1 engine with versioned general queries, declarative profiles, composable single/multi-file transactions, multi-range byte proofs, recoverable writes, migration batches, and reproducible resource benchmarks while preserving v1 behavior.

**Architecture:** Keep v1 modules and artifact readers compatible, then add v2 artifacts around a current-snapshot transaction planner. Every edit is compiled from CST/source ranges into ordered byte splices, every candidate is reparsed after each operation, and final files are proven against their original buffers. Optional profiles consume the same query engine and only return diagnostics; the CLI and library both call one request dispatcher. Multi-file writes use stable lock ordering and a durable journal, explicitly promising recoverability rather than simultaneous visibility.

**Tech Stack:** Node.js CommonJS, yaml@2.8.0 CST/source tokens, worker_threads, yargs, glob, Vitest

**Resolved design choices:**

- Artifact versions are independent constants. Existing query/operation/manifest/proof v1 readers remain available; new query, operation and transaction artifacts use v2 while profile, cursor, locator, structured diff, byte proof and journal begin at their own v1.
- Typed scalar comparison uses YAML 1.2 values exposed by yaml@2.8.0: string, integer, float, boolean and null. Custom-tagged scalars require raw predicates unless the profile explicitly declares their type.
- Cursor and locator digests prevent stale or mismatched use; they are integrity bindings, not authentication tokens.
- Stream virtual ranges cover the complete source including BOM. Document virtual ranges include directives and document markers. Mapping-pair ranges come from CST pair tokens and are rejected if the token/range relationship cannot be proven.
- Transaction handles are maintained by operation provenance and byte-range transforms. A handle that overlaps an unrelated destructive edit fails with `PRECONDITION_FAILED`; created and moved nodes receive explicit result ranges.
- A contiguous same-indent comment block immediately before an item belongs to that item only when no blank line separates it. Inline comments and comments inside the node range belong to the node. Separator comments divided by a blank line never move.
- Native regular expressions run only in the already bounded worker, with explicit pattern length, input length and worker time limits. Unicode/case folding and number ranges are separate explicit predicates.
- Dry-run JSON always embeds `text_diff`, versioned `structured_diff`, `semantic_summary`, validation and manifest data. The existing JSON-first CLI remains backward compatible; `--json` guarantees machine-only output rather than changing the default format.
- Multi-file commits can expose mixed versions during a crash. The journal guarantees idempotent convergence to all-original or all-candidate content, never simultaneous atomic visibility.

---

### Task 1: Versioned artifacts, diagnostics, canonical digests, and exit codes

**Requirements:** P-001, P-002, P-005, P-013, P-014, P-015, D-009

**Files:**

- Create: `lib/yaml_patch/artifact_version.js`
- Create: `lib/yaml_patch/schema.js`
- Create: `lib/yaml_patch/diagnostic.js`
- Modify: `lib/yaml_patch/error.js`
- Modify: `lib/yaml_patch/protocol.js`
- Modify: `lib/yaml_patch/index.js`
- Create: `test/yaml_patch_protocol.test.js`

- [ ] **Step 1: Write failing protocol tests**

  Test strict artifact version validation, stable canonical JSON independent of object insertion order, diagnostic fields, every required error-code category, and the exact exit mapping `0/2/3/4/5/6/7/70`. Assert that v1 envelopes remain readable.

  ```js
  expect(canonical_digest({ b: 2, a: 1 })).toBe(
    canonical_digest({ a: 1, b: 2 }),
  );
  expect(exit_code_for_error(new Yaml_patch_error("SOURCE_CHANGED", "x"))).toBe(3);
  expect(validate_artifact_version("query", 99)).toThrowError(
    expect.objectContaining({ code: "PROTOCOL_VERSION_UNSUPPORTED" }),
  );
  ```

- [ ] **Step 2: Verify RED**

  Run: `npx vitest run test/yaml_patch_protocol.test.js`

  Expected: FAIL because the artifact registry and canonical helpers do not exist.

- [ ] **Step 3: Implement the protocol foundation**

  Export these named APIs and reject every unknown schema field:

  ```js
  const ARTIFACT_VERSION = Object.freeze({
    envelope: [1, 2], query: [1, 2], operation: [1, 2], transaction: [1],
    profile: [1], manifest: [1, 2], proof: [1, 2], structured_diff: [1],
    cursor: [1], locator: [1, 2], journal: [1], migration: [1],
  });
  function validate_artifact_version(kind, version) {}
  function canonical_json(value) {}
  function canonical_digest(value) {}
  function assert_object(value, label) {}
  function assert_known_fields(value, fields, label) {}
  function create_diagnostic(input) {}
  function exit_code_for_error(error) {}
  ```

  Canonical JSON sorts object keys recursively, preserves array order, rejects non-finite numbers/undefined/functions/cycles, and is UTF-8 hashed with SHA-256. Keep `success_response()` and `error_response()` backward compatible while allowing an explicit envelope version.

- [ ] **Step 4: Verify GREEN and v1 protocol regression**

  Run: `npx vitest run test/yaml_patch_protocol.test.js test/yaml_patch_cli.test.js`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add lib/yaml_patch test/yaml_patch_protocol.test.js
  git commit -m "feat: add yaml patch artifact registry"
  ```

### Task 2: Complete addressable index metadata

**Requirements:** Q-001, Q-002, Q-003, Q-018

**Files:**

- Create: `lib/yaml_patch/addressable.js`
- Modify: `lib/yaml_patch/node_index.js`
- Modify: `lib/yaml_patch/validate.js`
- Create: `test/yaml_patch_addressable.test.js`

- [ ] **Step 1: Write failing addressability tests**

  Cover stream, document, mapping, mapping pair, key, value, sequence, sequence item, scalar and alias entries; scalar types that distinguish `1`, `1.0`, `true`, `null` and quoted strings; parent/sibling/depth/count metadata; complex mapping keys; and preserve-vs-target alias resolution with both locations.

  ```js
  const entries = build_addressable_index(index);
  expect(entries.map(({ addressable_type }) => addressable_type)).toContain("stream");
  expect(find_addressable(entries, "mapping_pair")[0]).toMatchObject({
    parent_path: [], sibling_position: 0,
  });
  expect(typed_scalar(index, quoted_one)).toEqual({ type: "string", value: "1" });
  ```

- [ ] **Step 2: Verify RED**

  Run: `npx vitest run test/yaml_patch_addressable.test.js`

  Expected: FAIL because `addressable.js` does not exist.

- [ ] **Step 3: Implement virtual addressables without changing v1 entry semantics**

  `build_addressable_index(index)` returns `{ entries, by_id, node_entry_by_id }`. Each entry has source path, document, structural path, addressable type, node type, scalar type/value when applicable, raw digest, parent path, sibling position, depth, direct child count, descendant count, source range and traversal ordinal. `encode_locator_v2()` binds locator version, source digest, document, path, type, byte range and target digest. Alias target resolution is opt-in and cycle/resource bounded.

- [ ] **Step 4: Verify GREEN and v1 range regression**

  Run: `npx vitest run test/yaml_patch_addressable.test.js test/yaml_patch_query_range.test.js`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add lib/yaml_patch/addressable.js lib/yaml_patch/node_index.js lib/yaml_patch/validate.js test/yaml_patch_addressable.test.js
  git commit -m "feat: index all yaml addressable objects"
  ```

### Task 3: Query v2 AST, selectors, projection, cardinality, and bound cursors

**Requirements:** Q-004 through Q-019, P-011

**Files:**

- Create: `lib/yaml_patch/query_v2.js`
- Create: `lib/yaml_patch/projection.js`
- Create: `lib/yaml_patch/query_cursor.js`
- Modify: `lib/yaml_patch/query.js`
- Modify: `lib/yaml_patch/isolated_worker.js`
- Create: `test/yaml_patch_query_ast.test.js`
- Create: `test/yaml_patch_query_cursor.test.js`

- [ ] **Step 1: Write failing AST tests**

  Cover explicit `all`/`any`/`not`; node/scalar types; typed equal/not/in; field exists/missing/value/type returning the carrier mapping; document/path/source positions; parent/ancestor/descendant/sibling; depth/child/descendant counts; raw text/digest; explicit regex/case-fold/Unicode normalization/number range limits; selectors; explicit projection and all `missing` policies.

  ```js
  const request = {
    version: 2,
    where: { all: [
      { predicate: "node_type", equals: "mapping" },
      { predicate: "field_value", field: "enabled", equals: { type: "boolean", value: true } },
    ] },
    select: { kind: "self" },
    projection: { fields: ["source_path", "path", "line", "column"], missing: "error" },
    expect_matches: { min: 1, max: 20 },
  };
  expect(run_query_v2(input_set, request).matches).toHaveLength(1);
  ```

- [ ] **Step 2: Write failing cursor/cardinality tests**

  Assert normalized path/document/start-byte/traversal ordering across files, exact/range expectations, bounded candidates, cursor continuation without duplicates, and `SOURCE_CHANGED`/`PRECONDITION_FAILED` when source digests or query/projection digests change. Assert write normalization defaults to `{ exact: 1, max: 1 }` and never picks the first match.

- [ ] **Step 3: Verify RED**

  Run: `npx vitest run test/yaml_patch_query_ast.test.js test/yaml_patch_query_cursor.test.js`

  Expected: FAIL because query v2 modules do not exist.

- [ ] **Step 4: Implement query, selection, projection and cursor contracts**

  Export:

  ```js
  function validate_query_v2(request) {}
  function evaluate_predicate(context, predicate, limits) {}
  function select_query_results(context, matches, selector) {}
  function project_query_results(context, matches, projection) {}
  function normalize_expect_matches(value, mode) {}
  function assert_match_expectation(matches, expectation, projection) {}
  function run_query_v2(input_set, request, options = {}) {}
  function create_query_cursor(input_digests, request_digest, offset) {}
  function decode_query_cursor(cursor, input_digests, request_digest) {}
  ```

  Regex is disabled unless predicate type is `regex`; enforce maximum pattern/input lengths and run inside the bounded worker. Candidate diagnostics include core positions, ancestor paths, explicit projections, truncation and next cursor.

- [ ] **Step 5: Verify GREEN and v1 query regression**

  Run: `npx vitest run test/yaml_patch_query_ast.test.js test/yaml_patch_query_cursor.test.js test/yaml_patch_query_range.test.js`

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add lib/yaml_patch test/yaml_patch_query_ast.test.js test/yaml_patch_query_cursor.test.js
  git commit -m "feat: add composable yaml query protocol"
  ```

### Task 4: Profile schema, scope, fields, identity, aliases, and protection

**Requirements:** V-004 through V-010, V-014, E-020, T-015

**Files:**

- Create: `lib/yaml_patch/profile.js`
- Create: `lib/yaml_patch/profile_validate.js`
- Create: `lib/yaml_patch/validation_scope.js`
- Create: `test/yaml_patch_profile_schema.test.js`
- Create: `test/yaml_patch_profile_validation.test.js`

- [ ] **Step 1: Write failing strict profile tests**

  Cover YAML and JSON profile parsing, version/unknown-field rejection, include/ignore globs with literal special-character paths, node sets backed by query v2, allowed/required/optional fields, types, cardinality, consistent field types, child-set types, simple/composite identity scopes and null/missing policies, existing identity immutability, protected actions, field order, aliases and diagnostic projection.

  ```js
  const profile = load_profile(Buffer.from(`
  version: 1
  node_sets:
    record:
      query: { version: 2, where: { predicate: node_type, equals: mapping } }
  identity:
    - rule_id: record_key
      node_set: record
      fields: [tenant, key]
      unique_scope: input
      immutable_existing: true
  `));
  expect(validate_profile(profile).diagnostics).toEqual([]);
  ```

- [ ] **Step 2: Verify RED**

  Run: `npx vitest run test/yaml_patch_profile_schema.test.js test/yaml_patch_profile_validation.test.js`

  Expected: FAIL because the profile modules do not exist.

- [ ] **Step 3: Implement strict declarative profile validation**

  Profile callbacks are not executable. Core validation receives `{ original_inputs, candidate_inputs, operation_provenance, scope }`, returns diagnostics only, and never mutates buffers. Identity comparison uses operation provenance so moves preserve identity while modifications/deletions/copies are distinguished. Each diagnostic is built through `create_diagnostic()` and contains error code, severity, rule ID, file, document, line/column, path, violation and suggested action.

- [ ] **Step 4: Verify GREEN**

  Run: `npx vitest run test/yaml_patch_profile_schema.test.js test/yaml_patch_profile_validation.test.js`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add lib/yaml_patch/profile.js lib/yaml_patch/profile_validate.js lib/yaml_patch/validation_scope.js test/yaml_patch_profile_schema.test.js test/yaml_patch_profile_validation.test.js
  git commit -m "feat: add declarative yaml validation profiles"
  ```

### Task 5: Profile references, cycles, and validation scopes

**Requirements:** V-011 through V-017, E-021

**Files:**

- Modify: `lib/yaml_patch/profile.js`
- Modify: `lib/yaml_patch/profile_validate.js`
- Modify: `lib/yaml_patch/validation_scope.js`
- Modify: `lib/yaml_patch/validate.js`
- Create: `test/yaml_patch_profile_reference.test.js`

- [ ] **Step 1: Write failing reference and scope tests**

  Cover scalar/list references, target identities, null policies, duplicate reference values, missing/non-unique targets, type mismatches, graph cycles with readable edge paths, full input/specified file/changed node/changed file/reference closure scopes, fallback to full validation when closure is uncertain, and explicit reporting of unvalidated scope.

- [ ] **Step 2: Verify RED**

  Run: `npx vitest run test/yaml_patch_profile_reference.test.js`

  Expected: FAIL because reference and graph rules are not accepted.

- [ ] **Step 3: Implement reference indices and bounded graph validation**

  Build identity indices before resolving references. Each reference edge records source/target projections and the field source location. Tarjan SCC or iterative DFS must obey independent node/edge/time limits; return `CYCLE_DETECTED` with an ordered cycle path. Deletion of anchors or profile targets is rejected unless operation provenance proves every dependent alias/reference is updated within the same final candidate.

- [ ] **Step 4: Verify GREEN and generic core regression**

  Run: `npx vitest run test/yaml_patch_profile_reference.test.js test/yaml_patch_fragment_patch.test.js`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add lib/yaml_patch test/yaml_patch_profile_reference.test.js
  git commit -m "feat: validate yaml references and graph rules"
  ```

### Task 6: Multi-range splice engine and versioned byte proofs

**Requirements:** L-001 through L-008, T-002, T-006, T-007

**Files:**

- Create: `lib/yaml_patch/range_set.js`
- Modify: `lib/yaml_patch/proof.js`
- Create: `test/yaml_patch_multi_range_proof.test.js`

- [ ] **Step 1: Write failing splice/proof tests**

  Cover ordered disjoint replacements, inserts and deletes; adjacent ranges; overlap/crossing/ambiguous same-offset rejection; multiple unchanged regions; UTF-8/BOM/mixed newline preservation; no-op normalization; per-file proof; transaction digest binding file proofs and operation order; and deliberate out-of-range candidate mutation.

  ```js
  const result = apply_range_set(original, [
    { start_byte: 2, end_byte: 3, replacement_buffer: Buffer.from("X"), operation_id: "a" },
    { start_byte: 7, end_byte: 7, replacement_buffer: Buffer.from("Y"), operation_id: "b" },
  ]);
  expect(result.proof.unchanged_regions).toHaveLength(3);
  expect(result.proof.verified).toBe(true);
  ```

- [ ] **Step 2: Verify RED**

  Run: `npx vitest run test/yaml_patch_multi_range_proof.test.js`

  Expected: FAIL because `range_set.js` does not exist.

- [ ] **Step 3: Implement a piece-table-backed splice set**

  Export `create_piece_table()`, `apply_snapshot_splices()`, `materialize_piece_table()`, `original_ranges_from_pieces()`, `create_multi_range_byte_proof()` and `create_transaction_proof()`. Snapshot splices use current candidate coordinates; the piece table retains original source slices so final proof can derive original/candidate ranges and hash every untouched gap. Same-offset insertions require explicit operation order; other overlaps fail before candidate generation.

- [ ] **Step 4: Verify GREEN and v1 proof regression**

  Run: `npx vitest run test/yaml_patch_multi_range_proof.test.js test/yaml_patch_fragment_patch.test.js`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add lib/yaml_patch/range_set.js lib/yaml_patch/proof.js test/yaml_patch_multi_range_proof.test.js
  git commit -m "feat: prove multi-range yaml edits"
  ```

### Task 7: Scalar, mapping, and sequence structural edit compilers

**Requirements:** E-001 through E-012

**Files:**

- Create: `lib/yaml_patch/operation.js`
- Create: `lib/yaml_patch/scalar_edit.js`
- Create: `lib/yaml_patch/mapping_edit.js`
- Create: `lib/yaml_patch/sequence_edit.js`
- Create: `lib/yaml_patch/layout.js`
- Create: `test/yaml_patch_scalar_style.test.js`
- Create: `test/yaml_patch_mapping_edit.test.js`
- Create: `test/yaml_patch_sequence_edit.test.js`

- [ ] **Step 1: Write failing scalar-style tests**

  Cover raw YAML replacement, typed equality no-op, plain/single/double/`|`/`|-`/`>` style preservation, block chomping/indent indicators, explicit style changes, and refusal when the requested value cannot be represented safely in the old style.

- [ ] **Step 2: Write failing mapping and sequence tests**

  Cover mapping add/set/delete/rename/move/reorder with prepend/append/index/before/after and complex pair locators; sequence prepend/append/insert/delete/swap/reorder/move; append unique/delete one/delete all/duplicate checks with typed equality; current-snapshot indices; negative/out-of-range failures; and preservation of all untouched item bytes.

- [ ] **Step 3: Verify RED**

  Run: `npx vitest run test/yaml_patch_scalar_style.test.js test/yaml_patch_mapping_edit.test.js test/yaml_patch_sequence_edit.test.js`

  Expected: FAIL because structural edit compilers do not exist.

- [ ] **Step 4: Implement source-slice edit primitives**

  Every compiler has the same interface:

  ```js
  function compile_operation(context, target, operation) {
    return {
      splices: [],
      result_range: null,
      provenance: { operation_id: operation.id, type: operation.type },
      semantic_change: {},
    };
  }
  ```

  Existing bytes come only from source slices. `YAML.stringify` may encode an explicitly supplied new scalar/key/subtree but never reconstruct an existing mapping/sequence. Explicit positions override profile order; otherwise profile order applies; otherwise append is the stable default. Flow collections and CST shapes without provable delimiters return `UNSUPPORTED_EDIT_SHAPE`.

- [ ] **Step 5: Verify GREEN**

  Run: `npx vitest run test/yaml_patch_scalar_style.test.js test/yaml_patch_mapping_edit.test.js test/yaml_patch_sequence_edit.test.js test/yaml_patch_query_range.test.js`

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add lib/yaml_patch test/yaml_patch_scalar_style.test.js test/yaml_patch_mapping_edit.test.js test/yaml_patch_sequence_edit.test.js
  git commit -m "feat: add general yaml structural edits"
  ```

### Task 8: Subtree copy/move and transaction handles

**Requirements:** E-013 through E-019, T-001 through T-009

**Files:**

- Create: `lib/yaml_patch/subtree_edit.js`
- Create: `lib/yaml_patch/transaction.js`
- Create: `lib/yaml_patch/manifest.js`
- Create: `lib/yaml_patch/diff.js`
- Create: `test/yaml_patch_subtree_edit.test.js`
- Create: `test/yaml_patch_transaction.test.js`
- Create: `test/yaml_patch_diff_manifest.test.js`

- [ ] **Step 1: Write failing subtree tests**

  Move/copy full mappings and sequence items with unknown fields, descendants, tags and owned comments within/across files. Assert internal bytes only change by structural prefix indentation. Assert separator comments remain, and unsafe block scalars, directives, flow collections, tag handles, external aliases or duplicate anchors fail with the required stable code.

- [ ] **Step 2: Write failing ordered transaction and handle tests**

  Cover current-snapshot selectors, bind-before-edit, result handles for create/copy/move, handles surviving reorder/cross-file move, transaction-only lifetime, per-operation syntax/range/handle validation, declared file-set enforcement, deterministic candidates/diffs/proofs, transaction/file/operation preconditions, and every file/operation/node/range/byte/identity change limit.

- [ ] **Step 3: Write failing preview/manifest tests**

  Assert text diff, structured JSON diff and semantic summary contain operation, locators/handles, original/candidate ranges, typed before/after, byte counts and no-op. Assert manifest has separate `request` and `result`, canonical ordering, validation/proof data, profile/capability digests, replay conflicts, and no random/time/path fields in its reproducible digest.

- [ ] **Step 4: Verify RED**

  Run: `npx vitest run test/yaml_patch_subtree_edit.test.js test/yaml_patch_transaction.test.js test/yaml_patch_diff_manifest.test.js`

  Expected: FAIL because the transaction planner does not exist.

- [ ] **Step 5: Implement the transaction planner**

  `plan_transaction(request, options)` validates the complete participant set before loading files, creates one piece table/index per file, applies operations in declaration order, reparses and validates after each operation, transforms live handle ranges, runs final profile validation, enforces limits with the same algorithm for dry-run/write, and returns candidates plus proofs/diffs/manifest. A final byte-identical transaction is a successful no-op even if intermediate snapshots changed.

- [ ] **Step 6: Verify GREEN**

  Run: `npx vitest run test/yaml_patch_subtree_edit.test.js test/yaml_patch_transaction.test.js test/yaml_patch_diff_manifest.test.js`

  Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add lib/yaml_patch test/yaml_patch_subtree_edit.test.js test/yaml_patch_transaction.test.js test/yaml_patch_diff_manifest.test.js
  git commit -m "feat: plan composable yaml transactions"
  ```

### Task 9: Stable multi-file locking, durable journal, and recovery

**Requirements:** W-001 through W-014, L-006, L-007

**Files:**

- Modify: `lib/yaml_patch/writer.js`
- Create: `lib/yaml_patch/transaction_log.js`
- Create: `lib/yaml_patch/transaction_writer.js`
- Create: `lib/yaml_patch/recovery.js`
- Create: `test/yaml_patch_transaction_writer.test.js`
- Create: `test/yaml_patch_recovery.test.js`

- [ ] **Step 1: Write failing no-op and capability tests**

  Assert no-op write obtains no lock and creates no temp/journal, and unsupported directory fsync/metadata/atomic rename capability fails before any rename while dry-run remains available.

- [ ] **Step 2: Write failing failure-injection and recovery tests**

  Cover normalized-realpath lock order, all-lock revalidation, prepare failure leaving all sources intact, journal fsync before first rename, every required state, failure/crash at each state/file, automatic rollback or commit completion, `RECOVERY_REQUIRED` details, status inspection, idempotent explicit recovery, and refusal on digest/identity mismatch.

- [ ] **Step 3: Verify RED**

  Run: `npx vitest run test/yaml_patch_transaction_writer.test.js test/yaml_patch_recovery.test.js`

  Expected: FAIL because multi-file writer modules do not exist and v1 no-op still locks.

- [ ] **Step 4: Implement two-phase recoverable commit**

  The state machine is `planned -> prepared -> committing -> committed` and `committing -> rolling_back -> rolled_back`, with any irreconcilable state becoming `recovery_required`. Acquire every token-owned lock in stable realpath order; under all locks reread and re-plan; prepare same-directory candidate and recovery files with metadata/fsync; persist/fsync journal; rename in journal order while persisting per-file progress; clean artifacts only after terminal consistency. Recovery accepts an explicit `commit` or `rollback` direction and is idempotent.

- [ ] **Step 5: Verify GREEN plus v1 writer regression**

  Run: `npx vitest run test/yaml_patch_transaction_writer.test.js test/yaml_patch_recovery.test.js test/yaml_patch_writer.test.js`

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add lib/yaml_patch test/yaml_patch_transaction_writer.test.js test/yaml_patch_recovery.test.js
  git commit -m "feat: add recoverable multi-file yaml writes"
  ```

### Task 10: Shared library/CLI request path, stdin, artifacts, and capabilities

**Requirements:** P-003 through P-012, P-014, P-015, D-001 through D-008

**Files:**

- Create: `lib/yaml_patch/request.js`
- Create: `lib/yaml_patch/request_input.js`
- Create: `lib/yaml_patch/capability.js`
- Modify: `lib/yaml_patch/cli.js`
- Modify: `lib/yaml_patch/isolated_worker.js`
- Modify: `lib/yaml_patch/index.js`
- Modify: `test/yaml_patch_cli.test.js`
- Create: `test/yaml_patch_request.test.js`

- [ ] **Step 1: Write failing request/CLI tests**

  Cover query v2 and transaction commands, `--query -`, `--operations -`, rejection of two stdin consumers, `--profile`, `--manifest`, `--refresh`, transaction status/recover/replay, named saved queries, exact exit codes, artifact self-exclusion from globs, JSON-only stdout, complete debug stage/IO stderr, quiet warnings/errors, and library/CLI response equality.

- [ ] **Step 2: Verify RED**

  Run: `npx vitest run test/yaml_patch_request.test.js test/yaml_patch_cli.test.js`

  Expected: FAIL because CLI has no v2 request dispatcher or stdin reader.

- [ ] **Step 3: Implement one top-level request dispatcher**

  Export `execute_request(request, options)` returning the same versioned success/error objects serialized by the CLI. `read_request_input()` reads a bounded UTF-8 JSON file or stdin exactly once. Capabilities list every artifact version, operation/edit unit/profile rule, resource default, writer guarantee, journal/recovery ability and unsupported platform guarantee. Generated artifacts use exclusive create; `refresh` only replaces a validated same-kind/version artifact.

- [ ] **Step 4: Complete help text**

  Include Usage, Description, Commands, every option and enum value, default-false booleans, and commented examples for literal/glob query, stdin, dry-run transaction, write, manifest replay, status and recovery.

- [ ] **Step 5: Verify GREEN**

  Run: `npx vitest run test/yaml_patch_request.test.js test/yaml_patch_cli.test.js test/yaml_patch_isolated.test.js`

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add lib/yaml_patch test/yaml_patch_request.test.js test/yaml_patch_cli.test.js
  git commit -m "feat: expose yaml patch v2 request protocol"
  ```

### Task 11: Migration planning and resumable batches

**Requirements:** M-001 through M-007

**Files:**

- Create: `lib/yaml_patch/migration.js`
- Create: `test/yaml_patch_migration.test.js`
- Modify: `lib/yaml_patch/request.js`
- Modify: `lib/yaml_patch/capability.js`
- Modify: `lib/yaml_patch/cli.js`

- [ ] **Step 1: Write failing migration tests**

  Cover key alias normalization, typed conversion, wrap/unwrap, child-key normalization and node move compiled exclusively to query v2 plus transaction operations; scan-only default reports; stable file/node/byte batches; batch manifests; retry/rollback/continue/replan; repeated no-op; global validation; and source/profile conflicts preventing blind resume.

- [ ] **Step 2: Verify RED**

  Run: `npx vitest run test/yaml_patch_migration.test.js`

  Expected: FAIL because migration planning does not exist.

- [ ] **Step 3: Implement migration as a transaction compiler**

  Export `plan_migration()`, `partition_migration_batches()`, `execute_migration_batch()` and `resume_migration()`. No migration executor edits YAML directly: every batch contains ordinary v2 queries/operations, declared file digests, profile digest, limits and a manifest. Intermediate invalid global state is explicitly recorded as migration state and rejected by normal transaction mode.

- [ ] **Step 4: Verify GREEN**

  Run: `npx vitest run test/yaml_patch_migration.test.js test/yaml_patch_transaction.test.js`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add lib/yaml_patch/migration.js lib/yaml_patch/request.js lib/yaml_patch/capability.js lib/yaml_patch/cli.js test/yaml_patch_migration.test.js
  git commit -m "feat: add resumable yaml migrations"
  ```

### Task 12: Resource corpus, benchmarks, protocol documentation, and acceptance

**Requirements:** R-001 through R-008, V-001, V-002, all section 15 scenarios, section 17 completion criteria

**Files:**

- Create: `benchmark/yaml_patch/generate_fixture.js`
- Create: `benchmark/yaml_patch/run_benchmark.js`
- Create: `benchmark/yaml_patch/reference_result.json`
- Create: `test/fixture/yaml_patch/README.md`
- Create: `test/yaml_patch_resource.test.js`
- Create: `test/yaml_patch_yaml_corpus.test.js`
- Create: `docs/yaml_patch_protocol_v2.md`
- Modify: `package.json`

- [x] **Step 1: Write failing resource and corpus tests**

  Cover fatal limits for bytes/nodes/depth/results/output/regex/graph/time/memory; CJK/Japanese/combining characters/emoji; BOM; LF/CRLF/CR/mixed/no final newline; every scalar style; flow collections; multi-document; comments; directives; custom tags; anchors/aliases; literal/glob paths with spaces/brackets/wildcards/non-ASCII; and 10x-scale graceful completion or limit error.

- [x] **Step 2: Verify RED**

  Run: `npx vitest run test/yaml_patch_resource.test.js test/yaml_patch_yaml_corpus.test.js`

  Expected: FAIL until independent regex/graph/output limits and the corpus generator are wired.

- [x] **Step 3: Implement deterministic benchmark generation and runner**

  Generate at least 14 baseline files, 64,000 syntax nodes, one 2 MiB/30,000-node file, and a growth set with at least 10x nodes and bytes. The runner records CPU, memory, storage description, OS, Node, parser/tool versions, cold/warm mode, samples and p50/p95. Exit nonzero on incorrect results, unbounded output, crash, or an unexplained >20% regression against a comparable reference environment; use relative-only reporting on different hardware.

- [x] **Step 4: Document every v2 artifact and CLI example**

  The protocol document includes strict JSON examples for query, projection, cursor, locator, profile, transaction, operation, manifest, proof, diff, journal, migration and error/exit mappings. It states unsupported edit shapes and platform writer guarantees without claiming simultaneous multi-file visibility.

- [x] **Step 5: Verify focused corpus, benchmark, v1 regression, and all yaml_patch tests**

  Run:

  ```bash
  npx vitest run test/yaml_patch_resource.test.js test/yaml_patch_yaml_corpus.test.js
  node benchmark/yaml_patch/run_benchmark.js --output benchmark/yaml_patch/reference_result.json
  npx vitest run test/yaml_patch_source_parser.test.js test/yaml_patch_query_range.test.js test/yaml_patch_fragment_patch.test.js test/yaml_patch_writer.test.js test/yaml_patch_cli.test.js test/yaml_patch_isolated.test.js
  npx vitest run test/yaml_patch_*.test.js
  ```

  Expected: all tests PASS; benchmark emits bounded JSON with both scales and environment metadata.

- [x] **Step 6: Audit every normative requirement**

  Re-read `docs/superpowers/specs/2026_07_17_yaml_patch_general_requirement_design.md` and map Q/E/T/L/W/V/D/P/M/R IDs to code, focused tests and protocol documentation. The audit fails if any platform-independent P0 ID or section 15 scenario lacks all three.

  Audit record: `docs/superpowers/progress/2026_07_19_yaml_patch_v2_acceptance_audit.md`

- [x] **Step 7: Commit**

  ```bash
  git add benchmark/yaml_patch test/yaml_patch_resource.test.js test/yaml_patch_yaml_corpus.test.js test/fixture/yaml_patch docs/yaml_patch_protocol_v2.md package.json docs/superpowers/specs/2026_07_17_yaml_patch_general_requirement_design.md docs/superpowers/plans/2026-07-17-yaml-patch-general-requirement.md
  git commit -m "docs: complete yaml patch v2 acceptance"
  ```

