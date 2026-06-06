#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const readline = require("readline");

const { execute_with_adapter } = require("./_ai_cli_utils");
const {
  default_ai_commit_attempts,
  generate_ai_commit_message,
  normalize_commit_message,
} = require("./git_commit_message_ai");

const script_version = "0.1.0";

const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function print_help() {
  console.log(`Usage: git_smart_commit_ai [options]

Description:
  Inspect the current changes, ask AI whether they should be split into
  multiple logical commits, then create one commit per group. Changes are
  grouped at the file level. Pushing is left to the caller.

Options:
  -h, --help        Show this help message and exit.
  -v, --version     Show the version number and exit.
  --debug           Print verbose debug logs.
  --quiet           Print only warnings and errors.
  -d, --dry-run     Print the planned commits without creating them.
  --single          Plan exactly one commit for all changes (no splitting),
                    using the AI commit message generator.
  --confirm         Print the plan and review it interactively before
                    committing. Supports partial accept/reject with
                    regeneration of the rejected commits (see Confirm grammar).

Confirm grammar (with --confirm):
  The prompt shows [Y/n/help]; type 'help' to print this grammar.
  y (or Enter) Accept every planned commit (Enter defaults to accept all).
  y 1 3        Accept only commits 1 and 3; regenerate the rest.
  y 2-4 6 8    Accept commits 2-4, 6 and 8; regenerate the rest.
  n            Reject every commit and regenerate the whole plan.
  n 2-4 6 8    Reject commits 2-4, 6 and 8 (keep the rest) and regenerate
               only the rejected files.

Output:
  Prints the number of commits created to stdout (logs go to stderr).

Examples:
  # Split current changes into logical commits
  $0

  # Plan a single commit with an AI-generated message
  $0 --single

  # Preview the split plan without committing
  $0 --dry-run

  # Review the plan interactively and confirm before committing
  $0 --confirm`);
}

function print_version() {
  console.log(script_version);
}

function create_logger(options) {
  const debug_enabled = Boolean(options?.debug);
  const quiet = Boolean(options?.quiet);

  return {
    error(message) {
      process.stderr.write(`${RED}[ERROR]${RESET} ${message}\n`);
    },
    warn(message) {
      process.stderr.write(`${YELLOW}[WARN]${RESET} ${message}\n`);
    },
    info(message) {
      if (!quiet) {
        process.stderr.write(`\n${message}\n`);
      }
    },
    debug(message) {
      if (debug_enabled && !quiet) {
        process.stderr.write(`${BLUE}[DEBUG]${RESET} ${message}\n`);
      }
    },
  };
}

function parse_argv(argv) {
  const options = {
    debug: false,
    quiet: false,
    dry_run: false,
    single: false,
    confirm: false,
  };

  for (const arg of argv) {
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-v":
      case "--version":
        options.version = true;
        break;
      case "--debug":
        options.debug = true;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "-d":
      case "--dry-run":
        options.dry_run = true;
        break;
      case "--single":
        options.single = true;
        break;
      case "--confirm":
        options.confirm = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  return options;
}

function run_git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function git_has_head() {
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (error) {
    return false;
  }
}

function verify_git_repository() {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch (error) {
    throw new Error("This command must be run inside a Git repository.");
  }
}

function truncate_text(text, max_length) {
  const safe_text = typeof text === "string" ? text : "";
  if (safe_text.length <= max_length) {
    return safe_text;
  }
  return `${safe_text.slice(0, max_length)}\n\n[truncated ${
    safe_text.length - max_length
  } characters]`;
}

function parse_porcelain_status(output) {
  const tokens = (typeof output === "string" ? output : "")
    .split("\0")
    .filter((token) => token.length > 0);

  const display_paths = [];
  const expansion = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (entry.length < 3) {
      continue;
    }
    const status = entry.slice(0, 2);
    const display_path = entry.slice(3);
    let actual_paths = [display_path];

    if (status[0] === "R" || status[0] === "C") {
      const original_path = tokens[index + 1];
      index += 1;
      if (original_path) {
        actual_paths = [display_path, original_path];
      }
    }

    display_paths.push(display_path);
    expansion[display_path] = actual_paths;
  }

  return { display_paths, expansion };
}

