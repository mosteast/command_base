"use strict";

const fs_sync = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const chalk = require("chalk");
const { globSync } = require("glob");
const yargs = require("yargs/yargs");

const package_json = require("../../package.json");
const { SUPPORTED_EDIT_UNITS } = require("./edit_range");
const {
  exit_code_for_error,
  request_error,
  Yaml_patch_error,
} = require("./error");
const {
  break_stale_edit_package_lock,
  inspect_edit_package_lock,
  load_edit_package,
  write_edit_package,
} = require("./fragment");
const { run_isolated_yaml_action } = require("./isolated");
const { get_yaml_parser_version } = require("./parser");
const { read_bounded_file } = require("./source");
const {
  error_response,
  serialize_response,
  success_response,
} = require("./protocol");
const {
  apply_edit_package,
  break_stale_file_lock,
  break_stale_management_guard,
  get_writer_capabilities,
  inspect_file_lock,
  inspect_management_guard,
} = require("./writer");

const SCRIPT_NAME = "yaml_patch";
const DEFAULT_FIND_RESULT_LIMIT = 1000;
const DEFAULT_FIND_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_JSON_INPUT_BYTES = 1024 * 1024;
const FIND_WORKER_TRANSPORT_OVERHEAD_BYTES = 1024;
const FIND_COUNT_OUTPUT_BYTES = 64 * 1024;
const COMMANDS = new Set([
  "inspect",
  "find",
  "extract",
  "apply",
  "patch",
  "validate",
  "capabilities",
  "lock-info",
  "break-stale-lock",
  "guard-info",
  "break-stale-guard",
  "extract-lock-info",
  "break-stale-extract-lock",
]);

