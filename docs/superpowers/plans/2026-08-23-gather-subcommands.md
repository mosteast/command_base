# gather subcommands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `gather` the only public entry, with reserved subcommands `start` (default export), `init` (scaffold), and `doctor` (current `gather_doctor`); delete `bin/gather_doctor`.

**Architecture:** `bin/gather` `main()` dispatches on the first argv token. `start` reuses today’s export parser/runner after stripping the `start` token. `init` stays on `process.argv.slice(3)`. `doctor` calls `run_doctor(rest)` from a moved `lib/gather_doctor/cli.js`. Adapter `next_command` strings and CLI-facing logger names say `gather doctor`.

**Tech Stack:** Node.js, yargs (already used), Vitest, existing `lib/gather_doctor/` check/fix runners.

## Global Constraints

- Reserved first tokens: `start`, `init`, `doctor`. Any other positional is a start config path.
- `gather` / `gather start` keep today’s export behavior and flag parsing.
- `gather init` stays a top-level subcommand with today’s scaffold behavior.
- `gather doctor` is a 1:1 replacement for `gather_doctor`, including default `check` and explicit `fix`.
- Do not extract the ~3000-line start implementation from `bin/gather` into `lib/gather/`.
- Do not switch start/init parsing to a yargs `.command()` tree.
- Do not keep `bin/gather_doctor` as a wrapper or second entry.
- Do not change `lib/gather_setup/`.
- Internal temp filenames (`gather_doctor_copy`, cookie export basenames) may stay.
- Naming: snake_case files/vars/functions; `function` keyword for pure helpers; named exports.
- Two or more repo-owned source files → isolated git worktree from the original branch, commit there, merge back, delete the worktree and task branch.
- Do not commit files under `tmp/`.

## File structure

| Path | Responsibility |
|------|----------------|
| `bin/gather` | Public entry: dispatch `start` / `init` / `doctor`; keep start + init implementations |
| `lib/gather_doctor/cli.js` | Doctor parse + `run_doctor`; `scriptName` is `gather doctor` |
| `bin/gather_doctor` | Delete |
| `lib/gather_doctor/adapter/*.js` | `next_command` uses `gather doctor fix --platform …` |
| `lib/gather_doctor/check_runner.js` | Default logger `command_name` is `gather doctor` |
| `test/gather.test.js` | Start default + explicit `start` + help Commands |
| `test/gather_doctor_cli.test.js` | Invoke `bin/gather` with a leading `doctor` arg |

---

### Task 1: Default `start` dispatch and start help

**Files:**
- Modify: `bin/gather` (`build_help_text`, `parse_cli_arguments`, `run_export_command`, `main`)
- Test: `test/gather.test.js`

**Interfaces:**
- Consumes: existing `parse_cli_arguments` / `run_export_command` / `run_init_command`
- Produces: `parse_cli_arguments(argv = process.argv.slice(2))`, `run_export_command(argv)`, `main()` treats `start` as optional first token and `init` as today

- [ ] **Step 1: Write the failing tests**

Append this describe to `test/gather.test.js` (reuse `run_cli`, `create_temp_dir`, `write_config_file`, `strip_ansi` already in that file):

```js
describe("gather CLI subcommands", () => {
  it("lists start, init, and doctor in start help", async () => {
    const help = await run_cli(["--help"]);
    expect(help.exit_code).toBe(0);
    const text = strip_ansi(help.stdout);
    expect(text).toContain("Usage");
    expect(text).toMatch(/\[start\]/);
    expect(text).toMatch(/^\s+start\s+/m);
    expect(text).toMatch(/^\s+init\s+/m);
    expect(text).toMatch(/^\s+doctor\s+/m);

    const start_help = await run_cli(["start", "--help"]);
    expect(start_help.exit_code).toBe(0);
    const start_text = strip_ansi(start_help.stdout);
    expect(start_text).toContain("Usage");
    expect(start_text).toMatch(/^\s+doctor\s+/m);
  });

  it("runs the same export when start is explicit", async () => {
    const temp_root = await create_temp_dir();
    const state_file = path.join(temp_root, "gather.state.json");
    const report_dir = path.join(temp_root, "report");
    const start_report_dir = path.join(temp_root, "report-start");

    try {
      const config_path = await write_config_file(temp_root);
      const implicit = await run_cli([
        "--dry-run",
        "--report-dir",
        report_dir,
        "--state-file",
        state_file,
        config_path,
      ]);
      const explicit = await run_cli([
        "start",
        "--dry-run",
        "--report-dir",
        start_report_dir,
        "--state-file",
        state_file,
        config_path,
      ]);

      expect(implicit.exit_code).toBe(0);
      expect(explicit.exit_code).toBe(0);
      expect(explicit.stdout).toContain("Dry-run mode");
      expect(explicit.stderr).not.toMatch(/Unable to process config/);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/gather.test.js --testNamePattern="gather CLI subcommands"`

