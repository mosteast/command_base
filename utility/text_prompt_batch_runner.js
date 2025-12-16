"use strict";

const path = require("path");
const yargs_factory = require("yargs/yargs");

const {
  default_ai_platform,
  supported_ai_platforms,
  ensure_prompt_source,
  expand_patterns,
  file_has_content,
  run_ai_command,
} = require("./_ai_cli_utils");

async function run_text_prompt_batch_cli(raw_config) {
  const { default: chalk } = await import("chalk");

  if (typeof chalk.level === "number" && chalk.level === 0) {
    chalk.level = 1;
  }

  const config = normalize_config(raw_config);
  const package_info = load_package_info();
  const command_name = config.command_name;

  const parser = build_cli_parser({ command_name, package_info, config });
  const argv = parser.parse();

  if (argv.help) {
    render_help({ command_name, package_info, config, chalk });
    return { status: "help" };
  }

  if (argv.version) {
    show_version({ package_info });
    return { status: "version" };
  }

  const logger = create_logger({
    chalk,
    command_name,
    is_debug: Boolean(argv.debug),
    is_quiet: Boolean(argv.quiet),
  });

  logger.debug("Resolved arguments:", sanitize_arguments_for_debug(argv));

  const positional_patterns = Array.isArray(argv._) ? argv._ : [];

  if (positional_patterns.length === 0) {
    logger.error(
      chalk.red("No files provided. Supply at least one file or glob."),
    );
    render_help({ command_name, package_info, config, chalk });
    process.exitCode = 1;
    return { status: "missing-input" };
  }

  const resolved_input_files = expand_patterns(positional_patterns, {
    cwd: process.cwd(),
  });

  if (resolved_input_files.length === 0) {
    logger.warn(
      `No files matched the provided patterns (${positional_patterns.join(", ")}).`,
    );
    return { status: "no-matches" };
  }

  const repo_root_path = config.repo_root_path;

  const prompt_file_path = await ensure_prompt_source(config.prompt_name, {
    repo_root: repo_root_path,
    external_path: config.prompt_external_path,
    logger,
  });

  const dry_run_mode = Boolean(argv["dry-run"]);
  const refresh_outputs = Boolean(argv.refresh);

  const requested_batch_size = Number(argv["batch-size"]);
  const batch_size = validate_integer_option({
    provided_value: requested_batch_size,
    fallback_value: config.default_batch_size,
    minimum: 1,
    option_name: "--batch-size",
    logger,
  });

  const requested_retry_count = Number(argv.retries);
  const max_retry_count = validate_integer_option({
    provided_value: requested_retry_count,
    fallback_value: config.default_retry_count,
    minimum: 1,
    option_name: "--retries",
    logger,
  });

  const job_entries = [];

  for (const absolute_input_path of resolved_input_files) {
    const relative_input_path =
      path.relative(process.cwd(), absolute_input_path) ||
      path.basename(absolute_input_path);

    const output_file_path = config.build_output_path(absolute_input_path);

    const normalized_input_path = absolute_input_path.toLowerCase();

    let should_skip = false;
    let skip_reason = null;

    if (
      config.generated_suffixes.some((suffix) =>
        normalized_input_path.endsWith(suffix),
      )
    ) {
      should_skip = true;
      skip_reason = config.generated_file_skip_reason;
    }

    if (!should_skip && !refresh_outputs) {
      const output_has_content = await file_has_content(output_file_path);
      if (output_has_content) {
        should_skip = true;
        skip_reason = config.existing_output_skip_reason;
      }
    }

    const job_context = {
      absolute_input_path,
      relative_input_path,
      output_file_path,
    };

    if (!should_skip && typeof config.should_skip_job === "function") {
      const skip_outcome = await config.should_skip_job(job_context, argv);
      if (skip_outcome) {
        should_skip = true;
        skip_reason = skip_outcome.reason || config.custom_skip_reason;
      }
    }

    job_entries.push({
      ...job_context,
      should_skip,
      skip_reason,
    });
  }

  const pending_jobs = job_entries.filter((entry) => !entry.should_skip);
  const skipped_jobs = job_entries.filter((entry) => entry.should_skip);

  if (skipped_jobs.length > 0 && !argv.quiet) {
    logger.info(
      `Skipping ${skipped_jobs.length} file${
        skipped_jobs.length === 1 ? "" : "s"
      } before ${config.job_noun}:`,
    );
    for (const job of skipped_jobs) {
      const suffix = job.skip_reason ? ` (${job.skip_reason})` : "";
      console.log(chalk.gray(`  - ${job.relative_input_path}${suffix}`));
    }
  }

  if (pending_jobs.length === 0) {
    logger.info(`No files require ${config.job_noun}; outputs are up to date.`);
    return {
      status: "done",
      processed: 0,
      skipped: skipped_jobs.length,
      failed: 0,
    };
  }

  logger.info(
    `Preparing ${config.job_noun} for ${pending_jobs.length} file${
      pending_jobs.length === 1 ? "" : "s"
    } with batch size ${batch_size}${dry_run_mode ? " (dry-run)" : ""}.`,
  );

  let processed_count = 0;
  let failed_count = 0;
  let total_attempt_count = 0;
  let retry_attempt_count = 0;
  let simulated_count = 0;

  const should_retry_error = (error) => {
    const raw_message =
      (error && typeof error.message === "string" && error.message.length > 0
        ? error.message
        : null) || String(error);

    const message = raw_message.toLowerCase();

    const non_retryable_markers = [
      "insufficient_quota",
      "invalid_api_key",
      "incorrect_api_key",
      "unauthorized",
      "authentication",
      "failed to deserialize overridden config",
      "unknown variant",
      "unexpected argument",
      "unsupported ai platform",
    ];

    return !non_retryable_markers.some((marker) => message.includes(marker));
  };

  const run_with_retries = async (operation, context_message) => {
    let attempt = 0;
    let last_error = null;
    while (attempt < max_retry_count) {
      attempt += 1;
      total_attempt_count += 1;
      try {
        return await operation();
      } catch (error) {
        last_error = error;
        if (!should_retry_error(error)) {
          logger.warn(
            `${context_message} attempt ${attempt} failed with a non-retryable error: ${
              error.message || String(error)
            }.`,
          );
          throw error;
        }
        if (attempt < max_retry_count) {
          retry_attempt_count += 1;
          logger.warn(
            `${context_message} attempt ${attempt} failed: ${
              error.message || String(error)
            }. Retrying...`,
          );
        }
      }
    }
    throw last_error;
  };

  const process_job = async (job) => {
    if (!argv.quiet) {
      console.log(
        chalk.cyan(
          `- ${config.present_progress_label}: ${job.relative_input_path}`,
        ),
      );
    }

    if (dry_run_mode) {
      simulated_count += 1;
      if (!argv.quiet) {
        console.log(
          chalk.yellow(`  ↳ Dry run: would write to ${job.output_file_path}`),
        );
      }
      processed_count += 1;
      return;
    }

    try {
      await run_with_retries(
        async () =>
          run_ai_command({
            prompt_file: prompt_file_path,
            input_file: job.absolute_input_path,
            output_file: job.output_file_path,
            repo_root: repo_root_path,
            platform: argv["ai-platform"],
            model: argv["ai-model"],
            temperature: argv["ai-temperature"],
            max_tokens: argv["ai-max-tokens"],
            extra_context: await build_extra_context(config, job, argv),
            postprocess_output: config.postprocess_output,
            logger,
          }),
        `${config.job_title} for ${job.relative_input_path}`,
      );

      const relative_output_path =
        path.relative(process.cwd(), job.output_file_path) ||
        path.basename(job.output_file_path);
      if (!argv.quiet) {
        console.log(chalk.green(`  ↳ Saved: ${relative_output_path}`));
      }
      processed_count += 1;
    } catch (error) {
      failed_count += 1;
      const error_message = error.message || String(error);
      console.error(chalk.red(`  ↳ Failed: ${job.relative_input_path}`));
      console.error(chalk.red(error_message));
      if (error_message.toLowerCase().includes("insufficient_quota")) {
        console.error(
          chalk.yellow(
            "  ↳ Hint: API quota exceeded. Add billing/credits or switch provider via --ai-platform (codex|openrouter|gemini|openai).",
          ),
        );
      }
    }
  };

  for (let index = 0; index < pending_jobs.length; index += batch_size) {
    const batch = pending_jobs.slice(index, index + batch_size);
    await Promise.all(batch.map((job) => process_job(job)));
  }

  const summary_fragments = [];
  if (processed_count) {
    summary_fragments.push(
      chalk.green(`${processed_count} ${config.past_tense_summary_label}`),
    );
  }
  if (simulated_count) {
    summary_fragments.push(chalk.yellow(`${simulated_count} simulated`));
  }
  if (skipped_jobs.length) {
    summary_fragments.push(chalk.gray(`${skipped_jobs.length} skipped`));
  }
  if (failed_count) {
    summary_fragments.push(chalk.red(`${failed_count} failed`));
  }

  if (!argv.quiet) {
    console.log(
      chalk.blue(`Done (${summary_fragments.join(", ") || "no actions"}).`),
    );
  }

  const stats_fragments = [
    chalk.blueBright(`total: ${job_entries.length}`),
    chalk.cyanBright(`pending: ${pending_jobs.length}`),
    chalk.gray(`skipped: ${skipped_jobs.length}`),
    chalk.yellowBright(`attempts: ${total_attempt_count}`),
    chalk.magentaBright(`retries: ${retry_attempt_count}`),
    chalk.greenBright(`succeeded: ${processed_count}`),
    dry_run_mode ? chalk.yellowBright(`dry-run: ${simulated_count}`) : null,
    chalk.redBright(`failed: ${failed_count}`),
  ].filter(Boolean);

  logger.info(
    `Statistics => ${stats_fragments.map(strip_ansi_codes).join(", ")}`,
  );
  if (!argv.quiet) {
    console.log(
      chalk.magenta("Statistics"),
      stats_fragments.join(chalk.white(" | ")),
    );
  }

  if (failed_count > 0) {
    process.exitCode = 1;
  }

  return {
    status: "done",
    processed: processed_count,
    skipped: skipped_jobs.length,
    failed: failed_count,
    simulated: simulated_count,
  };
}