function build_help_text() {
  return [
    chalk.bold("Usage"),
    `  ${SCRIPT_NAME} inspect <file-or-glob...> [--json]`,
    `  ${SCRIPT_NAME} find <file-or-glob...> --query <query.json> [--json]`,
    `  ${SCRIPT_NAME} extract <file> --query <query.json> --output <directory> [options]`,
    `  ${SCRIPT_NAME} apply <session-directory> [--write] [--json]`,
    `  ${SCRIPT_NAME} patch <file> --operations <patch.json> [--write] [--json]`,
    `  ${SCRIPT_NAME} validate <file-or-glob...> [--json]`,
    `  ${SCRIPT_NAME} capabilities [--json]`,
    `  ${SCRIPT_NAME} lock-info <file> [--json]`,
    `  ${SCRIPT_NAME} break-stale-lock <file> --lock-token <token> [--json]`,
    `  ${SCRIPT_NAME} guard-info <file> [--json]`,
    `  ${SCRIPT_NAME} break-stale-guard <file> --lock-token <token> [--json]`,
    `  ${SCRIPT_NAME} extract-lock-info <session-directory> [--json]`,
    `  ${SCRIPT_NAME} break-stale-extract-lock <session-directory> --lock-token <token> [--json]`,
    "",
    chalk.bold("Description"),
    "  Query and patch exact YAML source ranges while preserving every byte outside",
    "  the selected range. Apply and patch are dry-run unless --write is explicit.",
    "",
    chalk.bold("Options"),
    "  --query <file>                 Version 1 JSON query; use - for stdin",
    "  --operations <file>            Version 1 JSON operation document",
    "                                 Use - to read one bounded JSON document from stdin",
    "  --output <directory>            Edit package output directory",
    "  --edit-unit <value>             scalar-token, node-value, or mapping-value",
    "  --ancestor <n>                  Read-only ancestor summaries (default: 3)",
    "  --sibling <n>                   Read-only sibling summaries (default: 2)",
    "  --descendant-depth <n>           Read-only descendant summary depth (default: 0)",
    "  --max-byte <n>                  Maximum extracted target bytes",
    "  --max-character <n>             Maximum extracted target UTF-16 code units",
    "  --max-file-byte <n>             Maximum source file bytes before reading",
    "  --max-result <n>                Maximum find results per page (default: 1000)",
    "  --offset <n>                    Find result offset (default: 0)",
    "  --max-output-byte <n>           Maximum serialized find result bytes (default: 4194304)",
    "  --max-deleted-byte <n>          Maximum deleted bytes",
    "  --max-inserted-byte <n>         Maximum inserted bytes",
    "  --max-touched-byte <n>          Maximum deleted plus inserted bytes",
    "  --lock-token <token>             Token reported by the matching lock-info command",
    "  --refresh                       Replace generated edit-package files (default: false)",
    "  --write                         Atomically write a validated result (default: false)",
    "  -d, --dry-run                   Force preview mode (default: false)",
    "  --json                          Emit the versioned JSON protocol (default: false)",
    "  --quiet                         Print only warnings and errors (default: false)",
    "  --debug                         Print verbose stage and IO logs (default: false)",
    "  -v, --version                   Show version number and exit",
    "  -h, --help                      Show this help message",
    "",
    chalk.bold("Examples"),
    "  # Inspect all YAML files",
    `  $0 inspect "config/**/*.yaml" --json`,
    "",
    "  # Find one exact structural path",
    `  $0 find config.yaml --query query.json --json`,
    "",
    "  # Extract one editable scalar token",
    `  $0 extract config.yaml --query query.json --edit-unit scalar-token --output .yaml_patch/session`,
    "",
    "  # Preview an edited fragment without writing",
    `  $0 apply .yaml_patch/session --json`,
    "",
    "  # Atomically apply an edited fragment",
    `  $0 apply .yaml_patch/session --write --json`,
    "",
    "  # Preview one declarative operation",
    `  $0 patch config.yaml --operations patch.json --json`,
    "",
    "  # Validate YAML files without writing",
    `  $0 validate "config/**/*.yaml" --json`,
    "",
    "  # Report parser and writer capabilities",
    `  $0 capabilities --json`,
    "",
    "  # Inspect and explicitly break a proven stale source lock",
    `  $0 lock-info config.yaml --json`,
    `  $0 break-stale-lock config.yaml --lock-token <token> --json`,
    "",
    "  # Inspect and explicitly break a proven stale lock guard",
    `  $0 guard-info config.yaml --json`,
    `  $0 break-stale-guard config.yaml --lock-token <token> --json`,
    "",
    "  # Inspect and explicitly break a proven stale extract lock",
    `  $0 extract-lock-info .yaml_patch/session --json`,
    `  $0 break-stale-extract-lock .yaml_patch/session --lock-token <token> --json`,
  ].join("\n");
}

function create_argument_parser(args) {
  return yargs(args)
    .scriptName(SCRIPT_NAME)
    .help(false)
    .version(false)
    .exitProcess(false)
    .showHelpOnFail(false)
    .parserConfiguration({
      "camel-case-expansion": false,
      "strip-dashed": false,
      "parse-numbers": false,
    })
    .option("query", { type: "string", requiresArg: true })
    .option("operations", { type: "string", requiresArg: true })
    .option("output", { type: "string" })
    .option("edit-unit", {
      type: "string",
      choices: Array.from(SUPPORTED_EDIT_UNITS),
      default: "node-value",
    })
    .option("ancestor", { type: "number", default: 3 })
    .option("sibling", { type: "number", default: 2 })
    .option("descendant-depth", { type: "number", default: 0 })
    .option("max-byte", { type: "number" })
    .option("max-character", { type: "number" })
    .option("max-file-byte", { type: "number" })
    .option("max-result", {
      type: "number",
      default: DEFAULT_FIND_RESULT_LIMIT,
    })
    .option("offset", { type: "number", default: 0 })
    .option("max-output-byte", {
      type: "number",
      default: DEFAULT_FIND_OUTPUT_BYTES,
    })
    .option("max-deleted-byte", { type: "number" })
    .option("max-inserted-byte", { type: "number" })
    .option("max-touched-byte", { type: "number" })
    .option("lock-token", { type: "string" })
    .option("refresh", { type: "boolean", default: false })
    .option("write", { type: "boolean", default: false })
    .option("dry-run", { alias: "d", type: "boolean", default: false })
    .option("json", { type: "boolean", default: false })
    .option("quiet", { type: "boolean", default: false })
    .option("debug", { type: "boolean", default: false })
    .option("version", { alias: "v", type: "boolean", default: false })
    .option("help", { alias: "h", type: "boolean", default: false })
    .strict()
    .fail((message, error) => {
      throw request_error(
        message || (error && error.message) || "Invalid command arguments",
      );
    });
}

