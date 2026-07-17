# YAML Patch Snake-Case Rename Design

Date: 2026-07-17
Status: APPROVED

## Goal

Replace the newly added lossless YAML patch engine's legacy unseparated name
with `yaml_patch` everywhere. The engine has not been released, so the rename
is a clean break with no compatibility alias or migration layer.

## Scope

The rename covers every public, protocol, filesystem, documentation, and test
identifier introduced for the engine:

- CLI executable and package bin key: `yaml_patch`.
- CLI entry file: `bin/yaml_patch`.
- CLI test file: `test/yaml_patch_cli.test.js`.
- Help text, examples, descriptions, temporary test paths, and implementation
  plan references.
- Protocol formats: `yaml_patch-edit`, `yaml_patch-context`, and
  `yaml_patch-byte-proof`.
- Hidden cooperative lock, extraction lock, temporary, backup, pending-lock,
  and session artifact names use the `.yaml_patch` prefix.
- Diagnostic messages that name the tool use `yaml_patch`.

The existing `lib/yaml_patch` module directory already follows the required
snake-case convention and does not move.

## Compatibility

There is intentionally no executable alias using the legacy unseparated
spelling and no support for protocol values with that prefix. Existing edit
packages or lock files using the old unpublished names are not recognized
after the rename.

The JSON protocol version remains `1` because this rename happens before the
first published release. Package versioning is unchanged.

## Verification

Tests must first fail while expecting the new executable, package bin mapping,
protocol format values, and artifact names. After implementation:

- Searching tracked implementation, tests, and documentation for the legacy
  unseparated spelling returns no matches.
- `bin/yaml_patch --version` prints only the version.
- `bin/yaml_patch --help` identifies the command as `yaml_patch`.
- All focused YAML patch tests and the existing tree regression test pass.
- Package dry-run output includes `bin/yaml_patch` and excludes the legacy CLI
  entry.
