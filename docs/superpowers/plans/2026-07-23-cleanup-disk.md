# cleanup_disk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `bin/cleanup_disk` — a rule-driven macOS disk cleanup orchestrator with `report`, `discover`, and safe `clean` (mutation only with `--yes`).

**Architecture:** Node.js library under `lib/cleanup_disk/` owns config merge, filtering, path guards, target resolution, discover heuristics, and CLI dispatch. `bin/cleanup_disk` is a thin executable entry. Defaults live in `config/cleanup_disk/defaults.yaml`; optional `local.yaml` is gitignored. Trash reuses `lib/file/trash.js`. Delegate rules spawn `cleanup_dev_cache` read-only.

**Tech Stack:** Node.js, `yaml` (already in package.json), Vitest, `gdu-go`/`mdfind`/`du` for discover, existing `lib/file/trash.js`

## Global Constraints

- Naming: snake_case files/vars; Cap_snake_case for types if introduced.
- CLI must support `-h/--help`, `-v/--version` (version only), `--debug`, `--quiet`, `-d/--dry-run`; unknown options fail.
- All booleans default false; `--yes` required for real clean mutation.
- `action: report` rules are never mutated by `clean`.
- Default `clean` risk ceiling is `low` only.
- v1 discover never writes config (no `--apply`).
- Do not replace `cleanup_xcode` / `cleanup_dev_cache`.
- macOS Trash only via `lib/file/trash.js` (respect `COMMAND_BASE_TRASH_DIR` in tests).
- Prefer singular option names (`--min-size`, `--rule`, `--kind`, `--risk`).

## File structure

| Path | Responsibility |
|------|----------------|
| `config/cleanup_disk/defaults.yaml` | Shipped default rules |
| `config/cleanup_disk/local.yaml` | Optional local overrides (gitignored; not created by default) |
| `lib/cleanup_disk/size.js` | Parse/format size strings (`100M`, `1G`) ↔ bytes |
| `lib/cleanup_disk/path_guard.js` | Reject dangerous paths |
| `lib/cleanup_disk/config.js` | Load/merge YAML rules by `id` |
| `lib/cleanup_disk/filter.js` | Filter by enabled / rule / kind / risk ceiling |
| `lib/cleanup_disk/resolve_target.js` | Expand `~`, glob, size, min_size/min_age |
| `lib/cleanup_disk/discover.js` | Hotspot scan + suggested YAML snippets |
| `lib/cleanup_disk/clean.js` | Plan/execute trash, delete, delegate |
| `lib/cleanup_disk/cli.js` | Arg parse, help, subcommand dispatch |
| `bin/cleanup_disk` | `#!/usr/bin/env node` → `cli.main` |
| `test/cleanup_disk_*.test.js` | Unit + CLI tests |
| `.gitignore` | Ignore `config/cleanup_disk/local.yaml` |

---

### Task 1: Size helpers + path guards

**Files:**
- Create: `lib/cleanup_disk/size.js`
- Create: `lib/cleanup_disk/path_guard.js`
- Create: `test/cleanup_disk_size.test.js`
- Create: `test/cleanup_disk_path_guard.test.js`

**Interfaces:**
- Produces: `parse_size(text) → number`, `format_size(bytes) → string`, `is_dangerous_path(resolved_path, { home }) → boolean`, `assert_safe_path(resolved_path, { home }) → void` (throws)

- [ ] **Step 1: Write failing tests**

```js
// test/cleanup_disk_size.test.js
import { describe, expect, it } from "vitest";
import { parse_size, format_size } from "../lib/cleanup_disk/size.js";

describe("cleanup_disk size", () => {
  it("parses binary-ish size suffixes", () => {
    expect(parse_size("100M")).toBe(100 * 1024 * 1024);
    expect(parse_size("1G")).toBe(1024 * 1024 * 1024);
    expect(parse_size("512")).toBe(512);
  });

  it("rejects invalid sizes", () => {
    expect(() => parse_size("nope")).toThrow(/invalid size/i);
  });
});

// test/cleanup_disk_path_guard.test.js
import { describe, expect, it } from "vitest";
import { is_dangerous_path } from "../lib/cleanup_disk/path_guard.js";

describe("cleanup_disk path_guard", () => {
  const home = "/Users/hailang";
  it("rejects home, /Users, /", () => {
    expect(is_dangerous_path("/", { home })).toBe(true);
    expect(is_dangerous_path("/Users", { home })).toBe(true);
    expect(is_dangerous_path(home, { home })).toBe(true);
    expect(is_dangerous_path("/private/var/folders", { home })).toBe(true);
  });

  it("allows nested cache paths", () => {
    expect(
      is_dangerous_path(`${home}/Library/Caches/JetBrains`, { home }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx vitest run test/cleanup_disk_size.test.js test/cleanup_disk_path_guard.test.js`  
