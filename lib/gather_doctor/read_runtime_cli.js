#!/usr/bin/env node

"use strict";

const {
  read_runtime_config,
  get_cookies_from_browser,
  get_cookies_file,
  get_platform_runtime,
} = require("./runtime_config");

function print_usage() {
  process.stdout.write(
    [
      "Usage:",
      "  node lib/gather_doctor/read_runtime_cli.js <query> [platform] [--runtime <path>]",
      "",
      "Queries:",
      "  cookies-from-browser <platform>",
      "  cookies-file <platform>",
      "  chrome-profile <platform>",
      "  json",
      "",
    ].join("\n"),
  );
}

function parse_args(argv) {
  const args = [...argv];
  let runtime_path = "";
  const positionals = [];
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--runtime") {
      runtime_path = String(args.shift() || "");
      continue;
    }
    if (token === "--help" || token === "-h") {
      return { help: true };
    }
    positionals.push(token);
  }
  return {
    help: false,
    query: positionals[0] || "",
    platform: positionals[1] || "",
    runtime_path,
  };
}

async function main() {
  const options = parse_args(process.argv.slice(2));
  if (options.help || !options.query) {
    print_usage();
    process.exit(options.help ? 0 : 1);
  }

  const loaded = await read_runtime_config(options.runtime_path);
  const platform_key = String(options.platform || "").trim();

  switch (options.query) {
    case "cookies-from-browser": {
      process.stdout.write(
        `${get_cookies_from_browser(loaded.data, platform_key)}\n`,
      );
      return;
    }
    case "cookies-file": {
      process.stdout.write(`${get_cookies_file(loaded.data, platform_key)}\n`);
      return;
    }
    case "chrome-profile": {
      const entry = get_platform_runtime(loaded.data, platform_key);
      process.stdout.write(
        `${entry && entry.chrome_profile ? entry.chrome_profile : ""}\n`,
      );
      return;
    }
    case "json": {
      process.stdout.write(`${JSON.stringify(loaded.data)}\n`);
      return;
    }
    default:
      process.stderr.write(`Unknown query: ${options.query}\n`);
      print_usage();
      process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