function create_logger(argv, io) {
  return {
    stdin: io.stdin || process.stdin,
    debug(message) {
      if (argv.debug) io.stderr.write(`${chalk.cyan(`[DEBUG] ${message}`)}\n`);
    },
    info(message) {
      if (!argv.quiet) io.stderr.write(`${message}\n`);
    },
  };
}

async function read_bounded_stdin(stream, max_bytes) {
  const chunks = [];
  let total_bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total_bytes += buffer.length;
    if (total_bytes > max_bytes) {
      throw request_error(`JSON stdin exceeds ${max_bytes} bytes`, {
        details: { max_bytes, actual_bytes: total_bytes },
      });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total_bytes);
}

function stable_sort_paths(file_paths) {
  return file_paths.sort((left, right) =>
    left === right ? 0 : left < right ? -1 : 1,
  );
}

function expand_patterns(patterns, options = {}) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw request_error(
      "At least one source path or glob pattern is required",
      { recoverable: true, next_action: "provide a source path or glob" },
    );
  }
  const matches = new Set();
  for (const pattern of patterns) {
    const literal_path = path.resolve(String(pattern));
    if (fs_sync.existsSync(literal_path)) {
      matches.add(literal_path);
      continue;
    }
    for (const match of globSync(String(pattern), {
      absolute: true,
      nodir: !options.directories,
      windowsPathsNoEscape: true,
    })) {
      matches.add(path.resolve(match));
    }
  }
  if (matches.size === 0) {
    throw new Yaml_patch_error("NO_MATCH", "Patterns matched no paths", {
      recoverable: true,
      next_action: "inspect the pattern and path spelling",
      details: { patterns },
    });
  }
  return stable_sort_paths(Array.from(matches));
}

async function read_json_file(file_path, logger, label) {
  if (!file_path) {
    throw request_error(`${label} file is required`);
  }
  if (file_path === "-") {
    logger.debug(`io: read ${label} stdin`);
    try {
      const buffer = await read_bounded_stdin(
        logger.stdin,
        DEFAULT_JSON_INPUT_BYTES,
      );
      const json_text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer,
      );
      return JSON.parse(json_text);
    } catch (error) {
      throw request_error(`Cannot read ${label} JSON from stdin`, {
        cause: error,
        details: { source: "stdin" },
      });
    }
  }
  const resolved_path = path.resolve(file_path);
  logger.debug(`io: read ${label} ${resolved_path}`);
  try {
    const file = await read_bounded_file(resolved_path, {
      max_file_bytes: 1024 * 1024,
      allow_symbolic_link: false,
      file_type_error_code: "REQUEST_ERROR",
      limit_error_code: "REQUEST_ERROR",
      changed_error_code: "REQUEST_ERROR",
    });
    const json_text = new TextDecoder("utf-8", { fatal: true }).decode(
      file.buffer,
    );
    return JSON.parse(json_text);
  } catch (error) {
    throw request_error(`Cannot read ${label} JSON: ${resolved_path}`, {
      cause: error,
      details: { path: resolved_path },
    });
  }
}

async function run_isolated_file_action(
  action,
  file_path,
  payload,
  argv,
  logger,
) {
  logger.debug(`io: stat and read source ${file_path} in isolated worker`);
  logger.debug(`stage: ${action} YAML in bounded worker ${file_path}`);
  return run_isolated_yaml_action(action, {
    file_path,
    max_file_bytes: argv["max-file-byte"],
    ...payload,
  });
}