Expected: FAIL. `--help` has no `[start]` usage and no `doctor` command line. `gather start --dry-run <config>` treats `start` as a config path and exits non-zero (`Unable to process config`).

- [ ] **Step 3: Implement start dispatch and help**

In `bin/gather` `build_help_text`, change Usage and Commands to:

```js
    `${chalk.bold("Usage")}`,
    `  ${script_name} [start] [options] <config...>`,
    `  ${script_name} --config "source/*.yaml"`,
    `  ${script_name} init [options] [config...]`,
    `  ${script_name} doctor [check] [options]`,
    `  ${script_name} doctor fix [options]`,
```

```js
    `${chalk.bold("Commands")}`,
    "  start                       Run the export (default when no subcommand is given).",
    "  init                        Create a scaffold config file if empty.",
    "  doctor                      Diagnose and fix gather platform tooling and auth.",
```

Add one start example after the existing “Export all sources” example:

```js
    "  # Same export via the explicit start subcommand",
    `  ${example_cmd} start source/exporter.yaml`,
```

Change `parse_cli_arguments` to take argv and use script name `gather`:

```js
function parse_cli_arguments(argv = process.argv.slice(2)) {
  const yargs = require("yargs");

  const parser = yargs(argv)
    .scriptName("gather")
```

Keep every existing option and the rest of the function body. Replace leftover `"batch_exporter"` fallbacks in this function with `"gather"` (`argv.$0 || "gather"`).

Change `run_export_command` to:

```js
async function run_export_command(argv = process.argv.slice(2)) {
  const options = parse_cli_arguments(argv);
```

Replace `main` and the top-level catch:

```js
async function main() {
  const args = process.argv.slice(2);
  const [command_name] = args;
  if (command_name === "init") {
    await run_init_command();
    return;
  }
  if (command_name === "start") {
    await run_export_command(args.slice(1));
    return;
  }
  await run_export_command(args);
}

main().catch((error) => {
  console.error(chalk.red(`gather failed: ${error.message}`));
  process.exit(1);
});
```

Do not wire `doctor` in this task. Leave `parse_init_arguments` on `process.argv.slice(3)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/gather.test.js --testNamePattern="gather CLI subcommands|gather CLI platform selection"`

Expected: PASS (new subcommand tests plus existing start/export coverage).

- [ ] **Step 5: Commit**

```bash
git add bin/gather test/gather.test.js
git commit -m "$(cat <<'EOF'
Add gather start as the default export subcommand.

EOF
)"
```

---

### Task 2: Move doctor CLI under `gather doctor`

**Files:**
- Create: `lib/gather_doctor/cli.js`
- Modify: `bin/gather` (`main` doctor branch)
- Delete: `bin/gather_doctor`
- Test: `test/gather_doctor_cli.test.js`

**Interfaces:**
- Consumes: `run_check(options)`, `run_fix(options)` from `lib/gather_doctor/check_runner.js` and `lib/gather_doctor/fix_runner.js`
- Produces: `run_doctor(argv) → Promise<void>` (exits with the check/fix exit code, same as today’s `bin/gather_doctor`)

- [ ] **Step 1: Point doctor CLI tests at `gather doctor`**

In `test/gather_doctor_cli.test.js` change the entry and prefix:

```js
const cli_entry = path.resolve(__dirname, "../bin/gather");

function run_cli(args, env_overrides = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli_entry, "doctor", ...args],
      {
        env: { ...process.env, ...env_overrides, FORCE_COLOR: "0" },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exit_code: error ? error.code || 1 : 0,
        });
      },
    );
  });
}
```

Keep the three existing cases (`--help`/`--version`, unknown option, dry-run fix). Tighten help assertions:

```js
    expect(strip_ansi(help.stdout)).toContain("Usage");
    expect(strip_ansi(help.stdout)).toContain("fix");
    expect(strip_ansi(help.stdout)).toContain("gather doctor");
```

Add this case in the same describe:

