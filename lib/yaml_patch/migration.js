"use strict";

const path = require("node:path");

const { canonical_digest } = require("./artifact_version");
const { list_capabilities } = require("./capability");
const { Yaml_patch_error, request_error } = require("./error");
const { create_transaction_manifest } = require("./manifest");
const { build_node_index } = require("./node_index");
const { parse_yaml_source } = require("./parser");
const { run_query_v2 } = require("./query_v2");
const { assert_known_fields, assert_object } = require("./schema");
const { create_source_record, sha256_digest } = require("./source");
const { plan_transaction } = require("./transaction");
const { write_transaction } = require("./transaction_writer");

const MIGRATION_RULE_TYPES = Object.freeze([
  "normalize_key_alias",
  "convert_typed_value",
  "wrap_value",
  "unwrap_value",
  "normalize_child_keys",
  "move_node",
]);

const MIGRATION_FIELDS = Object.freeze([
  "version",
  "files",
  "rules",
  "profile",
  "limits",
  "mode",
]);

function migration_error(message, details = {}) {
  throw new Yaml_patch_error("VALIDATION_FAILED", message, { details });
}

function default_migration_limits(limits = {}) {
  return {
    max_file_per_batch: limits.max_file_per_batch || 32,
    max_node_per_batch: limits.max_node_per_batch || 256,
    max_byte_per_batch: limits.max_byte_per_batch || 256 * 1024,
  };
}

function build_query_input(file, buffer) {
  const source = create_source_record(buffer, {
    file_path: path.resolve(file.path),
    requested_path: file.path,
  });
  return { index: build_node_index(source, parse_yaml_source(source)) };
}

function compile_rule_to_operations(rule, matches) {
  assert_object(rule, "migration rule");
  if (!MIGRATION_RULE_TYPES.includes(rule.type)) {
    migration_error(`Unsupported migration rule type: ${rule.type}`, {
      type: rule.type,
    });
  }
  const operations = [];
  for (const [index, match] of matches.entries()) {
    const operation_id = `${rule.id || rule.type}-${index}`;
    if (rule.type === "normalize_key_alias") {
      operations.push({
        id: operation_id,
        type: "rename_mapping_key",
        file: match.file_id,
        target: {
          selector: {
            version: 1,
            path: match.path.slice(0, -1),
          },
        },
        from_key: rule.from_key,
        to_key: rule.to_key,
      });
      continue;
    }
    if (rule.type === "convert_typed_value" || rule.type === "wrap_value") {
      operations.push({
        id: operation_id,
        type: "replace_scalar_raw",
        file: match.file_id,
        target: {
          selector: { version: 1, path: match.path },
        },
        raw: rule.replacement_raw,
      });
      continue;
    }
    if (rule.type === "unwrap_value") {
      operations.push({
        id: operation_id,
        type: "replace_scalar_raw",
        file: match.file_id,
        target: {
          selector: { version: 1, path: match.path },
        },
        raw: rule.replacement_raw,
      });
      continue;
    }
    if (rule.type === "normalize_child_keys") {
      for (const [alias_index, alias] of (rule.aliases || []).entries()) {
        operations.push({
          id: `${operation_id}-alias-${alias_index}`,
          type: "rename_mapping_key",
          file: match.file_id,
          target: {
            selector: { version: 1, path: match.path },
          },
          from_key: alias.from_key,
          to_key: alias.to_key,
        });
      }
      continue;
    }
    if (rule.type === "move_node") {
      operations.push({
        id: operation_id,
        type: "move_subtree",
        source: {
          file: match.file_id,
          selector: { version: 1, path: match.path },
        },
        destination: rule.destination,
      });
    }
  }
  return operations;
}