function public_entry(entry, source_path) {
  return {
    source_path,
    locator: entry.locator,
    document: entry.document,
    path: entry.path,
    node_type: entry.node_type,
    source: {
      line: entry.source.line,
      column: entry.source.column,
      start_byte: entry.source.start_byte,
      end_byte: entry.source.end_byte,
    },
    raw_digest: entry.raw_digest,
    size_bytes: entry.size_bytes,
    size_characters: entry.size_characters,
    tag: entry.tag,
    anchor: entry.anchor,
    alias: entry.alias,
  };
}

function public_patch_result(result) {
  return {
    no_op: result.no_op,
    written: result.written,
    dry_run: result.dry_run,
    candidate_digest: result.candidate_digest,
    summary: result.summary,
    proof: result.proof,
    text_diff: result.text_diff,
    guarantees: result.guarantees,
  };
}

async function run_inspect(patterns, argv, logger) {
  const file_paths = expand_patterns(patterns);
  const items = [];
  for (const file_path of file_paths) {
    items.push(
      await run_isolated_file_action("inspect", file_path, {}, argv, logger),
    );
  }
  return { items };
}

async function run_find(patterns, argv, logger) {
  const query = await read_json_file(argv.query, logger, "query");
  const result_limit = Number(argv["max-result"]);
  const result_offset = Number(argv.offset);
  const max_output_bytes = Number(argv["max-output-byte"]);
  if (!Number.isInteger(result_limit) || result_limit <= 0) {
    throw request_error("--max-result must be a positive integer");
  }
  if (!Number.isInteger(result_offset) || result_offset < 0) {
    throw request_error("--offset must be a non-negative integer");
  }
  if (!Number.isInteger(max_output_bytes) || max_output_bytes <= 0) {
    throw request_error("--max-output-byte must be a positive integer");
  }
  const matches = [];
  let total_match_count = 0;
  let remaining_results = result_limit;
  let remaining_offset = result_offset;
  for (const file_path of expand_patterns(patterns)) {
    const partial_result = create_find_result(
      matches,
      total_match_count,
      result_offset,
    );
    const partial_output_bytes = Buffer.byteLength(
      JSON.stringify(partial_result),
      "utf8",
    );
    const remaining_output_bytes = max_output_bytes - partial_output_bytes;
    if (remaining_output_bytes <= 0 && remaining_results > 0) {
      throw find_output_limit_error(
        partial_output_bytes,
        max_output_bytes,
        result_limit,
      );
    }
    const page = await run_isolated_file_action(
      "find",
      file_path,
      {
        query,
        result_offset: remaining_offset,
        result_limit: remaining_results,
        max_output_bytes:
          remaining_results === 0
            ? FIND_COUNT_OUTPUT_BYTES
            : remaining_output_bytes + FIND_WORKER_TRANSPORT_OVERHEAD_BYTES,
      },
      argv,
      logger,
    );
    const candidate_total_match_count =
      total_match_count + page.total_match_count;
    const candidate_matches = matches.concat(page.matches);
    const candidate_result = create_find_result(
      candidate_matches,
      candidate_total_match_count,
      result_offset,
    );
    const candidate_output_bytes = Buffer.byteLength(
      JSON.stringify(candidate_result),
      "utf8",
    );
    const candidate_remaining_results = Math.max(
      0,
      remaining_results - page.matches.length,
    );
    if (
      candidate_output_bytes > max_output_bytes &&
      candidate_remaining_results > 0
    ) {
      throw find_output_limit_error(
        candidate_output_bytes,
        max_output_bytes,
        result_limit,
      );
    }
    total_match_count = candidate_total_match_count;
    matches.push(...page.matches);
    remaining_results = candidate_remaining_results;
    remaining_offset = Math.max(0, remaining_offset - page.total_match_count);
  }
  if (total_match_count === 0) {
    throw new Yaml_patch_error("NO_MATCH", "Query matched no YAML nodes", {
      recoverable: true,
      next_action: "inspect the source and refine the exact query",
    });
  }
  const result = create_find_result(matches, total_match_count, result_offset);
  const output_bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (output_bytes > max_output_bytes) {
    throw find_output_limit_error(output_bytes, max_output_bytes, result_limit);
  }
  return result;
}