function collect_change_context(options) {
  const cached = Boolean(options?.cached);
  const logger = options?.logger || create_logger({});
  const paths = Array.isArray(options?.paths)
    ? options.paths.filter((entry) => typeof entry === "string" && entry.length)
    : [];
  const path_args = paths.length ? ["--", ...paths] : [];
  const diff_path_args = paths.length ? ["--", ...paths] : ["--"];

  logger.debug("Reading git status.");
  const status = run_git(["status", "--short", ...path_args]);

  let stat;
  let diff;
  if (cached) {
    logger.debug("Reading staged git diff stat.");
    stat = run_git(["diff", "--cached", "--stat", ...path_args]);
    logger.debug("Reading staged git diff.");
    diff = run_git([
      "diff",
      "--cached",
      "--find-renames",
      "--find-copies",
      "--no-ext-diff",
      ...diff_path_args,
    ]);
  } else {
    const base = git_has_head() ? ["HEAD"] : [];
    logger.debug("Reading working tree git diff stat.");
    stat = run_git(["diff", ...base, "--stat", ...path_args]);
    logger.debug("Reading working tree git diff.");
    diff = run_git([
      "diff",
      ...base,
      "--find-renames",
      "--find-copies",
      "--no-ext-diff",
      ...diff_path_args,
    ]);
  }

  return {
    status: truncate_text(status, 20000),
    stat: truncate_text(stat, 20000),
    diff: truncate_text(diff, 120000),
  };
}

