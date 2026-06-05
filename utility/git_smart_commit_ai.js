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
  --confirm         Print the plan and ask for confirmation before committing.

Output:
  Prints the number of commits created to stdout (logs go to stderr).

Examples:
  # Split current changes into logical commits
  $0

  # Preview the split plan without committing
  $0 --dry-run

  # Ask for confirmation before committing
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

  logger.debug("Reading git status.");
  const status = run_git(["status", "--short"]);

  let stat;
  let diff;
  if (cached) {
    logger.debug("Reading staged git diff stat.");
    stat = run_git(["diff", "--cached", "--stat"]);
    logger.debug("Reading staged git diff.");
    diff = run_git([
      "diff",
      "--cached",
      "--find-renames",
      "--find-copies",
      "--no-ext-diff",
      "--",
    ]);
  } else {
    const base = git_has_head() ? ["HEAD"] : [];
    logger.debug("Reading working tree git diff stat.");
    stat = run_git(["diff", ...base, "--stat"]);
    logger.debug("Reading working tree git diff.");
    diff = run_git([
      "diff",
      ...base,
      "--find-renames",
      "--find-copies",
      "--no-ext-diff",
      "--",
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
    logger.info("Splitting not recommended; planning a single commit.");
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

function prompt_yes_no(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/iu.test((answer || "").trim()));
    });
  });
}

function commit_group(group, expansion, total) {
  if (total === 1) {
    run_git(["commit", "-m", group.message]);
    return;
  }
  const paths = expand_group_paths(group.files, expansion);
  run_git(["commit", "-m", group.message, "--", ...paths]);
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

  const change_context = collect_change_context({
    cached: !options.dry_run,
    logger,
  });

  const plan = await resolve_commit_plan(change_context, display_paths, {
    logger,
    invoke_adapter: execute_with_adapter,
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

  if (options.confirm) {
    const subject = total === 1 ? "this commit" : `these ${total} commits`;
    const approved = await prompt_yes_no(`Proceed with ${subject}? [y/N] `);
    if (!approved) {
      logger.warn("Aborted by user; no commits created.");
      process.stdout.write("0\n");
      return;
    }
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
  parse_porcelain_status,
  parse_smart_commit_plan,
  resolve_commit_plan,
};
