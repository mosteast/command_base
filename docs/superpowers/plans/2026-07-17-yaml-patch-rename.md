# YAML Patch Snake-Case Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename every unpublished command, protocol, artifact, documentation, and test identifier from the legacy unseparated spelling to `yaml_patch` without a compatibility alias.

**Architecture:** Keep the existing `lib/yaml_patch` module layout and protocol version. Change only naming surfaces: first update tests to establish the new contract, then rename the executable and replace public/protocol/filesystem identifiers, and finally prove that the legacy unseparated spelling is absent.

**Tech Stack:** Node.js, CommonJS, yargs, Vitest

---

### Task 1: Establish the new naming contract in tests

**Files:**

- Move: the legacy CLI test entry to `test/yaml_patch_cli.test.js`
- Modify: `test/yaml_patch_cli.test.js`
- Modify: `test/yaml_patch_fragment_patch.test.js`
- Modify: `test/yaml_patch_writer.test.js`

- [x] **Step 1: Rename the CLI test and update expected public names**

Change the executable path and package assertion to:

```js
const cli_path = path.resolve(__dirname, "../bin/yaml_patch");

expect(package_json.bin).toEqual({ yaml_patch: "bin/yaml_patch" });
```

Update CLI suite labels, temporary paths, lock paths, protocol format assertions,
and byte-proof assertions so every engine-owned identifier uses the
`yaml_patch` prefix.

- [x] **Step 2: Run the renamed test to verify RED**

Run:

```bash
npx vitest run test/yaml_patch_cli.test.js test/yaml_patch_fragment_patch.test.js test/yaml_patch_writer.test.js
```

Expected: FAIL because `bin/yaml_patch` and the new bin/protocol/artifact names do not exist yet.

### Task 2: Rename implementation and documentation surfaces

**Files:**

- Move: the legacy CLI entry to `bin/yaml_patch`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `lib/yaml_patch/cli.js`
- Modify: `lib/yaml_patch/fragment.js`
- Modify: `lib/yaml_patch/lock.js`
- Modify: `lib/yaml_patch/proof.js`
- Modify: `lib/yaml_patch/writer.js`
- Modify: `docs/superpowers/plans/2026-07-17-lossless-yaml-patch-engine.md`
- Modify: `docs/superpowers/specs/2026-07-17-yaml-patch-rename-design.md`
- Modify: `tmp/2026-07-16-lossless-yaml-patch-engine-design.md`

- [x] **Step 1: Rename the executable and package bin**

Use this package mapping:

```json
"bin": {
  "yaml_patch": "bin/yaml_patch"
}
```

Preserve executable mode on `bin/yaml_patch` and remove the legacy entry.

- [x] **Step 2: Rename protocol and filesystem identifiers**

Use these exact values:

```text
yaml_patch-edit
yaml_patch-context
yaml_patch-byte-proof
.yaml_patch.lock
.yaml_patch-extract.lock
.yaml_patch-session-
.yaml_patch-backup-
.yaml_patch-lock-pending-
```

Change `SCRIPT_NAME` to `yaml_patch` and update diagnostic strings and help
examples. Do not add a legacy alias or compatibility parser.

- [x] **Step 3: Synchronize documentation and the ignored lockfile**

Update command examples, plan file references, and the approved design source.
Run:

```bash
npm install --package-lock-only --ignore-scripts
```

Expected: root package metadata records `yaml_patch`; no dependency versions change.

- [x] **Step 4: Run focused tests to verify GREEN**

Run:

```bash
npx vitest run test/yaml_patch_cli.test.js test/yaml_patch_fragment_patch.test.js test/yaml_patch_writer.test.js
```

Expected: PASS.

### Task 3: Verify the clean-break rename

**Files:**

- Modify: `docs/superpowers/plans/2026-07-17-yaml-patch-rename.md`

- [x] **Step 1: Prove the old spelling is absent**

Run:

```bash
rg -n -i "yaml""patch" package.json package-lock.json bin lib test docs tmp
```

Expected: no matches.

- [x] **Step 2: Verify CLI, package, formatting, and regressions**

Run:

```bash
bin/yaml_patch --version
bin/yaml_patch --help
npx prettier --check package.json bin/yaml_patch lib/yaml_patch test/yaml_patch_*.test.js docs/superpowers
npx vitest run test/yaml_patch_source_parser.test.js test/yaml_patch_query_range.test.js test/yaml_patch_fragment_patch.test.js test/yaml_patch_writer.test.js test/yaml_patch_isolated.test.js test/yaml_patch_cli.test.js test/tree_leaf_extract.test.js
npm pack --dry-run --json
```

Expected: version-only output; help names `yaml_patch`; formatting passes; 91
tests pass; package output contains `bin/yaml_patch` and not the former entry.

- [x] **Step 3: Mark this plan complete**

Replace every remaining unchecked box in this plan with `[x]` after all
verification commands succeed.