function build_smart_commit_prompt(change_context, changed_paths) {
  const status = change_context.status?.trim() || "(none)";
  const stat = change_context.stat?.trim() || "(none)";
  const diff = change_context.diff?.trim() || "(none)";
  const files = (changed_paths || []).map((path) => `- ${path}`).join("\n");

  return [
    "Group the changed files below into one or more Git commits.",
    "",
    "Analysis order:",
    "- First compare the actual git diff, then decide groups and write messages.",
    "- Base grouping and messages on changed lines and hunks, not only file names or status.",
    "- Do not include your analysis process in the JSON output.",
    "",
    "Decide whether the changes need to be split:",
    "- Only split when the files address clearly independent concerns",
    "  (for example an unrelated bug fix mixed with a new feature).",
    "- If the changes serve a single coherent purpose, return exactly one group.",
    "",
    "Output rules:",
    "- Return ONLY a JSON object. No prose, no markdown, no code fences.",
    '- Shape: {"groups": [{"message": "...", "files": ["path", ...]}, ...]}.',
    "- Assign every changed file to exactly one group.",
    "- Use the exact file paths listed under '## changed files'.",
    "- Do not invent, rename, or omit any path.",
    "",
    "Commit message rules (the 'message' field of each group):",
    "- Start with a concise English imperative subject line.",
    "- If a group has one clear purpose, use only the subject line.",
    "- If a group serves multiple purposes, add a blank line then summarize",
    "  each purpose as a top-level '- ...' bullet.",
    "- Use '-' for every bullet and two spaces for nested bullet indentation.",
    "- Prefer 72 characters or fewer for the subject line.",
    "- Encode newlines inside the JSON string with \\n.",
    "",
    "## changed files",
    files || "(none)",
    "",
    "## git status --short",
    "```text",
    status,
    "```",
    "",
    "## git diff --stat",
    "```text",
    stat,
    "```",
    "",
    "## git diff",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

function extract_json_object(raw_output) {
  let text = typeof raw_output === "string" ? raw_output.trim() : "";
  if (!text) {
    return "";
  }

  text = text.replace(/\r\n/g, "\n");

  const fenced_match = text.match(/^```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```$/u);
  if (fenced_match) {
    text = fenced_match[1].trim();
  }

  if (text.startsWith("{") && text.endsWith("}")) {
    return text;
  }

  const first_brace = text.indexOf("{");
  const last_brace = text.lastIndexOf("}");
  if (first_brace !== -1 && last_brace !== -1 && last_brace > first_brace) {
    return text.slice(first_brace, last_brace + 1);
  }

  return text;
}

function parse_smart_commit_plan(raw_output, changed_paths) {
  const json_text = extract_json_object(raw_output);
  if (!json_text) {
    throw new Error("AI response did not contain a usable JSON plan.");
  }

  let parsed;
  try {
    parsed = JSON.parse(json_text);
  } catch (error) {
    throw new Error(`Failed to parse AI plan as JSON: ${error.message}`);
  }

  if (!parsed || !Array.isArray(parsed.groups) || parsed.groups.length === 0) {
    throw new Error("AI plan must contain a non-empty 'groups' array.");
  }

  const expected_paths = new Set(changed_paths || []);
  const assigned_paths = new Set();
  const groups = [];

  for (const raw_group of parsed.groups) {
    if (!raw_group || typeof raw_group !== "object") {
      throw new Error("Each group must be an object.");
    }
    if (!Array.isArray(raw_group.files) || raw_group.files.length === 0) {
      throw new Error("Each group must list at least one file.");
    }

    const message = normalize_commit_message(raw_group.message);
    if (!message) {
      throw new Error("Each group must provide a usable commit message.");
    }

    const files = [];
    for (const file of raw_group.files) {
      if (typeof file !== "string" || file.length === 0) {
        throw new Error("Each file entry must be a non-empty string.");
      }
      if (!expected_paths.has(file)) {
        throw new Error(`Plan references an unknown path: ${file}`);
      }
      if (assigned_paths.has(file)) {
        throw new Error(`Plan assigns a path to multiple groups: ${file}`);
      }
      assigned_paths.add(file);
      files.push(file);
    }

    groups.push({ message, files });
  }

  if (assigned_paths.size !== expected_paths.size) {
    const missing = [...expected_paths].filter(
      (path) => !assigned_paths.has(path),
    );
    throw new Error(
      `Plan does not cover every changed file. Missing: ${missing.join(", ")}`,
    );
  }

  return { groups };
}

async function generate_smart_commit_plan(
  change_context,
  changed_paths,
  options,
) {
  const resolved_options = options || {};
  const logger = resolved_options.logger || create_logger({});
  const attempts = resolved_options.attempts || default_ai_commit_attempts;
  const invoke_adapter =
    resolved_options.invoke_adapter || execute_with_adapter;
  const user_prompt = build_smart_commit_prompt(change_context, changed_paths);
  const system_prompt =
    "You are an expert software engineer organizing changes into clean, " +
    "logically separated Git commits. You always respond with valid JSON.";
  const errors = [];

  for (const attempt of attempts) {
    logger.info(
      `Trying ${attempt.label} for the commit split plan (model: ${attempt.model})...`,
    );
    try {
      const raw_output = await invoke_adapter(attempt.platform, {
        model: attempt.model,
        reasoning: attempt.reasoning,
        system_prompt,
        user_prompt,
        temperature: 0.2,
        max_tokens: 1500,
        logger,
        disable_fallback: true,
      });
      const plan = parse_smart_commit_plan(raw_output, changed_paths);
      return {
        ...plan,
        platform: attempt.platform,
        model: attempt.model,
        label: attempt.label,
      };
    } catch (error) {
      const error_message =
        error instanceof Error ? error.message : String(error);
      errors.push(`${attempt.label}: ${error_message}`);
      logger.warn(`${attempt.label} failed: ${error_message}`);
    }
  }

  throw new Error(
    `Failed to generate a commit split plan. Tried ${attempts
      .map((attempt) => attempt.label)
      .join(", ")}. ${errors.join(" | ")}`,
  );
}

async function resolve_commit_plan(change_context, changed_paths, options) {
  const resolved_options = options || {};
  const logger = resolved_options.logger || create_logger({});

  try {
    return await generate_smart_commit_plan(
      change_context,
      changed_paths,
      resolved_options,
    );
  } catch (error) {
    const error_message =
      error instanceof Error ? error.message : String(error);
    logger.warn(
      `Falling back to a single commit; split planning failed: ${error_message}`,
    );
    const fallback = await generate_ai_commit_message(change_context, {
      logger,
      invoke_adapter: resolved_options.invoke_adapter,
      attempts: resolved_options.attempts,
    });
    return {
      groups: [{ message: fallback.message, files: [...changed_paths] }],
      fallback: true,
    };
  }
}

async function resolve_single_commit_plan(
  change_context,
  changed_paths,
  options,
) {
  const resolved_options = options || {};
  const logger = resolved_options.logger || create_logger({});

  const result = await generate_ai_commit_message(change_context, {
    logger,
    invoke_adapter: resolved_options.invoke_adapter,
    attempts: resolved_options.attempts,
  });

  return {
    groups: [{ message: result.message, files: [...changed_paths] }],
    platform: result.platform,
    model: result.model,
    label: result.label,
    single: true,
  };
}

function expand_group_paths(files, expansion) {
  const seen = new Set();
  const expanded = [];
  for (const file of files) {
    const actual_paths = expansion?.[file] || [file];
    for (const actual_path of actual_paths) {
      if (!seen.has(actual_path)) {
        seen.add(actual_path);
        expanded.push(actual_path);
      }
    }
  }
  return expanded;
}

function log_plan_preview(plan, logger) {
  const total = plan.groups.length;
  if (total === 1) {
    if (plan.single) {
      logger.info("Planning a single commit with an AI-generated message.");
    } else {
      logger.info("Splitting not recommended; planning a single commit.");
    }
  } else {
    logger.info(`Planning ${total} commits.`);
  }

  plan.groups.forEach((group, index) => {
    process.stderr.write(`  commit ${index + 1}/${total}:\n`);
    for (const line of group.message.split("\n")) {
      process.stderr.write(`    | ${line}\n`);
    }
    process.stderr.write(`    files:\n`);
    for (const file of group.files) {
      process.stderr.write(`      - ${file}\n`);
    }
  });
}

function create_line_reader() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: false,
  });

  const queued_lines = [];
  const pending_waiters = [];
  let stream_closed = false;

  rl.on("line", (line) => {
    const waiter = pending_waiters.shift();
    if (waiter) {
      waiter(line);
    } else {
      queued_lines.push(line);
    }
  });
  rl.on("close", () => {
    stream_closed = true;
    while (pending_waiters.length > 0) {
      pending_waiters.shift()(null);
    }
  });

  return {
    ask(prompt_text) {
      if (prompt_text) {
        process.stderr.write(prompt_text);
      }
      if (queued_lines.length > 0) {
        return Promise.resolve(queued_lines.shift());
      }
      if (stream_closed) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        pending_waiters.push(resolve);
      });
    },
    close() {
      rl.close();
    },
  };
}