function plan_migration(request, options = {}) {
  assert_object(request, "migration request");
  assert_known_fields(request, MIGRATION_FIELDS, "migration request");
  if (request.version !== 1) {
    throw request_error("Unsupported migration version", {
      version: request.version,
    });
  }
  if (!Array.isArray(request.files) || request.files.length === 0) {
    migration_error("Migration requires at least one file");
  }
  if (!Array.isArray(request.rules) || request.rules.length === 0) {
    migration_error("Migration requires at least one rule");
  }

  const sources = { ...(options.sources || {}) };
  const limits = default_migration_limits(request.limits || options.limits);
  const mode = request.mode || options.mode || "scan";
  const rule_reports = [];
  const all_operations = [];
  let conflict_count = 0;
  let estimated_bytes = 0;

  for (const rule of request.rules) {
    if (!rule.query || rule.query.version !== 2) {
      migration_error("Migration rules must use query v2", {
        rule_id: rule.id,
      });
    }
    const input_set = request.files.map((file) => {
      const buffer = sources[file.id];
      if (!Buffer.isBuffer(buffer)) {
        migration_error("Migration source buffer is missing", {
          file_id: file.id,
        });
      }
      return build_query_input(file, buffer);
    });
    const query_result = run_query_v2(input_set, {
      ...rule.query,
      projection: {
        fields: ["path", "source_path", "raw"],
        missing: "omit",
      },
    });
    const matches = query_result.matches.map((match, index) => {
      const file = request.files.find((entry) => {
        const resolved = path.resolve(entry.path);
        return (
          resolved === path.resolve(match.source_path || entry.path) ||
          entry.id === match.file_id
        );
      });
      return {
        file_id: (file && file.id) || request.files[0].id,
        path: match.path,
        raw: match.raw,
        index,
      };
    });
    const operations = compile_rule_to_operations(rule, matches);
    all_operations.push(...operations);
    estimated_bytes += matches.reduce(
      (total, match) =>
        total + Buffer.byteLength(String(match.raw || ""), "utf8"),
      0,
    );
    if (rule.conflict_query) {
      const conflicts = run_query_v2(input_set, rule.conflict_query);
      conflict_count += conflicts.matches.length;
    }
    rule_reports.push({
      rule_id: rule.id || rule.type,
      type: rule.type,
      match_count: matches.length,
      operation_count: operations.length,
      unsafe_count: 0,
    });
  }

  const report = {
    mode,
    match_count: rule_reports.reduce(
      (total, rule) => total + rule.match_count,
      0,
    ),
    conflict_count,
    estimated_file_count: new Set(
      all_operations.map((op) => op.file || op.source?.file),
    ).size,
    estimated_byte_count: estimated_bytes,
    unsafe_structure_count: 0,
    rules: rule_reports,
  };

  const batches = partition_migration_batches(
    {
      files: request.files,
      operations: all_operations,
    },
    limits,
  );

  return {
    version: 1,
    mode,
    report,
    limits,
    batches,
    operations: all_operations,
    profile_digest: options.profile
      ? canonical_digest(options.profile)
      : request.profile
        ? canonical_digest(request.profile)
        : null,
    source_digest: canonical_digest(
      request.files.map((file) => ({
        id: file.id,
        digest: file.digest || sha256_digest(sources[file.id]),
      })),
    ),
    capability_digest: canonical_digest(list_capabilities(options)),
    written: false,
  };
}

function partition_migration_batches(plan, limits = {}) {
  const bound = default_migration_limits(limits);
  const batches = [];
  let current = {
    batch_id: "batch-0",
    file_ids: new Set(),
    operations: [],
    estimated_bytes: 0,
  };

  function flush() {
    if (current.operations.length === 0) return;
    batches.push({
      batch_id: current.batch_id,
      file_ids: [...current.file_ids].sort(),
      operations: current.operations,
      estimated_bytes: current.estimated_bytes,
    });
    current = {
      batch_id: `batch-${batches.length}`,
      file_ids: new Set(),
      operations: [],
      estimated_bytes: 0,
    };
  }

  for (const operation of plan.operations || []) {
    const file_id = operation.file || operation.source?.file;
    const operation_bytes = Buffer.byteLength(
      JSON.stringify(operation),
      "utf8",
    );
    const next_files = new Set(current.file_ids);
    if (file_id) next_files.add(file_id);
    if (
      current.operations.length > 0 &&
      (next_files.size > bound.max_file_per_batch ||
        current.operations.length + 1 > bound.max_node_per_batch ||
        current.estimated_bytes + operation_bytes > bound.max_byte_per_batch)
    ) {
      flush();
    }
    if (file_id) current.file_ids.add(file_id);
    current.operations.push(operation);
    current.estimated_bytes += operation_bytes;
  }
  flush();
  return batches;
}

