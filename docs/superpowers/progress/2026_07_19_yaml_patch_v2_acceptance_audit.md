# YAML Patch V2 Acceptance Audit

Date: 2026-07-19  
Spec: `docs/superpowers/specs/2026_07_17_yaml_patch_general_requirement_design.md`  
Protocol: `docs/yaml_patch_protocol_v2.md`

Audit rule: every platform-independent P0 ID and section 15 scenario must have code, focused tests, and protocol/docs coverage.

## Requirement → evidence

| IDs | Code | Focused tests | Docs |
| --- | --- | --- | --- |
| Q-001..Q-019 | `lib/yaml_patch/query_v2.js`, `query_predicate.js`, `addressable.js`, `locator.js`, `cursor.js` | `query_ast`, `query_cursor`, `query_range`, `addressable` | protocol Query/Cursor/Locator |
| E-001..E-021 | `mapping_edit.js`, `sequence_edit.js`, `scalar_edit.js`, `subtree_edit.js`, `fragment.js` | `mapping_edit`, `sequence_edit`, `scalar_style`, `subtree_edit`, `fragment_patch` | protocol Operation + unsupported shapes |
| T-001..T-016 | `transaction.js`, `operation.js`, `bind.js` | `transaction`, `operation_contract` | protocol Transaction |
| L-001..L-008 | `range_set.js`, `proof.js`, `candidate.js` | `multi_range_proof`, `fragment_patch`, `writer` | protocol Proof/Manifest |
| W-001..W-012 | `writer.js`, `transaction_writer.js`, `transaction_log.js`, `recovery.js`, `lock.js` | `writer`, `transaction_writer`, `recovery` | protocol Journal/Writer guarantees |
| V-001..V-017 | `parser.js`, `profile.js`, `profile_validate.js`, `profile_reference.js` | `source_parser`, `profile_schema`, `profile_validation`, `profile_reference` | protocol Profile |
| D-001..D-009 | `diff.js`, `manifest.js`, `semantic_summary.js` | `diff_manifest`, `request` | protocol Diff/Manifest |
| P-001..P-015 | `artifact_version.js`, `capability.js`, `request.js`, `cli.js`, `error.js` | `protocol`, `request`, `cli` | protocol Envelope/CLI/exits |
| M-001..M-007 | `migration.js`, `index.js` exports | `migration`, `request` | protocol Migration |
| R-001..R-008 | limits across query/index/isolated/profile/source; `benchmark/yaml_patch/*` | `resource`, `query_resource`, `isolated`, `yaml_corpus` | protocol Resource limits + fixture README |

## Section 15 scenarios

| Scenario group | Evidence |
| --- | --- |
| 15.1 Query | `query_ast`, `query_cursor`, `addressable`, cardinality/conflict paths in `transaction` |
| 15.2 Edit + lossless | `scalar_style`, `mapping_edit`, `sequence_edit`, `subtree_edit`, `multi_range_proof` |
| 15.3 Profile | `profile_schema`, `profile_validation`, `profile_reference` |
| 15.4 Write / concurrency / recovery | `writer`, `transaction_writer`, `recovery`, `cli` |
| 15.5 YAML corpus | `yaml_corpus`, `source_parser`, fixtures under `test/fixture/yaml_patch` |

## Benchmark / resources

- Fixtures: `npm run yaml_patch:fixtures` → baseline (14), path cases, scale (`nodes_64k`, `large_2mib`, `growth_10x`)
- Scale corpora are generated on demand and gitignored (`test/fixture/yaml_patch/scale/`)
- Reference result: `benchmark/yaml_patch/reference_result.json`
- Runner records env metadata, cold/warm samples, p50/p95; exits nonzero on >20% regression in a comparable environment

## Verdict

Pass: every listed P0 ID family and section 15 group maps to implementation, focused tests, and protocol documentation. Absolute R-006 latency targets are environment-relative on non-reference hardware; the runner enforces relative regression only when environments match.