function build_selection_prompt() {
  return "\nSelection [Y/n/help]: ";
}

function build_selection_help(total) {
  return [
    "",
    `Respond for the ${total} planned commit(s):`,
    "  y (or Enter) accept all",
    "  y 1 3        accept only commits 1 and 3, regenerate the rest",
    "  y 2-4 6 8    accept commits 2-4, 6 and 8, regenerate the rest",
    "  n            reject all and regenerate",
    "  n 2-4 6 8    reject commits 2-4, 6 and 8, keep the rest, regenerate the rejected",
    "  help         show this help",
    "",
  ].join("\n");
}

function parse_confirm_selection(input, total) {
  const raw = (input || "").trim();

  const all_indices = [];
  for (let index = 1; index <= total; index += 1) {
    all_indices.push(index);
  }

  if (!raw) {
    return { ok: true, verb: "y", accepted: all_indices, rejected: [] };
  }

  const parts = raw.split(/\s+/u);
  const head = parts[0].toLowerCase();

  if (head === "help" || head === "h" || head === "?") {
    return { ok: true, help: true };
  }

  let verb;
  if (head === "y" || head === "yes") {
    verb = "y";
  } else if (head === "n" || head === "no") {
    verb = "n";
  } else {
    return {
      ok: false,
      error: `Unknown response: "${parts[0]}". Start with 'y' to accept or 'n' to reject.`,
    };
  }

  const spec_tokens = parts.slice(1);
  let selected;
  if (spec_tokens.length === 0) {
    selected = new Set(all_indices);
  } else {
    selected = new Set();
    for (const token of spec_tokens) {
      const match = token.match(/^(\d+)(?:-(\d+))?$/u);
      if (!match) {
        return {
          ok: false,
          error: `Invalid selection token: "${token}". Use numbers like 1 or ranges like 2-4.`,
        };
      }
      const start = Number(match[1]);
      const end = match[2] !== undefined ? Number(match[2]) : start;
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      if (low < 1 || high > total) {
        return {
          ok: false,
          error: `Selection out of range: "${token}". Valid range is 1-${total}.`,
        };
      }
      for (let index = low; index <= high; index += 1) {
        selected.add(index);
      }
    }
  }

  let accepted;
  let rejected;
  if (verb === "y") {
    accepted = all_indices.filter((index) => selected.has(index));
    rejected = all_indices.filter((index) => !selected.has(index));
  } else {
    rejected = all_indices.filter((index) => selected.has(index));
    accepted = all_indices.filter((index) => !selected.has(index));
  }

  return { ok: true, verb, accepted, rejected };
}

async function prompt_selection(reader, total, logger) {
  for (;;) {
    const answer = await reader.ask(build_selection_prompt());
    if (answer === null) {
      return null;
    }
    const parsed = parse_confirm_selection(answer, total);
    if (parsed.help) {
      process.stderr.write(build_selection_help(total));
      continue;
    }
    if (parsed.ok) {
      return parsed;
    }
    logger.warn(parsed.error);
  }
}

function commit_group(group, expansion, total) {
  if (total === 1) {
    run_git(["commit", "-m", group.message]);
    return;
  }
  commit_group_paths(group, expansion);
}

function commit_group_paths(group, expansion) {
  const paths = expand_group_paths(group.files, expansion);
  run_git(["commit", "-m", group.message, "--", ...paths]);
}