function create_find_result(matches, total_match_count, result_offset) {
  const next_offset =
    result_offset + matches.length < total_match_count
      ? result_offset + matches.length
      : null;
  return {
    match_count: matches.length,
    total_match_count,
    offset: result_offset,
    next_offset,
    matches,
  };
}

function find_output_limit_error(output_bytes, max_output_bytes, result_limit) {
  return new Yaml_patch_error(
    "CHANGE_LIMIT_EXCEEDED",
    `Find result requires ${output_bytes} bytes, exceeding ${max_output_bytes}`,
    {
      recoverable: true,
      next_action: "reduce --max-result or increase --max-output-byte",
      details: { output_bytes, max_output_bytes, result_limit },
    },
  );
}

function extract_limits(argv) {
  const limits = {};
  if (argv["max-deleted-byte"] !== undefined) {
    limits.max_deleted_bytes = Number(argv["max-deleted-byte"]);
  }
  if (argv["max-inserted-byte"] !== undefined) {
    limits.max_inserted_bytes = Number(argv["max-inserted-byte"]);
  }
  if (argv["max-touched-byte"] !== undefined) {
    limits.max_touched_bytes = Number(argv["max-touched-byte"]);
  }
  return limits;
}

async function run_extract(patterns, argv, logger) {
  const [file_path, ...extra_paths] = expand_patterns(patterns);
  if (extra_paths.length > 0) {
    throw new Yaml_patch_error(
      "AMBIGUOUS_MATCH",
      "extract requires exactly one source file",
    );
  }
  if (!argv.output) {
    throw request_error("extract requires --output");
  }
  const query = await read_json_file(argv.query, logger, "query");
  logger.debug(`stage: resolve ${argv["edit-unit"]} boundary`);
  const edit_package = await run_isolated_file_action(
    "extract",
    file_path,
    {
      query,
      extract_options: {
        edit_unit: argv["edit-unit"],
        ancestors: Number(argv.ancestor),
        siblings: Number(argv.sibling),
        descendants_depth: Number(argv["descendant-depth"]),
        max_bytes:
          argv["max-byte"] === undefined ? undefined : Number(argv["max-byte"]),
        max_characters:
          argv["max-character"] === undefined
            ? undefined
            : Number(argv["max-character"]),
        limits: extract_limits(argv),
      },
    },
    argv,
    logger,
  );
  edit_package.fragment_buffer = Buffer.from(edit_package.fragment_buffer);
  logger.debug(`io: write edit package ${path.resolve(argv.output)}`);
  const paths = await write_edit_package(edit_package, argv.output, {
    refresh: argv.refresh,
  });
  return {
    ...paths,
    target: edit_package.manifest.target,
    source_digest: edit_package.manifest.source.digest,
  };
}

async function run_apply(patterns, argv, logger) {
  const [session_path, ...extra_paths] = expand_patterns(patterns, {
    directories: true,
  });
  if (extra_paths.length > 0) {
    throw new Yaml_patch_error(
      "AMBIGUOUS_MATCH",
      "apply requires exactly one edit package",
    );
  }
  logger.debug(`io: load edit package ${session_path}`);
  const edit_package = await load_edit_package(session_path);
  const write = Boolean(argv.write && !argv["dry-run"]);
  logger.debug(
    `stage: ${write ? "validate and atomically write" : "dry-run apply"}`,
  );
  const result = await apply_edit_package(edit_package, {
    write,
    debug: logger.debug,
  });
  return public_patch_result(result);
}