```js
  it("rejects the retired setup command", async () => {
    const result = await run_cli(["setup"]);
    expect(result.exit_code).toBe(1);
    const text = strip_ansi(`${result.stdout}\n${result.stderr}`);
    expect(text).toMatch(/Unknown command "setup"/);
    expect(text).toContain("gather doctor fix");
    expect(text).not.toContain("gather_doctor fix");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/gather_doctor_cli.test.js`

Expected: FAIL. `bin/gather` still treats `doctor` as a config path (or the old `bin/gather_doctor` is the only working entry). Help does not say `gather doctor`.

- [ ] **Step 3: Move doctor CLI and wire dispatch**

Create `lib/gather_doctor/cli.js` from `bin/gather_doctor` with these substitutions:

- Require paths drop one `../` (`../package.json` → `../../package.json`; `../lib/gather_doctor/…` → `./…`).
- Drop the `#!/usr/bin/env node` shebang.
- Default script name is `gather doctor`.
- Export `run_doctor`.
- Do not auto-run `main()` when required.

```js
"use strict";

const chalk = require("chalk");
const package_json = require("../../package.json");
const {
  DEFAULT_CONFIG_PATH,
  DEFAULT_RUNTIME_PATH,
  PLATFORM_KEYS,
} = require("./constants");
const {
  normalize_platform_list,
  select_platforms,
} = require("./platform");
const { run_check } = require("./check_runner");
const { run_fix } = require("./fix_runner");

const DOCTOR_SCRIPT_NAME = "gather doctor";

function build_help_text(script_name) {
  return [
    `${chalk.bold("Usage")}`,
    `  ${script_name} [check] [options]`,
    `  ${script_name} fix [options]`,
    "",
    `${chalk.bold("Description")}`,
    "  Diagnose and fix gather platform tooling, Chrome cookie profiles,",
    "  and auth files so gather can run correctly.",
    "  Default action is check (static + live probe).",
    "  fix writes gather.runtime.yaml, exports cookies, and can brew install/upgrade.",
    "",
    `${chalk.bold("Options")}`,
    `  -c, --config <path>          Gather YAML config (default: ${DEFAULT_CONFIG_PATH})`,
    `      --runtime <path>         Runtime YAML path (default: ${DEFAULT_RUNTIME_PATH})`,
    `  -p, --platform <name...>     Only these platforms (${PLATFORM_KEYS.join(", ")})`,
    "      --exclude-platform <...> Skip these platforms",
    "      --chrome-profile <name>  Limit Chrome scan to one profile directory/name",
    "      --offline                Skip live network probes (check only)",
    "  -y, --yes                    Skip fix confirmation",
    "  -d, --dry-run                Preview fix without writing or installing",
    "      --quiet                  Print only warnings and errors",
    "      --debug                  Enable verbose debug output",
    "  -v, --version                Show version number and exit",
    "  -h, --help                   Show this help message",
    "",
    `${chalk.bold("Examples")}`,
    "  # Check all platforms (static + probe)",
    "  $0",
    "",
    "  # Offline check for youtube only",
    "  $0 check --offline --platform youtube",
    "",
    "  # Preview fix for gallery-dl / X cookies",
    "  $0 fix --platform x_gallery_dl --dry-run",
    "",
    "  # Apply fix without prompting",
    "  $0 fix --yes --platform youtube bilibili",
  ].join("\n");
}

function normalize_list(values) {
  if (!values) return [];
  const list = Array.isArray(values) ? values : [values];
  const normalized = [];
  for (const entry of list) {
    const text = String(entry || "").trim();
    if (!text) continue;
    for (const part of text.split(",").map((item) => item.trim())) {
      if (part) normalized.push(part);
    }
  }
  return normalized;
}

function parse_arguments(argv) {
  const yargs = require("yargs/yargs");
  const args = [...argv];
  let mode = "check";
  if (args[0] === "check" || args[0] === "fix") {
    mode = args.shift();
  } else if (args[0] === "setup") {
    console.error(
      chalk.red(
        'Unknown command "setup". Use "fix" instead (gather doctor fix).',
      ),
    );
    console.log(build_help_text(DOCTOR_SCRIPT_NAME));
    process.exit(1);
  }

  const parser = yargs(args)
    .scriptName(DOCTOR_SCRIPT_NAME)
    .help(false)
    .version(false)
    .parserConfiguration({
      "camel-case-expansion": false,
      "strip-dashed": false,
    })
    .option("config", {
      alias: "c",
      type: "string",
      describe: `Gather YAML config path (default: ${DEFAULT_CONFIG_PATH})`,
    })
    .option("runtime", {
      type: "string",
      describe: `Runtime YAML path (default: ${DEFAULT_RUNTIME_PATH})`,
    })
    .option("platform", {
      alias: "p",
      type: "array",
      describe: "Only these platforms",
    })
    .option("exclude-platform", {
      type: "array",
      describe: "Skip these platforms",
    })
    .option("chrome-profile", {
      type: "string",
      describe: "Limit Chrome scan to one profile",
    })
    .option("offline", {
      type: "boolean",
      default: false,
      describe: "Skip live network probes",
    })
    .option("yes", {
      alias: "y",
      type: "boolean",
      default: false,
      describe: "Skip fix confirmation",
    })
    .option("dry-run", {
      alias: "d",
      type: "boolean",
      default: false,
      describe: "Preview without writing",
    })
    .option("quiet", {
      type: "boolean",
      default: false,
      describe: "Print only warnings and errors",
    })
    .option("debug", {
      type: "boolean",
      default: false,
      describe: "Enable verbose debug output",
    })
    .option("version", {
      alias: "v",
      type: "boolean",
      describe: "Show version number and exit",
    })
    .option("help", {
      alias: "h",
      type: "boolean",
      describe: "Show help message",
    })
    .strict(true)
    .fail((message) => {
      console.error(chalk.red(message));
      console.log(build_help_text(DOCTOR_SCRIPT_NAME));
      process.exit(1);
    });

  const parsed = parser.parse();
  if (parsed.help) {
    console.log(build_help_text(parsed.$0 || DOCTOR_SCRIPT_NAME));
    process.exit(0);
  }
  if (parsed.version) {
    console.log(package_json.version);
    process.exit(0);
  }

  let include_platforms = [];
  let exclude_platforms = [];
  try {
    include_platforms = normalize_platform_list(normalize_list(parsed.platform));
    exclude_platforms = normalize_platform_list(
      normalize_list(parsed["exclude-platform"]),
    );
  } catch (error) {
    console.error(chalk.red(error.message));
    console.log(build_help_text(parsed.$0 || DOCTOR_SCRIPT_NAME));
    process.exit(1);
  }

  return {
    mode,
    command_name: parsed.$0 || DOCTOR_SCRIPT_NAME,
    config_path: parsed.config ? String(parsed.config) : DEFAULT_CONFIG_PATH,
    runtime_path: parsed.runtime ? String(parsed.runtime) : DEFAULT_RUNTIME_PATH,
    platforms: select_platforms(include_platforms, exclude_platforms),
    chrome_profile: parsed["chrome-profile"]
      ? String(parsed["chrome-profile"])
      : "",
    offline: Boolean(parsed.offline),
    yes: Boolean(parsed.yes),
    dry_run: Boolean(parsed["dry-run"]),
    quiet_mode: Boolean(parsed.quiet),
    debug_mode: Boolean(parsed.debug),
  };
}

async function run_doctor(argv) {
  const options = parse_arguments(argv);
  if (options.mode === "fix") {
    const result = await run_fix(options);
    process.exit(result.exit_code || 0);
  }
  const result = await run_check(options);
  process.exit(result.exit_code || 0);
}

module.exports = {
  run_doctor,
};
```