Expected: FAIL (modules missing)

- [ ] **Step 3: Implement**

```js
// lib/cleanup_disk/size.js
"use strict";

function parse_size(text) {
  const raw = String(text).trim();
  const match = /^(\d+(?:\.\d+)?)\s*([kmgtpe]?)$/i.exec(raw);
  if (!match) throw new Error(`Invalid size: ${text}`);
  const value = Number(match[1]);
  const unit = (match[2] || "").toUpperCase();
  const mult = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5, E: 1024 ** 6 };
  if (!(unit in mult)) throw new Error(`Invalid size: ${text}`);
  return Math.floor(value * mult[unit]);
}

function format_size(bytes) {
  const n = Number(bytes) || 0;
  const units = ["B", "K", "M", "G", "T"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = i === 0 || v >= 10 ? 0 : 1;
  return `${v.toFixed(digits)}${units[i]}`;
}

module.exports = { parse_size, format_size };

// lib/cleanup_disk/path_guard.js
"use strict";
const path = require("path");

function normalize_for_compare(p) {
  return path.resolve(p).replace(/\/+$/, "") || "/";
}

function is_dangerous_path(resolved_path, { home }) {
  const target = normalize_for_compare(resolved_path);
  const home_n = normalize_for_compare(home);
  const blocked = ["/", "/Users", "/System", "/private/var/folders", home_n];
  return blocked.some((b) => target === normalize_for_compare(b));
}

function assert_safe_path(resolved_path, options) {
  if (is_dangerous_path(resolved_path, options)) {
    throw new Error(`Refusing dangerous path: ${resolved_path}`);
  }
}

module.exports = { is_dangerous_path, assert_safe_path };
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run test/cleanup_disk_size.test.js test/cleanup_disk_path_guard.test.js`

- [ ] **Step 5: Commit**

```bash
git add lib/cleanup_disk/size.js lib/cleanup_disk/path_guard.js test/cleanup_disk_size.test.js test/cleanup_disk_path_guard.test.js
git commit -m "feat: add cleanup_disk size and path guard helpers"
```

---

### Task 2: Config load/merge + filter

**Files:**
- Create: `lib/cleanup_disk/config.js`
- Create: `lib/cleanup_disk/filter.js`
- Create: `config/cleanup_disk/defaults.yaml`
- Create: `test/cleanup_disk_config.test.js`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `parse_size` (for validating `min_size` strings later in resolve)
- Produces:
  - `load_config({ defaults_path, local_path, extra_path }) → { version, rule: Rule[] }`
  - `merge_rule_list(base_rules, overlay_rules) → Rule[]` (overlay wins by `id`)
  - `filter_rules(rules, { rule_ids, kind, risk_ceiling, enabled_only }) → Rule[]`
  - Risk order: `low < medium < high`; ceiling includes all ≤ selected

- [ ] **Step 1: Write failing tests for merge and risk ceiling**

```js
import { describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { load_config, merge_rule_list } from "../lib/cleanup_disk/config.js";
import { filter_rules } from "../lib/cleanup_disk/filter.js";

describe("cleanup_disk config", () => {
  it("merges local rules over defaults by id", () => {
    const merged = merge_rule_list(
      [{ id: "a", risk: "low", enabled: true }],
      [{ id: "a", risk: "high", enabled: false }, { id: "b", risk: "medium", enabled: true }],
    );
    expect(merged).toEqual([
      { id: "a", risk: "high", enabled: false },
      { id: "b", risk: "medium", enabled: true },
    ]);
  });

  it("loads yaml files from disk", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-disk-cfg-"));
    const defaults_path = path.join(root, "defaults.yaml");
    await fs.writeFile(
      defaults_path,
      'version: 1\nrule:\n  - id: x\n    path: "~/x"\n    kind: cache\n    risk: low\n    action: trash\n    enabled: true\n',
      "utf8",
    );
    const cfg = await load_config({ defaults_path });
    expect(cfg.version).toBe(1);
    expect(cfg.rule[0].id).toBe("x");
  });
});

describe("cleanup_disk filter", () => {
  const rules = [
    { id: "a", kind: "cache", risk: "low", enabled: true },
    { id: "b", kind: "cache", risk: "medium", enabled: true },
    { id: "c", kind: "large_file", risk: "high", enabled: true },
    { id: "d", kind: "cache", risk: "low", enabled: false },
  ];

  it("applies risk ceiling", () => {
    expect(filter_rules(rules, { risk_ceiling: "low" }).map((r) => r.id)).toEqual(["a"]);
    expect(filter_rules(rules, { risk_ceiling: "medium" }).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("filters by kind and rule id", () => {
    expect(filter_rules(rules, { kind: "large_file" }).map((r) => r.id)).toEqual(["c"]);
    expect(filter_rules(rules, { rule_ids: ["b"] }).map((r) => r.id)).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run test/cleanup_disk_config.test.js`