async function resolve_plan_for_paths(change_context, changed_paths, options) {
  const resolved_options = options || {};
  if (resolved_options.single) {
    return resolve_single_commit_plan(
      change_context,
      changed_paths,
      resolved_options,
    );
  }
  return resolve_commit_plan(change_context, changed_paths, resolved_options);
}

async function run_confirm_loop(context) {
  const { display_paths, expansion, options, logger } = context;
  const invoke_adapter = options.invoke_adapter || execute_with_adapter;

  const reader = create_line_reader();

  let remaining = [...display_paths];
  let committed = 0;
  let round = 0;

  try {
    while (remaining.length > 0) {
      round += 1;
      if (round > 1) {
        logger.info(
          `Regenerating a plan for the ${remaining.length} remaining file(s)...`,
        );
      }

      const pathspec = expand_group_paths(remaining, expansion);
      const change_context = collect_change_context({
        cached: true,
        logger,
        paths: pathspec,
      });

      const plan = await resolve_plan_for_paths(change_context, remaining, {
        logger,
        invoke_adapter,
        single: options.single,
      });

      log_plan_preview(plan, logger);

      const total = plan.groups.length;
      const selection = await prompt_selection(reader, total, logger);

      if (selection === null) {
        logger.warn(
          `Input closed; leaving ${remaining.length} file(s) uncommitted.`,
        );
        break;
      }

      for (const index of selection.accepted) {
        const group = plan.groups[index - 1];
        commit_group_paths(group, expansion);
        committed += 1;
        const subject = group.message.split("\n", 1)[0];
        logger.info(`Created commit ${committed}: ${subject}`);
      }

      if (selection.rejected.length === 0) {
        remaining = [];
        continue;
      }

      const next_paths = new Set();
      for (const index of selection.rejected) {
        for (const file of plan.groups[index - 1].files) {
          next_paths.add(file);
        }
      }
      remaining = [...next_paths];

      if (selection.accepted.length === 0) {
        logger.info(
          `Rejected all commit(s); regenerating ${remaining.length} file(s).`,
        );
      } else {
        logger.info(
          `Accepted ${selection.accepted.length} commit(s); regenerating the rejected ${remaining.length} file(s).`,
        );
      }
    }
  } finally {
    reader.close();
  }

  return committed;
}

async function main(argv) {
  const options = parse_argv(argv);
  if (options.help) {
    print_help();
    return;
  }
  if (options.version) {
    print_version();
    return;
  }

  const logger = create_logger(options);
  verify_git_repository();

  if (!options.dry_run) {
    logger.debug("Staging all changes.");
    run_git(["add", "--all"]);
  }

  const { display_paths, expansion } = parse_porcelain_status(
    run_git(["status", "--porcelain", "-z"]),
  );

  if (display_paths.length === 0) {
    logger.info("No changes detected; nothing to commit.");
    process.stdout.write("0\n");
    return;
  }

  if (options.confirm && !options.dry_run) {
    const committed = await run_confirm_loop({
      display_paths,
      expansion,
      options,
      logger,
    });
    process.stdout.write(`${committed}\n`);
    return;
  }

  const change_context = collect_change_context({
    cached: !options.dry_run,
    logger,
  });

  const plan = await resolve_plan_for_paths(change_context, display_paths, {
    logger,
    invoke_adapter: execute_with_adapter,
    single: options.single,
  });

  log_plan_preview(plan, logger);

  const total = plan.groups.length;

  if (options.dry_run) {
    plan.groups.forEach((group, index) => {
      const subject = group.message.split("\n", 1)[0];
      if (total === 1) {
        logger.info(`Dry run: git commit -m ${JSON.stringify(subject)}`);
      } else {
        const paths = expand_group_paths(group.files, expansion);
        logger.info(
          `Dry run: git commit -m ${JSON.stringify(subject)} -- ${paths.join(
            " ",
          )}`,
        );
      }
      void index;
    });
    process.stdout.write(`${total}\n`);
    return;
  }

  let count = 0;
  for (const group of plan.groups) {
    commit_group(group, expansion, total);
    count += 1;
    logger.info(`Created commit ${count}/${total}.`);
  }

  process.stdout.write(`${count}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    const logger = create_logger({});
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  build_smart_commit_prompt,
  collect_change_context,
  expand_group_paths,
  extract_json_object,
  generate_smart_commit_plan,
  parse_argv,
  parse_confirm_selection,
  parse_porcelain_status,
  parse_smart_commit_plan,
  resolve_commit_plan,
  resolve_single_commit_plan,
};