function normalize_config(raw_config) {
  if (!raw_config || typeof raw_config !== "object") {
    throw new Error(
      "run_text_prompt_batch_cli requires a configuration object",
    );
  }

  const command_name =
    raw_config.command_name ||
    path.basename(process.argv[1] || "text_prompt_batch");

  const description_lines = Array.isArray(raw_config.description_lines)
    ? raw_config.description_lines
    : [
        String(
          raw_config.description || "Process text files with an AI prompt.",
        ),
      ];

  const job_title = raw_config.job_title || "Processing";
  const job_noun = raw_config.job_noun || "processing";
  const present_progress_label =
    raw_config.present_progress_label || "Processing";
  const past_tense_summary_label =
    raw_config.past_tense_summary_label || "processed";

  const output_suffix = raw_config.output_suffix || ".processed.txt";
  const generated_suffixes = Array.isArray(raw_config.generated_suffixes)
    ? raw_config.generated_suffixes.slice()
    : [output_suffix];

  const build_output_path =
    typeof raw_config.build_output_path === "function"
      ? raw_config.build_output_path
      : (input_path) => {
          const parsed_path = path.parse(input_path);
          return path.join(
            parsed_path.dir,
            `${parsed_path.base}${output_suffix}`,
          );
        };

  const prompt_name = raw_config.prompt_name;
  if (!prompt_name) {
    throw new Error("Configuration must include prompt_name");
  }

  return {
    command_name,
    description_lines,
    job_title,
    job_noun,
    present_progress_label,
    past_tense_summary_label,
    output_suffix,
    generated_suffixes: generated_suffixes.map((suffix) =>
      suffix.toLowerCase(),
    ),
    generated_file_skip_reason:
      raw_config.generated_file_skip_reason || "already processed",
    existing_output_skip_reason:
      raw_config.existing_output_skip_reason || "existing output",
    custom_skip_reason: raw_config.custom_skip_reason || "skipped",
    prompt_name,
    prompt_external_path: raw_config.prompt_external_path,
    repo_root_path: raw_config.repo_root_path || path.resolve(__dirname, ".."),
    default_batch_size: Number.isFinite(raw_config.default_batch_size)
      ? raw_config.default_batch_size
      : 5,
    default_retry_count: Number.isFinite(raw_config.default_retry_count)
      ? raw_config.default_retry_count
      : 3,
    build_output_path,
    should_skip_job: raw_config.should_skip_job,
    create_extra_context: raw_config.create_extra_context,
    postprocess_output: raw_config.postprocess_output,
    examples: Array.isArray(raw_config.examples) ? raw_config.examples : [],
  };
}

