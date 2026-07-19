# YAML Patch Protocol v2

Versioned library/CLI protocol for lossless YAML query, validation, transaction planning, recoverable multi-file writes, and resumable migrations.

## Envelope

Success:

```json
{
  "ok": true,
  "protocol_version": 1,
  "result": {}
}
```

Error:

```json
{
  "ok": false,
  "protocol_version": 1,
  "code": "REQUEST_ERROR",
  "message": "human readable",
  "recoverable": false,
  "next_action": "fix the request",
  "details": {}
}
```

Exit mapping: `0` success; `2` request/protocol; `3` query/conflict; `4` validation; `5` concurrency; `6` limit/structure/capability; `7` write/proof/recovery; `70` internal.

`capabilities` also reports independent artifact versions (`capability_protocol_version: 2`).

## Artifact versions

Independent constants: query `[1,2]`, operation `[1,2]`, transaction `[1]`, profile `[1]`, manifest `[1,2]`, proof `[1,2]`, structured_diff `[1]`, cursor `[1]`, locator `[1,2]`, journal `[1]`, migration `[1]`.

## Query v2

```json
{
  "kind": "query",
  "version": 2,
  "files": [{ "id": "main", "path": "config.yaml" }],
  "where": {
    "all": [
      { "predicate": "node_type", "equals": "mapping" },
      {
        "predicate": "field_value",
        "field": "enabled",
        "equals": { "type": "boolean", "value": true }
      }
    ]
  },
  "select": { "kind": "self" },
  "projection": {
    "fields": [
      "source_path",
      "document",
      "node_type",
      "path",
      "line",
      "column",
      "byte_range",
      "raw",
      "parent_path",
      "sibling_index"
    ],
    "missing": "error"
  },
  "expect_matches": { "min": 1, "max": 20 },
  "page": { "limit": 100 },
  "limits": {
    "max_result": 1000,
    "max_output_bytes": 4194304,
    "max_regex_pattern_length": 256,
    "max_regex_input_length": 1048576
  }
}
```

### Cursor

```json
{
  "version": 1,
  "input_digest": "<sha256 of sorted source digests>",
  "query_digest": "<sha256 of normalized query>",
  "offset": 100
}
```

Source or query digest changes invalidate the cursor with a conflict error.

### Locator

```json
{
  "version": 2,
  "source_digest": "<sha256>",
  "document": 0,
  "path": [{ "mapping_key": "enabled" }],
  "byte_range": { "start": 12, "end": 16 },
  "target_digest": "<sha256 of target bytes>"
}
```

Locators bind one source snapshot only. Cross-operation references inside a transaction use transaction handles, not stale locators.

Regex predicates run only in the bounded worker.

## Profile v1

```json
{
  "version": 1,
  "scope": {
    "include": ["**/*.yaml"],
    "exclude": [".yaml_patch-*/**"]
  },
  "identities": [
    {
      "rule_id": "service_name",
      "nodes": {
        "version": 2,
        "where": { "predicate": "node_type", "equals": "mapping" },
        "select": { "kind": "self" }
      },
      "fields": ["name"],
      "unique_scope": "file",
      "immutable_when_present": true
    }
  ],
  "references": [],
  "graphs": [],
  "protection": []
}
```

Profiles validate fields, identity, aliases, references, cycles, protection, and optional per-operation rules. Profiles return diagnostics only and never mutate buffers.

## Operation / Transaction v1

```json
{
  "kind": "transaction",
  "version": 1,
  "files": [
    {
      "id": "main",
      "path": "config.yaml",
      "digest": "<sha256>",
      "document_count": 1
    }
  ],
  "operations": [
    {
      "id": "set-value",
      "type": "replace_scalar_raw",
      "file": "main",
      "target": {
        "selector": { "version": 1, "path": [{ "mapping_key": "value" }] }
      },
      "raw": "new"
    }
  ]
}
```

Dry-run is default. `--write` commits through a durable journal. The implementation does **not** claim simultaneous multi-file visibility; crash windows may expose mixed versions until recovery converges to all-original or all-candidate content.

Unsupported edit shapes return `UNSUPPORTED_EDIT_SHAPE`. Unsafe cross-boundary moves return `CROSS_BOUNDARY_DEPENDENCY`.

## Manifest / proof / diff

Dry-run and write results include text diff, structured diff, semantic summary, validation, and byte proof data.

### Structured diff

```json
{
  "version": 1,
  "files": [
    {
      "path": "config.yaml",
      "operations": [
        {
          "operation_id": "set-value",
          "type": "replace_scalar_raw",
          "original_range": { "start": 12, "end": 16 },
          "candidate_range": { "start": 12, "end": 15 },
          "before": { "type": "string", "value": "old" },
          "after": { "type": "string", "value": "new" },
          "noop": false
        }
      ]
    }
  ]
}
```