- [ ] **Step 3: Implement config + filter + defaults.yaml + gitignore**

`defaults.yaml` must include (at minimum) the spec’s trash caches, `idea_hprof`, report-only Docker/Cursor/iCloud video/`code_base`, and a `dev_cache_bundle` delegate to `cleanup_dev_cache` with `["report","--profile","xcode","--profile","temp_cache"]`.

`load_config` uses `yaml` package `parse`. Missing `local_path` is OK. Invalid version or non-array `rule` throws.

Add to `.gitignore`:

```
config/cleanup_disk/local.yaml
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run test/cleanup_disk_config.test.js`

- [ ] **Step 5: Commit**

```bash
git add lib/cleanup_disk/config.js lib/cleanup_disk/filter.js config/cleanup_disk/defaults.yaml test/cleanup_disk_config.test.js .gitignore
git commit -m "feat: add cleanup_disk config merge and rule filters"
```

---

### Task 3: Resolve targets

**Files:**
- Create: `lib/cleanup_disk/resolve_target.js`
- Create: `test/cleanup_disk_resolve_target.test.js`

**Interfaces:**
- Consumes: `parse_size`, `assert_safe_path`, `format_size`
- Produces: `async resolve_rule(rule, { home, now, get_size_bytes }) → ResolvedTarget`
  - `ResolvedTarget`: `{ rule, paths: string[], status, size_bytes, notes }`
  - Expand `~` to `home`; expand `glob` with `glob` package (`nodir: false`)
  - Skip missing paths with `status: missing`
  - Enforce path guard on each resolved path
  - Apply `min_size` / `min_age` (mtime of path); if below threshold → `status: skipped_threshold`
  - Delegate rules resolve to `status: delegate` with empty paths

- [ ] **Step 1: Write failing tests** using temp dirs with files of known size/mtime

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run test/cleanup_disk_resolve_target.test.js`

- [ ] **Step 3: Implement resolve_target.js**

Use `fs.promises.stat` for size/mtime. For directories, size via recursive walk OR `du -sk` subprocess; prefer `du -sk` for speed with a pure-Node fallback for tests if `du` unavailable. Document choice in code comment.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add lib/cleanup_disk/resolve_target.js test/cleanup_disk_resolve_target.test.js
git commit -m "feat: resolve cleanup_disk rule targets with thresholds"
```

---

### Task 4: Clean planner/executor

**Files:**
- Create: `lib/cleanup_disk/clean.js`
- Create: `test/cleanup_disk_clean.test.js`

**Interfaces:**
- Consumes: `move_to_trash` from `lib/file/trash.js`, `assert_safe_path`
- Produces:
  - `plan_clean(resolved_list, { action_override }) → PlanItem[]` — drops `action: report`; applies override only for trash|delete
  - `async execute_clean(plan, { yes, dry_run, repo_bin_dir, logger }) → { results, exit_code }`
  - Without `yes`: no mutation; each item `status: planned`
  - With `yes` + `dry_run`: no mutation; `status: dry_run`
  - With `yes` and not dry_run: trash via `move_to_trash`, delete via `fs.rm(..., { recursive: true, force: true })`, delegate via `execFile` of `path.join(repo_bin_dir, delegate_to)` with `delegate_args`
  - Never permanently delete when trash fails