function load_package_info() {
  try {
    return require(path.resolve(__dirname, "..", "package.json"));
  } catch (error) {
    return { version: "0.0.0" };
  }
}

function build_cli_parser({ command_name, package_info, config }) {
  const terminal_width = Math.min(120, process.stdout.columns || 120);

  return yargs_factory(process.argv.slice(2))
    .scriptName(command_name)
    .usage("Usage: $0 [options] <file|glob ...>")
    .wrap(terminal_width)
    .help(false)
    .version(false)
    .option("help", {
      alias: "h",
      type: "boolean",
      describe: "Show help",
      default: false,
    })
    .option("version", {
      alias: "v",
      type: "boolean",
      describe: "Show version",
      default: false,
    })
    .option("debug", {
      type: "boolean",
      describe: "Enable verbose logging",
      default: false,
    })
    .option("quiet", {
      type: "boolean",
      describe: "Suppress informational output",
      default: false,
    })
    .option("dry-run", {
      alias: "d",
      type: "boolean",
      describe: "Preview actions without writing",
      default: false,
    })
    .option("refresh", {
      alias: "r",
      type: "boolean",
      default: false,
      describe: "Regenerate outputs even if they already exist",
    })
    .option("ai-platform", {
      type: "string",
      default: default_ai_platform,
      choices: supported_ai_platforms,
      describe: "AI platform adapter",
    })
    .option("ai-model", {
      type: "string",
      describe: "Override model for the selected platform",
    })
    .option("ai-temperature", {
      type: "number",
      describe: "Sampling temperature for the AI request",
    })
    .option("ai-max-tokens", {
      type: "number",
      describe: "Maximum tokens for the AI response",
    })
    .option("batch-size", {
      alias: "b",
      type: "number",
      default: config.default_batch_size,
      describe: "Number of files to process concurrently",
    })
    .option("retries", {
      alias: "R",
      type: "number",
      default: config.default_retry_count,
      describe: "Maximum attempts per file on failure",
    })
    .strict(false)
    .parserConfiguration({
      "short-option-groups": true,
      "camel-case-expansion": false,
      "strip-aliased": true,
      "populate--": true,
    })
    .fail((message, error) => {
      if (error) {
        throw error;
      }
      if (message) {
        console.error(message);
      }
    });
}