### Proof

```json
{
  "version": 2,
  "original_digest": "<sha256>",
  "candidate_digest": "<sha256>",
  "unchanged_digest": "<sha256>",
  "ranges": [
    {
      "operation_id": "set-value",
      "original": {
        "start": 12,
        "end": 16,
        "digest": "<sha256>"
      },
      "replacement": {
        "start": 12,
        "end": 15,
        "digest": "<sha256>"
      }
    }
  ],
  "bytes": { "deleted": 4, "inserted": 3, "touched": 7 },
  "noop": false
}
```

### Manifest

```json
{
  "version": 2,
  "request_digest": "<sha256>",
  "result_digest": "<sha256>",
  "profile_digest": "<sha256>",
  "capability_digest": "<sha256>",
  "files": [{ "path": "config.yaml", "original_digest": "<sha256>", "candidate_digest": "<sha256>" }],
  "proofs": [],
  "validation": { "ok": true, "diagnostics": [] },
  "diff_digest": "<sha256>"
}
```

Manifests bind request/result digests, profile/capability digests, and proofs without random/time/absolute-path noise in the reproducible digest. Replay re-validates source, profile, and capability digests and refuses conflicts.

## Journal / recovery

Journal states: `planned`, `prepared`, `committing`, `committed`, `rolling_back`, `rolled_back`, `recovery_required`.

```json
{
  "version": 1,
  "transaction_id": "<id>",
  "state": "prepared",
  "files": [
    {
      "path": "config.yaml",
      "original_digest": "<sha256>",
      "candidate_digest": "<sha256>",
      "temp_path": "config.yaml.yaml_patch.tmp",
      "recovery_path": "config.yaml.yaml_patch.orig",
      "progress": "prepared"
    }
  ],
  "commit_order": ["config.yaml"]
}
```

```bash
yaml_patch status --journal .yaml_patch-transaction-<id>.journal --json
yaml_patch recover --journal <path> --direction commit --json
yaml_patch recover --journal <path> --direction rollback --json
```

Recovery is idempotent and refuses digest/identity mismatches.

## Migration v1

```json
{
  "kind": "migration",
  "version": 1,
  "mode": "scan",
  "rules": [
    {
      "id": "rename-key",
      "query": {
        "version": 2,
        "where": { "predicate": "mapping_key", "equals": "old" },
        "select": { "kind": "self" }
      },
      "operations": [
        {
          "type": "rename_mapping_key",
          "from": "old",
          "to": "new"
        }
      ]
    }
  ],
  "batch_limits": {
    "max_file_per_batch": 32,
    "max_node_per_batch": 256,
    "max_byte_per_batch": 1048576
  }
}
```

Migration rules compile exclusively to query v2 plus ordinary transaction operations. Scan mode reports matches/conflicts/estimated files/bytes. Batches are stable by file/node/byte limits and resume actions are `retry`, `rollback`, `continue`, and `replan`. Source/profile digest changes block blind resume.

## CLI examples

```bash
# Literal/glob query
yaml_patch find "config/**/*.yaml" --query query.json --json

# Stdin query v2
yaml_patch query --query - --json < query_v2.json

# Dry-run transaction
yaml_patch transaction --operations tx.json --profile profile.yaml --json

# Write + recovery
yaml_patch transaction --operations tx.json --write --json
yaml_patch status --journal journal.json --json
yaml_patch recover --journal journal.json --direction rollback --json

# Manifest replay
yaml_patch replay --manifest manifest.json --json

# Migration scan
yaml_patch migration --operations migration.json --json

# Capabilities
yaml_patch capabilities --json
```

## Writer platform guarantees

On supported local filesystems (Linux/Darwin): same-directory temp files, fsync, atomic rename, directory fsync when available, mode/owner preservation, cooperative token locks. On unsupported platforms, dry-run remains available and write fails with `ATOMIC_WRITE_UNAVAILABLE` before rename.

## Unsupported edit shapes

The following fail closed with `UNSUPPORTED_EDIT_SHAPE` or `CROSS_BOUNDARY_DEPENDENCY` when safety cannot be proven:

- block scalars with unsafe indent/chomping relocation
- flow collections that cannot keep surrounding syntax
- document directives / custom tags / anchors / aliases that would dangle or duplicate
- moves that require full-document reserialization

## Resource limits

Defaults bound file bytes, node count, depth, predicate AST size, regex pattern/input length, result count, output bytes, graph nodes/edges/visits/time, and worker wall time. Raising a limit requires an explicit request. Exceeding a hard limit returns `CHANGE_LIMIT_EXCEEDED` before write.