async function run_patch(patterns, argv, logger) {
  const [file_path, ...extra_paths] = expand_patterns(patterns);
  if (extra_paths.length > 0) {
    throw new Yaml_patch_error(
      "AMBIGUOUS_MATCH",
      "patch requires exactly one source file",
    );
  }
  const patch_document = await read_json_file(
    argv.operations,
    logger,
    "operations",
  );
  logger.debug("stage: compile declarative operation");
  const edit_package = await run_isolated_file_action(
    "prepare_operation",
    file_path,
    { patch_document },
    argv,
    logger,
  );
  edit_package.fragment_buffer = Buffer.from(edit_package.fragment_buffer);
  const write = Boolean(argv.write && !argv["dry-run"]);
  logger.debug(
    `stage: ${write ? "validate and atomically write" : "dry-run patch"}`,
  );
  const result = await apply_edit_package(edit_package, {
    write,
    debug: logger.debug,
  });
  return public_patch_result(result);
}

async function run_validate(patterns, argv, logger) {
  const items = [];
  for (const file_path of expand_patterns(patterns)) {
    items.push(
      await run_isolated_file_action("validate", file_path, {}, argv, logger),
    );
  }
  return { items };
}

function resolve_single_source_path(patterns, command) {
  const [file_path, ...extra_paths] = expand_patterns(patterns);
  if (extra_paths.length > 0) {
    throw new Yaml_patch_error(
      "AMBIGUOUS_MATCH",
      `${command} requires exactly one source file`,
    );
  }
  return file_path;
}

async function run_lock_info(patterns, logger) {
  const file_path = resolve_single_source_path(patterns, "lock-info");
  logger.debug(`io: read cooperative lock for ${file_path}`);
  return inspect_file_lock(file_path);
}

async function run_break_stale_lock(patterns, argv, logger) {
  const file_path = resolve_single_source_path(patterns, "break-stale-lock");
  if (!argv["lock-token"]) {
    throw request_error(
      "break-stale-lock requires --lock-token from lock-info",
    );
  }
  logger.debug(`stage: verify stale cooperative lock for ${file_path}`);
  logger.debug(`io: remove token-matched stale lock for ${file_path}`);
  return break_stale_file_lock(file_path, {
    expected_token: argv["lock-token"],
  });
}

async function run_guard_info(patterns, logger) {
  const file_path = resolve_single_source_path(patterns, "guard-info");
  logger.debug(`io: read lock management guard for ${file_path}`);
  return inspect_management_guard(file_path);
}

async function run_break_stale_guard(patterns, argv, logger) {
  const file_path = resolve_single_source_path(patterns, "break-stale-guard");
  if (!argv["lock-token"]) {
    throw request_error(
      "break-stale-guard requires --lock-token from guard-info",
    );
  }
  logger.debug(`stage: verify stale lock management guard for ${file_path}`);
  logger.debug(`io: remove token-matched stale guard for ${file_path}`);
  return break_stale_management_guard(file_path, {
    expected_token: argv["lock-token"],
  });
}

function resolve_single_edit_package_path(patterns, command) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw request_error(`${command} requires an edit-package path`);
  }
  if (patterns.length !== 1) {
    throw new Yaml_patch_error(
      "AMBIGUOUS_MATCH",
      `${command} requires exactly one edit-package path`,
    );
  }
  const pattern = String(patterns[0]);
  const literal_path = path.resolve(pattern);
  if (fs_sync.existsSync(literal_path)) return literal_path;
  const matches = stable_sort_paths(
    globSync(pattern, {
      absolute: true,
      nodir: false,
      windowsPathsNoEscape: true,
    }).map((match) => path.resolve(match)),
  );
  if (matches.length > 1) {
    throw new Yaml_patch_error(
      "AMBIGUOUS_MATCH",
      `${command} matched more than one edit-package path`,
      { details: { matches } },
    );
  }
  return matches[0] || literal_path;
}

async function run_extract_lock_info(patterns, logger) {
  const output_directory = resolve_single_edit_package_path(
    patterns,
    "extract-lock-info",
  );
  logger.debug(`io: read extract lock for ${output_directory}`);
  return inspect_edit_package_lock(output_directory);
}