function render_help({ command_name, package_info, config, chalk }) {
  const description_lines = config.description_lines;
  const option_docs = build_option_docs({ config, chalk });
  const example_lines = build_example_lines({
    command_name,
    examples: config.examples,
    chalk,
  });

  const lines = [];
  lines.push(chalk.bold("Usage"));
  lines.push(`  ${chalk.cyan(`${command_name} [options] <file|glob ...>`)}`);
  lines.push("");
  lines.push(chalk.bold("Description"));
  for (const line of description_lines) {
    lines.push(`  ${chalk.white(line)}`);
  }
  lines.push("");
  lines.push(chalk.bold("Options"));
  lines.push(...option_docs);
  lines.push("");
  lines.push(chalk.bold("Examples"));
  if (example_lines.length > 0) {
    lines.push(...example_lines);
  } else {
    lines.push(`  ${chalk.gray("# Summarize files matching patterns")}`);
    lines.push(`  ${chalk.white("$0 notes/**/*.md")}`);
  }
  lines.push("");
  lines.push(chalk.gray(`${command_name} v${package_info.version || "0.0.0"}`));

  console.log(lines.join("\n"));
}

function build_option_docs({ config, chalk }) {
  const docs = [
    {
      flag: "-h, --help",
      description: "Show this help message and exit (default: false)",
    },
    {
      flag: "-v, --version",
      description: "Print the tool version and exit (default: false)",
    },
    {
      flag: "--debug",
      description:
        "Enable verbose debug logging for troubleshooting (default: false)",
    },
    {
      flag: "--quiet",
      description:
        "Suppress informational output; only warnings and errors remain (default: false)",
    },
    {
      flag: "-d, --dry-run",
      description:
        "Preview actions without invoking the AI or writing files (default: false)",
    },
    {
      flag: "-r, --refresh",
      description:
        "Rebuild outputs even when destination files already exist (default: false)",
    },
    {
      flag: "--ai-platform <name>",
      description: `AI platform adapter to use. Supported: ${supported_ai_platforms.join(", ")}. (default: ${default_ai_platform})`,
    },
    {
      flag: "--ai-model <id>",
      description: "Override the default model for the chosen AI platform.",
    },
    {
      flag: "--ai-temperature <number>",
      description:
        "Sampling temperature forwarded to the AI adapter when supported.",
    },
    {
      flag: "--ai-max-tokens <number>",
      description:
        "Maximum response tokens forwarded to the AI adapter when supported.",
    },
    {
      flag: "-b, --batch-size <n>",
      description: `Maximum number of files to process concurrently (default: ${config.default_batch_size}).`,
    },
    {
      flag: "-R, --retries <n>",
      description: `Maximum attempts per file when API calls fail (default: ${config.default_retry_count}).`,
    },
  ];

  const max_width = docs.reduce(
    (width, entry) => Math.max(width, entry.flag.length),
    0,
  );

  return docs.map((entry) => {
    const padded_flag = entry.flag.padEnd(max_width);
    return `  ${chalk.cyan(padded_flag)}  ${chalk.white(entry.description)}`;
  });
}

