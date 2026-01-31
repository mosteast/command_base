const { readFile, writeFile, mkdir, stat } = require("fs/promises");
const path = require("path");
const { globSync } = require("glob");
const chalk = require("chalk");
const yargs = require("yargs");

const { extract_leaf_levels } = require("./leaf_extract");

const package_json = require("../package.json");

const STDIN_SENTINEL = "-";

function normalize_extension(extension_text, default_extension) {
  if (!extension_text) return default_extension;
  return extension_text.startsWith(".")
    ? extension_text
    : `.${extension_text}`;
}

function strip_bom(text) {
  if (!text) return text;
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function create_logger({ quiet_mode, debug_mode, command_label, use_stderr }) {
  const prefix = chalk.dim(command_label);
  const info_writer = use_stderr ? console.error : console.log;
  const warn_writer = use_stderr ? console.error : console.warn;
  const error_writer = console.error;

  function format_message(message) {
    return `${prefix} ${message}`;
  }

  return {
    info(message) {
      if (quiet_mode) return;
      info_writer(format_message(chalk.green(message)));
    },
    warn(message) {
      warn_writer(format_message(chalk.yellow(message)));
    },
    error(message, error) {
      error_writer(format_message(chalk.red(message)));
      if (debug_mode && error) {
        error_writer(chalk.red(error.stack || String(error)));
      }
    },
    debug(message) {
      if (!debug_mode || quiet_mode) return;
      info_writer(format_message(chalk.cyan(`[debug] ${message}`)));
    },
  };
}

function build_help_text(config) {
  const script_name = config.script_name;
  const sample_glob = config.sample_glob || "data/**/*";

  return [
    `${chalk.bold("Usage")}`,
    `  ${script_name} [options] <patterns...>`,
    `  ${script_name} -                                  # Read from stdin`,
    "",
    `${chalk.bold("Description")}`,
    `  Extract leaf-level slices from ${config.format_label} trees.`,
    "  Level 1 outputs leaves only; level 2 outputs parents + leaves;",
    "  higher levels include more ancestors from each leaf path.",
    "",
    `${chalk.bold("Options")}`,
    "  -l, --level <n>        Leaf depth to extract (default: 1)",
    "  --children-key <key>   Children key in tree nodes (default: children)",
    "  --value-key <key>      Value key for primitive nodes (default: value)",
    "  -o, --out <dir>        Output directory (defaults to source directory)",
    `  -e, --extension <ext>  Output extension (default: ${config.default_extension})`,
    "                         Output name: <base>.leaves.<level><ext>",
    "  -i, --indent <n>       Output indent (default: 2)",
    "  -F, --force            Overwrite existing files (default: false)",
    "  --refresh              Reprocess output files (default: false)",
    "  -d, --dry-run          Preview actions without writing files",
    "  --quiet                Print only warnings and errors",
    "  --debug                Show detailed debug output",
    "  -v, --version          Show version number and exit",
    "  -h, --help             Show help message",
    "",
    `${chalk.bold("Examples")}`,
    `  # Extract leaves (level 1) from every tree`,
    `  ${script_name} "${sample_glob}"`,
    "",
    `  # Extract level 2 nodes into the output directory`,
    `  ${script_name} --level 2 --out output "${sample_glob}"`,
    "",
    `  # Use custom children/value keys`,
    `  ${script_name} --children-key nodes --value-key label "${sample_glob}"`,
    "",
    `  # Dry run to preview outputs`,
    `  ${script_name} --dry-run "${sample_glob}"`,
  ].join("\n");
}

function parse_cli_arguments(config) {
  const parser = yargs(process.argv.slice(2))
    .scriptName(config.script_name)
    .help(false)
    .version(false)
    .parserConfiguration({
      "camel-case-expansion": false,
      "strip-dashed": false,
    })
    .option("level", {
      alias: "l",
      type: "number",
      default: 1,
      describe: "Leaf depth to extract",
    })
    .option("children-key", {
      type: "string",
      describe: "Children key in tree nodes",
    })
    .option("value-key", {
      type: "string",
      describe: "Value key for primitive nodes",
    })
    .option("out", {
      alias: "o",
      type: "string",
      describe: "Output directory (defaults to source directory)",
    })
    .option("extension", {
      alias: "e",
      type: "string",
      describe: "Output extension",
    })
    .option("indent", {
      alias: "i",
      type: "number",
      default: 2,
      describe: "Output indent",
    })
    .option("force", {
      alias: "F",
      type: "boolean",
      default: false,
      describe: "Overwrite existing files",
    })
    .option("refresh", {
      type: "boolean",
      default: false,
      describe: "Reprocess output files",
    })
    .option("dry-run", {
      alias: "d",
      type: "boolean",
      default: false,
      describe: "Preview actions without writing files",
    })
    .option("quiet", {
      type: "boolean",
      default: false,
      describe: "Print only warnings and errors",
    })
    .option("debug", {
      type: "boolean",
      default: false,
      describe: "Show detailed debug output",
    })
    .option("version", {
      alias: "v",
      type: "boolean",
      describe: "Show version number and exit",
    })
    .option("help", {
      alias: "h",
      type: "boolean",
      describe: "Show help message",
    })
    .strict(false)
    .usage(build_help_text(config))
    .wrap(Math.min(yargs.terminalWidth(), 100));

  const argv = parser.parse();

  if (argv.help) {
    console.log(build_help_text(config));
    process.exit(0);
  }

  if (argv.version) {
    console.log(package_json.version);
    process.exit(0);
  }

  const patterns = (argv._ || []).map(String);

  const parsed_level = Number(argv.level);
  const level =
    Number.isFinite(parsed_level) && parsed_level >= 1
      ? Math.floor(parsed_level)
      : 1;

  return {
    patterns,
    level,
    children_key: argv["children-key"],
    value_key: argv["value-key"],
    output_directory: argv.out ? path.resolve(argv.out) : "",
    output_extension: normalize_extension(argv.extension, config.default_extension),
    indent: Number.isFinite(argv.indent) && argv.indent >= 0 ? argv.indent : 2,
    force_overwrite: Boolean(argv.force || argv.refresh),
    refresh_mode: Boolean(argv.refresh),
    dry_run: Boolean(argv["dry-run"]),
    quiet_mode: Boolean(argv.quiet),
    debug_mode: Boolean(argv.debug),
  };
}

function is_stdin_mode(patterns) {
  if (patterns.length === 0) return true;
  if (patterns.length === 1 && patterns[0] === STDIN_SENTINEL) return true;
  return false;
}

function expand_patterns(patterns, logger) {
  const resolved_paths = new Set();

  for (const pattern of patterns) {
    if (pattern === STDIN_SENTINEL) continue;

    logger.debug(`Expanding pattern: ${pattern}`);
    const matches = globSync(pattern, {
      nodir: true,
      absolute: true,
      windowsPathsNoEscape: true,
    });

    if (matches.length === 0) {
      logger.debug(`Pattern ${pattern} matched no files; using literal path.`);
      resolved_paths.add(path.resolve(pattern));
      continue;
    }

    for (const match of matches) {
      resolved_paths.add(path.resolve(match));
    }
  }

  return Array.from(resolved_paths);
}

async function file_exists(file_path) {
  try {
    await stat(file_path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function is_regular_file(file_path) {
  try {
    const stats = await stat(file_path);
    return stats.isFile();
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

function build_output_extension_with_level(output_extension, level) {
  const safe_extension = output_extension.startsWith(".")
    ? output_extension
    : `.${output_extension}`;
  return `.leaves.${level}${safe_extension}`;
}

function build_output_path_with_level(input_path, output_directory, output_extension, level) {
  const source_directory = path.dirname(input_path);
  const target_directory = output_directory || source_directory;
  const base_name = path.basename(input_path, path.extname(input_path));
  const level_suffix = build_output_extension_with_level(output_extension, level);
  return path.join(target_directory, `${base_name}${level_suffix}`);
}

function is_output_file(input_path, output_extension, refresh_mode) {
  if (refresh_mode) return false;
  const safe_extension = output_extension.startsWith(".")
    ? output_extension
    : `.${output_extension}`;
  const escaped_extension = safe_extension.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
  const output_regex = new RegExp(`\\\\.leaves\\\\.\\\\d+${escaped_extension}$`);
  return output_regex.test(input_path);
}

async function read_stdin(logger) {
  if (process.stdin.isTTY) {
    logger.error("No input detected on stdin", null);
    process.exit(1);
  }

  const input_chunks = [];
  for await (const chunk of process.stdin) {
    input_chunks.push(chunk);
  }

  return input_chunks.join("");
}

function ensure_trailing_newline(text) {
  if (!text) return "\n";
  return text.endsWith("\n") ? text : `${text}\n`;
}

async function convert_stdin(options, config) {
  const logger = create_logger({
    quiet_mode: options.quiet_mode,
    debug_mode: options.debug_mode,
    command_label: config.script_name,
    use_stderr: true,
  });

  try {
    logger.debug("Reading stdin input.");
    const input_text = await read_stdin(logger);
    const cleaned_text = strip_bom(input_text || "");
    if (!cleaned_text.trim()) {
      logger.error("Received empty stdin input", null);
      process.exit(1);
    }

    logger.debug("Parsing input.");
    const parsed_data = config.parse_text(cleaned_text);

    logger.debug("Extracting leaf levels.");
    const { output_data } = extract_leaf_levels(parsed_data, {
      level: options.level,
      children_key: options.children_key,
      value_key: options.value_key,
    });

    logger.debug("Serializing output.");
    const output_text = config.serialize_text(output_data, {
      indent: options.indent,
    });

    process.stdout.write(ensure_trailing_newline(output_text));
  } catch (error) {
    logger.error(error.message || "Failed to process stdin", error);
    process.exit(1);
  }
}

async function convert_files(options, config, logger) {
  logger.debug("Expanding input patterns.");
  const input_files = expand_patterns(options.patterns, logger);

  if (input_files.length === 0) {
    logger.error("No input files discovered", null);
    process.exit(1);
  }

  let processed_count = 0;
  let skipped_count = 0;
  let failed_count = 0;

  for (const input_path of input_files) {
    logger.debug(`Checking input path: ${input_path}`);

    if (!(await is_regular_file(input_path))) {
      logger.warn(`Skipping (not a regular file): ${input_path}`);
      skipped_count += 1;
      continue;
    }

    if (is_output_file(input_path, options.output_extension, options.refresh_mode)) {
      logger.warn(`Skipping output file: ${input_path}`);
      skipped_count += 1;
      continue;
    }

    const output_path = build_output_path_with_level(
      input_path,
      options.output_directory,
      options.output_extension,
      options.level,
    );

    try {
      if (options.output_directory) {
        logger.debug(`Ensuring output directory: ${path.dirname(output_path)}`);
        await mkdir(path.dirname(output_path), { recursive: true });
      }

      if (!options.force_overwrite && (await file_exists(output_path))) {
        logger.warn(
          `Exists, skipping: ${path.relative(process.cwd(), output_path)}`,
        );
        skipped_count += 1;
        continue;
      }

      logger.debug(`Reading input: ${input_path}`);
      const input_text = await readFile(input_path, "utf8");
      const cleaned_text = strip_bom(input_text);

      logger.debug("Parsing input data.");
      const parsed_data = config.parse_text(cleaned_text);

      logger.debug("Extracting leaf levels.");
      const { output_data, meta } = extract_leaf_levels(parsed_data, {
        level: options.level,
        children_key: options.children_key,
        value_key: options.value_key,
      });

      logger.debug(
        `Leaf extraction meta: leaves=${meta.leaf_count}, selected=${meta.selected_count}`,
      );

      logger.debug("Serializing output.");
      const output_text = config.serialize_text(output_data, {
        indent: options.indent,
      });

      if (options.dry_run) {
        logger.info(
          `Dry run -> ${path.relative(process.cwd(), input_path)} => ${path.relative(process.cwd(), output_path)}`,
        );
      } else {
        logger.debug(`Writing output: ${output_path}`);
        await writeFile(output_path, ensure_trailing_newline(output_text), "utf8");
        logger.info(
          `Extracted ${path.relative(process.cwd(), input_path)} -> ${path.relative(process.cwd(), output_path)}`,
        );
      }

      processed_count += 1;
    } catch (error) {
      failed_count += 1;
      logger.error(
        `Failed to process ${path.relative(process.cwd(), input_path)}: ${error.message}`,
        error,
      );
    }
  }

  const summary_message = `Completed with ${chalk.green(`${processed_count} processed`)}, ${chalk.yellow(`${skipped_count} skipped`)}, ${chalk.red(`${failed_count} failed`)}`;

  if (failed_count > 0) {
    logger.error(summary_message, null);
    process.exitCode = 1;
  } else if (!options.quiet_mode) {
    console.log(chalk.bold(summary_message));
  }
}

async function run_leaf_extract_cli(config) {
  const cli_options = parse_cli_arguments(config);
  const logger = create_logger({
    quiet_mode: cli_options.quiet_mode,
    debug_mode: cli_options.debug_mode,
    command_label: config.script_name,
    use_stderr: false,
  });

  try {
    if (is_stdin_mode(cli_options.patterns)) {
      await convert_stdin(cli_options, config);
      return;
    }

    await convert_files(cli_options, config, logger);
  } catch (error) {
    logger.error(error.message || "Unexpected failure", error);
    process.exit(1);
  }
}

module.exports = {
  run_leaf_extract_cli,
};