In `bin/gather` `main()`, add the doctor branch after `init` and before `start`:

```js
async function main() {
  const args = process.argv.slice(2);
  const [command_name] = args;
  if (command_name === "init") {
    await run_init_command();
    return;
  }
  if (command_name === "doctor") {
    const { run_doctor } = require("../lib/gather_doctor/cli");
    await run_doctor(args.slice(1));
    return;
  }
  if (command_name === "start") {
    await run_export_command(args.slice(1));
    return;
  }
  await run_export_command(args);
}
```

Delete `bin/gather_doctor`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/gather_doctor_cli.test.js test/gather.test.js --testNamePattern="gather CLI subcommands"`

Expected: PASS. `gather doctor --help` prints doctor help. Dry-run fix does not write runtime. `gather start` still works.

- [ ] **Step 5: Commit**

```bash
git add bin/gather lib/gather_doctor/cli.js test/gather_doctor_cli.test.js
git rm bin/gather_doctor
git commit -m "$(cat <<'EOF'
Move gather_doctor behind gather doctor.

EOF
)"
```

---

### Task 3: CLI-facing `gather doctor` strings

**Files:**
- Modify: `lib/gather_doctor/adapter/common.js` (`next_command`)
- Modify: `lib/gather_doctor/adapter/youtube.js`
- Modify: `lib/gather_doctor/adapter/bilibili.js`
- Modify: `lib/gather_doctor/adapter/f2_platforms.js`
- Modify: `lib/gather_doctor/adapter/x_gallery_dl.js`
- Modify: `lib/gather_doctor/check_runner.js` (default `command_name`)
- Test: `test/gather_doctor_adapter_yt_dlp.test.js`

**Interfaces:**
- Consumes: `chrome_check_for_platform` / adapter `check` results
- Produces: user-visible `next_command` values of the form `gather doctor fix --platform <key>`; logger prefix default `gather doctor`

- [ ] **Step 1: Write the failing test**

Append to `test/gather_doctor_adapter_yt_dlp.test.js`:

```js
describe("gather doctor next_command copy", () => {
  it("points chrome cookie failure at gather doctor fix", () => {
    const { chrome_check_for_platform } = require("../lib/gather_doctor/adapter/common");
    const result = chrome_check_for_platform("youtube", { chrome_scans: [] });
    expect(result.next_command).toBe("gather doctor fix --platform youtube");
    expect(result.next_command).not.toContain("gather_doctor");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/gather_doctor_adapter_yt_dlp.test.js --testNamePattern="gather doctor next_command copy"`

Expected: FAIL with `gather_doctor fix --platform youtube` (old copy) or a missing new string.

- [ ] **Step 3: Update CLI-facing strings**

Replace every user-visible `gather_doctor fix` with `gather doctor fix`:

```js
// lib/gather_doctor/adapter/common.js
next_command: `gather doctor fix --platform ${platform_key}`,
```

```js
// lib/gather_doctor/adapter/youtube.js
next_command = "gather doctor fix --platform youtube";
```

```js
// lib/gather_doctor/adapter/bilibili.js
next_command = "gather doctor fix --platform bilibili";
```

```js
// lib/gather_doctor/adapter/f2_platforms.js
next_command = `gather doctor fix --platform ${platform_key}`;
```

```js
// lib/gather_doctor/adapter/x_gallery_dl.js (both assignments)
next_command = "gather doctor fix --platform x_gallery_dl";
```

In `lib/gather_doctor/check_runner.js`:

```js
function create_logger({ quiet_mode, debug_mode, command_name = "gather doctor" }) {
```

Do not rename `gather_doctor_copy`, `.gather_doctor_write_probe_*`, or `gather_doctor_${platform_key}_cookies.txt`.

- [ ] **Step 4: Run related tests**

Run:

```bash
npx vitest run \
  test/gather_doctor_adapter_yt_dlp.test.js \
  test/gather_doctor_adapter_gallery_dl.test.js \
  test/gather_doctor_adapter_f2.test.js \
  test/gather_doctor_probe_classify.test.js \
  test/gather_doctor_cli.test.js \
  test/gather.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  lib/gather_doctor/adapter/common.js \
  lib/gather_doctor/adapter/youtube.js \
  lib/gather_doctor/adapter/bilibili.js \
  lib/gather_doctor/adapter/f2_platforms.js \
  lib/gather_doctor/adapter/x_gallery_dl.js \
  lib/gather_doctor/check_runner.js \
  test/gather_doctor_adapter_yt_dlp.test.js
git commit -m "$(cat <<'EOF'
Point gather doctor hints at the nested command.

EOF
)"
```

---

## Spec coverage

| Spec requirement | Task |
|---|---|
| `gather` / `gather start` keep export behavior | Task 1 |
| `start` stripped before start parser | Task 1 |
| `gather --help` / `gather start --help` list start, init, doctor | Task 1 |
| `gather init` unchanged | Task 1 (dispatch still uses `process.argv.slice(3)`) |
| `gather doctor` default check + `fix` | Task 2 |
| Delete `bin/gather_doctor` | Task 2 |
| Doctor help `scriptName` is `gather doctor` | Task 2 |
| Retired `setup` copy uses `gather doctor fix` | Task 2 |
| `next_command` / logger names say `gather doctor` | Task 3 |
| Internal temp filenames stay | Task 3 (explicit non-change) |
| Do not split `bin/gather` into `lib/gather/` | All tasks |
| Do not keep a `gather_doctor` wrapper | Task 2 |

## Caller follow-up

Replace `gather_doctor` with `gather doctor` in shells, notes, and any copied `next_command`. No in-repo caller besides the strings updated in Task 3.