function build_example_lines({ command_name, examples, chalk }) {
  if (!Array.isArray(examples) || examples.length === 0) {
    return [];
  }
  const lines = [];
  examples.forEach((example, index) => {
    const command = (example.command || "").replace(/\$0/g, command_name);
    const description = example.description || "Example";
    lines.push(`  ${chalk.gray(`# ${description}`)}`);
    lines.push(`  ${chalk.white(command)}`);
    if (index < examples.length - 1) {
      lines.push("");
    }
  });
  return lines;
}

function show_version({ package_info }) {
  console.log(package_info.version || "0.0.0");
}

function create_logger({ chalk, command_name, is_debug, is_quiet }) {
  const prefix = chalk.magenta(`[${command_name}]`);
  const debug_prefix = chalk.magenta("[debug]");

  return {
    info: (...messages) => {
      if (!is_quiet) {
        console.log(prefix, chalk.cyan(format_messages(messages)));
      }
    },
    warn: (...messages) => {
      console.warn(prefix, chalk.yellow(format_messages(messages)));
    },
    error: (...messages) => {
      console.error(prefix, chalk.red(format_messages(messages)));
    },
    debug: (...messages) => {
      if (is_debug && !is_quiet) {
        console.log(debug_prefix, ...messages);
      }
    },
  };
}

function format_messages(messages) {
  return messages
    .map((message) =>
      typeof message === "string" ? message : JSON.stringify(message),
    )
    .join(" ");
}

function sanitize_arguments_for_debug(argv) {
  const sanitized = { ...argv };
  if (Array.isArray(sanitized._)) {
    sanitized._ = sanitized._.slice();
  }
  delete sanitized["$0"];
  delete sanitized.help;
  delete sanitized.version;
  return sanitized;
}

function validate_integer_option({
  provided_value,
  fallback_value,
  minimum,
  option_name,
  logger,
}) {
  if (Number.isFinite(provided_value) && provided_value >= minimum) {
    return Math.floor(provided_value);
  }
  logger.warn(
    `${option_name} expects an integer >= ${minimum}; falling back to ${fallback_value}.`,
  );
  return fallback_value;
}

async function build_extra_context(config, job, argv) {
  if (typeof config.create_extra_context !== "function") {
    return undefined;
  }
  return config.create_extra_context(job, argv);
}

function strip_ansi_codes(value) {
  const string_value = String(value || "");
  return string_value.replace(/\u001B\[[0-9;]*m/g, "");
}

module.exports = {
  run_text_prompt_batch_cli,
};
