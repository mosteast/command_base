# gather subcommands Design

## Summary

Fold the standalone `gather_doctor` entry into `gather` as a subcommand. `gather` exposes three reserved top-level subcommands: `start` (default export), `init` (existing scaffold), and `doctor` (current `gather_doctor`). `gather` with no subcommand runs `start`. Delete `bin/gather_doctor`.

## Goals

- One public command: `gather`.
- `gather` / `gather start` keep today’s export behavior and flag parsing.
- `gather init` stays a top-level subcommand with today’s scaffold behavior.
- `gather doctor` is a 1:1 replacement for `gather_doctor`, including default `check` and explicit `fix`.
- Update help, `next_command` strings, and tests so they name `gather doctor`.

## Non-goals

- Do not extract the ~3000-line start implementation from `bin/gather` into `lib/gather/`.
- Do not switch start/init parsing to a yargs `.command()` tree.
- Do not change export, init, check, or fix runtime behavior beyond CLI routing and command-name strings.
- Do not keep `bin/gather_doctor` as a wrapper or second entry.
- Do not change `lib/gather_setup/` (unused duplicate, out of scope).

## CLI contract

```
gather [start] [options] [config...]
gather init [options] [config...]
gather doctor [check] [options]
gather doctor fix [options]
```

Reserved first tokens: `start`, `init`, `doctor`. Any other positional is a start config path, same as today (`gather source/exporter.yaml` still runs start).

| Invocation | Behavior |
|---|---|
| `gather` | start |
| `gather start …` | start; strip `start` before the existing parser |
| `gather init …` | init (unchanged) |
| `gather doctor` | doctor check |
| `gather doctor check …` | doctor check |
| `gather doctor fix …` | doctor fix |
| `gather --help` / `gather start --help` | start help, plus a Commands list: start, init, doctor |
| `gather init --help` | init help |
| `gather doctor --help` | doctor help (`scriptName`: `gather doctor`) |

Unknown-option rules stay per subcommand: start remains loose (existing special-cases), doctor remains strict.

`gather start init` is start with a config path named `init` (no extra special-case). `gather doctor start` is an unknown doctor command and fails the same way today’s unknown doctor command fails.

## Architecture

```
bin/gather
├── dispatch first token
├── start  → existing parse_cli_arguments / run_export_command
├── init   → existing parse_init_arguments / run_init_command
└── doctor → lib/gather_doctor/cli.js (moved from bin/gather_doctor)

lib/gather_doctor/
├── cli.js          # parse + main; scriptName "gather doctor"
├── check_runner.js
├── fix_runner.js
└── adapter/        # next_command uses "gather doctor fix …"
```

`bin/gather_doctor` is deleted. Doctor check/fix logic stays in `lib/gather_doctor/`.

Dispatch lives in `main()`:

1. If first argv token is `init`, run init (already reads `process.argv.slice(3)`).
2. If first token is `doctor`, call `run_doctor(process.argv.slice(3))`.
3. If first token is `start`, run start with that token stripped so it is not treated as a config path.
4. Otherwise run start with the current argv (default).

`parse_cli_arguments` takes an explicit argv list (default `process.argv.slice(2)`). Dispatch passes that list with `start` already removed. Do not let the literal `start` become a config pattern. `parse_init_arguments` stays on `process.argv.slice(3)`.

## Error handling

- Doctor unknown command `setup` (and any other unknown doctor token) keeps failing with a clear error and doctor help. Copy updates from `gather_doctor …` to `gather doctor …`.
- Top-level help lists the three subcommands. Doctor help examples use `$0` as `gather doctor`.
- Logger default command names that users see (`gather_doctor`) become `gather doctor` where they are CLI-facing. Internal temp filenames (`gather_doctor_copy`, cookie export basenames) may stay.

## Testing

Keep existing gather start/init coverage pointed at `bin/gather`. Add:

- `gather start --help` and `gather --help` both show start usage and Commands.
- `gather start --dry-run <config>` matches today’s default-start dry-run path.
- `gather doctor --help` / `--version` / unknown option (move `test/gather_doctor_cli.test.js` to invoke `bin/gather` with a leading `doctor` arg).
- `gather doctor fix --dry-run …` still does not write runtime.

Adapter tests that assert `next_command` must expect `gather doctor fix --platform …`.

## Implementation notes

- Two or more repo-owned source files → task branch + isolated git worktree, then merge back.
- Files in scope: `bin/gather`, delete `bin/gather_doctor`, add `lib/gather_doctor/cli.js`, adapter `next_command` strings, `test/gather.test.js`, `test/gather_doctor_cli.test.js`, and this spec.
- Callers need follow-up: replace `gather_doctor` with `gather doctor` in shells, notes, and any `next_command` they copied.