async function run_break_stale_extract_lock(patterns, argv, logger) {
  const output_directory = resolve_single_edit_package_path(
    patterns,
    "break-stale-extract-lock",
  );
  if (!argv["lock-token"]) {
    throw request_error(
      "break-stale-extract-lock requires --lock-token from extract-lock-info",
    );
  }
  logger.debug(`stage: verify stale extract lock for ${output_directory}`);
  logger.debug(
    `io: remove token-matched stale extract lock for ${output_directory}`,
  );
  return break_stale_edit_package_lock(output_directory, {
    expected_token: argv["lock-token"],
  });
}

function run_capabilities() {
  return {
    protocol_version: 1,
    tool_version: package_json.version,
    parser_version: get_yaml_parser_version(),
    parser_isolation: {
      cli: true,
      wall_timeout: true,
      memory_limit: true,
      node_depth_limit: true,
    },
    query_version: 1,
    find_limits: {
      default_result_limit: DEFAULT_FIND_RESULT_LIMIT,
      default_output_bytes: DEFAULT_FIND_OUTPUT_BYTES,
      pagination: true,
    },
    manifest_version: 1,
    operation_version: 1,
    edit_units: Array.from(SUPPORTED_EDIT_UNITS),
    operations: [
      "replace_scalar_token",
      "replace_node_value",
      "set_mapping_value",
    ],
    lock_commands: [
      "lock-info",
      "break-stale-lock",
      "guard-info",
      "break-stale-guard",
      "extract-lock-info",
      "break-stale-extract-lock",
    ],
    writer: get_writer_capabilities(),
  };
}

async function dispatch_command(command, patterns, argv, logger) {
  if (command === "inspect") return run_inspect(patterns, argv, logger);
  if (command === "find") return run_find(patterns, argv, logger);
  if (command === "extract") return run_extract(patterns, argv, logger);
  if (command === "apply") return run_apply(patterns, argv, logger);
  if (command === "patch") return run_patch(patterns, argv, logger);
  if (command === "validate") return run_validate(patterns, argv, logger);
  if (command === "capabilities") return run_capabilities();
  if (command === "lock-info") return run_lock_info(patterns, logger);
  if (command === "guard-info") return run_guard_info(patterns, logger);
  if (command === "extract-lock-info") {
    return run_extract_lock_info(patterns, logger);
  }
  if (command === "break-stale-lock") {
    return run_break_stale_lock(patterns, argv, logger);
  }
  if (command === "break-stale-guard") {
    return run_break_stale_guard(patterns, argv, logger);
  }
  if (command === "break-stale-extract-lock") {
    return run_break_stale_extract_lock(patterns, argv, logger);
  }
  throw request_error(`Unknown command: ${command}`);
}

async function run_cli(args = process.argv.slice(2), io = process) {
  try {
    const argv = create_argument_parser(args).parse();
    if (argv.version) {
      io.stdout.write(`${package_json.version}\n`);
      return 0;
    }
    if (args.length === 0 || argv.help) {
      io.stdout.write(`${build_help_text()}\n`);
      return 0;
    }
    const stdin_json_inputs = [argv.query, argv.operations].filter(
      (value) => value === "-",
    );
    if (stdin_json_inputs.length > 1) {
      throw request_error("Only one JSON input may read from stdin");
    }
    const [command_value, ...pattern_values] = argv._.map(String);
    if (!COMMANDS.has(command_value)) {
      throw request_error(`Unknown command: ${command_value || "<none>"}`);
    }
    const logger = create_logger(argv, io);
    const result = await dispatch_command(
      command_value,
      pattern_values,
      argv,
      logger,
    );
    io.stdout.write(serialize_response(success_response(result)));
    return 0;
  } catch (error) {
    const response = error_response(error);
    io.stdout.write(serialize_response(response));
    return exit_code_for_error(response);
  }
}

module.exports = {
  build_help_text,
  create_argument_parser,
  dispatch_command,
  expand_patterns,
  public_entry,
  public_patch_result,
  run_cli,
};