- [ ] **Step 1: Write failing tests** for plan-only, dry-run, trash with `COMMAND_BASE_TRASH_DIR`, skip report actions

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run test/cleanup_disk_clean.test.js`

- [ ] **Step 3: Implement clean.js**

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add lib/cleanup_disk/clean.js test/cleanup_disk_clean.test.js
git commit -m "feat: add cleanup_disk clean planner and executor"
```

---

### Task 5: Discover

**Files:**
- Create: `lib/cleanup_disk/discover.js`
- Create: `test/cleanup_disk_discover.test.js`

**Interfaces:**
- Consumes: `parse_size`, existing rule path set for dedupe
- Produces: `async discover_hotspots({ root, top, min_size_bytes, existing_rules, run_command }) → { items, yaml_snippets }`
  - Prefer `gdu-go -n -p --si --depth 1 <segment>` for segments: `root`, `root/Library/Caches`, and selected dotdirs if they exist (`.cache`, `.npm`, `.gradle`, `.android`, `.codex`)
  - Large files: `mdfind` query `kMDItemFSSize > ${min_size_bytes}` scoped under root when possible
  - Heuristics per spec (cache / hprof / large_file+report)
  - Filter `.app`, dangerous paths, paths already covered by rule `path`/`glob` exact resolved match when possible
  - `run_command` injectable for tests

- [ ] **Step 1: Write failing unit tests** with fake `run_command` returning fixture stdout

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run test/cleanup_disk_discover.test.js`

- [ ] **Step 3: Implement discover.js**

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add lib/cleanup_disk/discover.js test/cleanup_disk_discover.test.js
git commit -m "feat: add cleanup_disk discover hotspot suggestions"
```

---

### Task 6: CLI entry + integration tests

**Files:**
- Create: `lib/cleanup_disk/cli.js`
- Create: `bin/cleanup_disk`
- Create: `test/cleanup_disk_cli.test.js`

**Interfaces:**
- Produces: `async main(argv, env) → exit_code`
- Subcommands: `report` (default), `discover`, `clean`
- Options per spec; unknown option → stderr + exit 1
- `-v/--version` prints `1.0.0` only
- Colorful logs unless `FORCE_COLOR=0`
- `--debug` prints stage markers before IO
- Default config paths relative to repo root (resolve from `__dirname`)

- [ ] **Step 1: Write CLI integration tests** mirroring `test/cleanup_dev_cache.test.js` style:
  - version output
  - unknown option fails
  - report with temp `--config` fixture
  - clean without `--yes` does not mutate
  - clean `--yes` + trash dir env mutates into trash

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run test/cleanup_disk_cli.test.js`

- [ ] **Step 3: Implement cli.js + bin/cleanup_disk**

```js
#!/usr/bin/env node
"use strict";
const { main } = require("../lib/cleanup_disk/cli.js");
main(process.argv.slice(2), process.env).then((code) => {
  process.exit(code);
}).catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
```

Help text must include Usage, Description, Options (enum explained), Examples with `#` comments per AGENTS.md.

- [ ] **Step 4: chmod +x and run tests — expect PASS**

```bash
chmod +x bin/cleanup_disk
npx vitest run test/cleanup_disk_cli.test.js
```

- [ ] **Step 5: Manual smoke**

```bash
bin/cleanup_disk -v
bin/cleanup_disk report --rule jetbrains_cache
bin/cleanup_disk clean --risk low --kind cache
bin/cleanup_disk discover --root "$HOME" --top 10
```

Expected: version only; report prints sizes; clean without `--yes` prints plan only; discover prints suggestions or analyzer warnings.

- [ ] **Step 6: Commit**

```bash
git add lib/cleanup_disk/cli.js bin/cleanup_disk test/cleanup_disk_cli.test.js
git commit -m "feat: add cleanup_disk CLI"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Rule YAML + defaults + local merge | 2 |
| report / discover / clean | 5–6 |
| `--yes` gate + dry-run | 4, 6 |
| risk/kind/rule filters | 2, 6 |
| path guards | 1, 3 |
| gdu-go / mdfind discover | 5 |
| delegate to cleanup_dev_cache report | 4, 2 defaults |
| trash via lib/file/trash.js | 4 |
| AGENTS CLI conventions | 6 |
| no --apply in v1 | 5, 6 |

## Placeholder / consistency review

- All module paths and exported names are fixed above; CLI must import those exact names.
- Risk ceiling semantics match the spec (`low` ⊂ `medium` ⊂ `high`).
- No TBD steps remain.
