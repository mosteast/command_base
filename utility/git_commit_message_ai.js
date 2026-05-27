#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");

const { execute_with_adapter } = require("./_ai_cli_utils");

const script_version = "0.1.0";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const default_ai_commit_attempts = Object.freeze([
  Object.freeze({
    label: "codex-cli",
    platform: "codex",
    model: "gpt-5.5",
    reasoning: "low",
  }),
  Object.freeze({
    label: "cursor-cli",
    platform: "cursor-cli",
    model: "composer-2.5-fast",
  }),
  Object.freeze({
    label: "claude-code",
    platform: "claude-code",
    model: "auto",
  }),
]);

function print_help() {
  console.log(`Usage: git_commit_message_ai [options]

Description:
  Generate a concise Git commit message from the currently staged changes.

Options:
  -h, --help        Show this help message and exit.
  -v, --version     Show the version number and exit.
  --debug           Print verbose debug logs.
  --quiet           Print only warnings and errors.

Examples:
  # Generate a commit message from staged changes
  $0

  # Show AI provider attempts
  $0 --debug`);
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
        process.stderr.write(`${GREEN}[INFO]${RESET} ${message}\n`);
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

function collect_staged_change_context(options) {
  const logger = options?.logger || create_logger({});
  logger.debug("Reading staged git status.");
  const status = run_git(["status", "--short"]);

  logger.debug("Reading staged git diff stat.");
  const stat = run_git(["diff", "--cached", "--stat"]);

  logger.debug("Reading staged git diff.");
  const diff = run_git([
    "diff",
    "--cached",
    "--find-renames",
    "--find-copies",
    "--no-ext-diff",
    "--",
  ]);

  if (!stat.trim() && !diff.trim()) {
    throw new Error(
      "No staged changes found for AI commit message generation.",
    );
  }

  return {
    status: truncate_text(status, 20000),
    stat: truncate_text(stat, 20000),
    diff: truncate_text(diff, 120000),
  };
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

function build_commit_message_prompt(change_context) {
  const status = change_context.status?.trim() || "(none)";
  const stat = change_context.stat?.trim() || "(none)";
  const diff = change_context.diff?.trim() || "(none)";

  return [
    "Write a Git commit message for the staged changes below.",
    "",
    "Rules:",
    "- Return exactly one single-line commit message.",
    "- Use concise English imperative mood.",
    "- Do not include markdown, quotes, explanations, prefixes, or code fences.",
    "- Prefer 72 characters or fewer when the change can be summarized clearly.",
    "",
    "## git status --short",
    "```text",
    status,
    "```",
    "",
    "## git diff --cached --stat",
    "```text",
    stat,
    "```",
    "",
    "## git diff --cached",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

async function generate_ai_commit_message(change_context, options) {
  const resolved_options = options || {};
  const logger = resolved_options.logger || create_logger({});
  const attempts = resolved_options.attempts || default_ai_commit_attempts;
  const invoke_adapter =
    resolved_options.invoke_adapter || execute_with_adapter;
  const user_prompt = build_commit_message_prompt(change_context);
  const system_prompt =
    "You are an expert software engineer writing a clean Git commit message.";
  const errors = [];

  for (const attempt of attempts) {
    logger.info(
      `Trying ${attempt.label} for AI commit message (model: ${attempt.model}).`,
    );
    try {
      const raw_output = await invoke_adapter(attempt.platform, {
        model: attempt.model,
        reasoning: attempt.reasoning,
        system_prompt,
        user_prompt,
        temperature: 0.2,
        max_tokens: 120,
        logger,
        disable_fallback: true,
      });
      const message = normalize_commit_message(raw_output);
      if (!message) {
        throw new Error("AI response did not contain a usable commit message");
      }
      return {
        message,
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
    `Failed to generate an AI commit message. Tried ${attempts
      .map((attempt) => attempt.label)
      .join(", ")}. ${errors.join(" | ")}`,
  );
}

function normalize_commit_message(raw_output) {
  let text = typeof raw_output === "string" ? raw_output.trim() : "";
  if (!text) {
    return "";
  }

  text = text.replace(/\r\n/g, "\n");

  const fenced_match = text.match(/^```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```$/u);
  if (fenced_match) {
    text = fenced_match[1].trim();
  }

  const first_line =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) || "";

  text = first_line
    .replace(/^[-*]\s+/u, "")
    .replace(/^git\s+commit\s+-m\s+/iu, "")
    .replace(/\s+/gu, " ")
    .trim();

  text = strip_wrapping_quote(text);
  text = text.replace(/[.]\s*$/u, "").trim();

  return text;
}

function strip_wrapping_quote(text) {
  if (text.length < 2) {
    return text;
  }

  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
  ];
  for (const [open, close] of pairs) {
    if (text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, -close.length).trim();
    }
  }
  return text;
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
  const change_context = collect_staged_change_context({ logger });
  const result = await generate_ai_commit_message(change_context, { logger });
  process.stdout.write(`${result.message}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    const logger = create_logger({});
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  default_ai_commit_attempts,
  build_commit_message_prompt,
  collect_staged_change_context,
  generate_ai_commit_message,
  normalize_commit_message,
  parse_argv,
};