function public_participant_file(file) {
  return {
    id: file.id,
    path: file.path,
    digest: file.digest,
    document_count: file.document_count,
    ...(file.identity === undefined ? {} : { identity: file.identity }),
  };
}

async function execute_migration_batch(plan, batch, options = {}) {
  const files = (options.files || plan.files || [])
    .filter((file) => batch.file_ids.includes(file.id))
    .map(public_participant_file);
  const request = {
    version: 1,
    files,
    operations: batch.operations,
  };
  const runtime = {
    ...options,
    sources: options.sources,
    profile: options.profile,
    capability_digest: plan.capability_digest || options.capability_digest,
    tool_version: options.tool_version,
  };
  const result = options.write
    ? await write_transaction(request, runtime)
    : await plan_transaction(request, runtime);
  const manifest = create_transaction_manifest({
    request,
    result: {
      no_op: result.no_op,
      operation_order: result.operation_order,
      files: result.files.map((file, index) => ({
        file_id: file.file_id,
        path: file.path,
        original_digest: file.proof.original_digest,
        candidate_digest: file.proof.candidate_digest,
        no_op: file.proof.no_op,
        proof: file.proof,
        diff: result.diffs[index].structured,
      })),
      validation: result.validation,
      transaction_proof: result.transaction_proof,
      migration_state: {
        batch_id: batch.batch_id,
        global_validation_pending: true,
      },
    },
    profile_digest: plan.profile_digest,
    capability_digest: plan.capability_digest,
    tool_version: options.tool_version || null,
  });
  return {
    batch_id: batch.batch_id,
    no_op: result.no_op,
    written: Boolean(result.written),
    manifest,
    result,
  };
}

function assert_resume_bindings(plan, options = {}) {
  if (
    options.source_digest &&
    plan.source_digest &&
    options.source_digest !== plan.source_digest
  ) {
    throw new Yaml_patch_error(
      "PRECONDITION_FAILED",
      "Migration source digest changed; replan instead of blind resume",
      {
        details: {
          expected: plan.source_digest,
          actual: options.source_digest,
        },
        next_action: "replan the migration against current sources",
      },
    );
  }
  if (
    options.profile_digest &&
    plan.profile_digest &&
    options.profile_digest !== plan.profile_digest
  ) {
    throw new Yaml_patch_error(
      "PRECONDITION_FAILED",
      "Migration profile digest changed; replan instead of blind resume",
      {
        details: {
          expected: plan.profile_digest,
          actual: options.profile_digest,
        },
        next_action: "replan the migration against the current profile",
      },
    );
  }
}

async function resume_migration(plan, options = {}) {
  assert_resume_bindings(plan, options);
  const action = options.action || "continue";
  if (!["retry", "rollback", "continue", "replan"].includes(action)) {
    migration_error(`Unsupported migration resume action: ${action}`);
  }
  if (action === "replan") {
    return plan_migration(options.request || plan.request, options);
  }
  const completed = new Set(options.completed_batch_ids || []);
  const batches = (plan.batches || []).filter((batch) => {
    if (action === "continue") return !completed.has(batch.batch_id);
    if (action === "retry") {
      return (
        batch.batch_id === options.batch_id || !completed.has(batch.batch_id)
      );
    }
    return true;
  });
  const executed = [];
  for (const batch of batches) {
    if (action === "rollback" && batch.batch_id !== options.batch_id) {
      continue;
    }
    const batch_result = await execute_migration_batch(plan, batch, {
      ...options,
      write: action === "rollback" ? false : options.write,
    });
    executed.push(batch_result);
    if (action === "retry" || action === "rollback") break;
  }
  return {
    action,
    batches: executed,
    no_op: executed.every((batch) => batch.no_op),
  };
}

module.exports = {
  MIGRATION_RULE_TYPES,
  compile_rule_to_operations,
  execute_migration_batch,
  partition_migration_batches,
  plan_migration,
  resume_migration,
};
