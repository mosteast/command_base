"use strict";

const package_json = require("../../package.json");

const ALLOWED_MODES = ["like", "post", "one", "collection"];
const DEFAULT_CHROME_PROFILE = "";
const DEFAULT_MAX_COMMENT = 500;
const DEFAULT_MAX_DANMAKU = 500;

function build_help_text(script_name) {
  const name = script_name || "xsave_douyin";
  return [
    "Usage",
    `  ${name} -M <mode> -u <url> [options]`,
    "",
    "Description",
    "  Export Douyin likes, posts, collections, or a single video through Chrome.",
    "  Existing media is not re-downloaded. Missing sidecars are filled.",
    "  Invisible items are skipped even when a local file exists.",
    "",
    "Options",
    "  -M, --mode <mode>            Export mode: like, post, one, collection",
    "  -u, --url <url>              Douyin user, short URL, or video URL",
    "  -p, --path <dir>             Output root directory",
    "      --chrome-profile <name>  Chrome profile name or directory (default: gather runtime Douyin profile)",
    "      --max-comment <n>        Max comments per item (default: 500)",
    "      --max-danmaku <n>        Max flying danmaku per item (default: 500)",
    "  -d, --dry-run                Print planned actions without writing (default: false)",
    "      --quiet                  Print only warnings and errors (default: false)",
    "      --debug                  Print export paths and verbose debug logs (default: false)",
    "  -v, --version                Print the version number and exit",
    "  -h, --help                   Show this help message",
    "",
    "Examples",
    "  # Download liked videos",
    "  $0 -M like -u https://v.douyin.com/kIg44MNOKz8/",
    "",
    "  # Download a user's public posts",
    "  $0 -M post -u https://www.douyin.com/user/MS4wLjABAAAA",
    "",
    "  # Download one video",
    "  $0 -M one -u https://www.douyin.com/video/123",
    "",
    "  # Preview collection export without writing files",
    "  $0 --dry-run -M collection -u https://www.douyin.com/user/MS4wLjABAAAA",
  ].join("\n");
}

function is_help_flag(arg) {
  return arg === "-h" || arg === "--help";
}

function is_version_flag(arg) {
  return arg === "-v" || arg === "--version";
}

function parse_cli(argv) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.some(is_help_flag)) return { help: true };
  if (args.some(is_version_flag)) return { version: true, version_text: package_json.version };

  const yargs = require("yargs/yargs");
  const parser = yargs(args)
    .parserConfiguration({
      "camel-case-expansion": false,
      "unknown-options-as-args": false,
    })
    .option("mode", {
      alias: "M",
      type: "string",
      describe: "Export mode",
    })
    .option("url", {
      alias: "u",
      type: "string",
      describe: "Douyin URL",
    })
    .option("path", {
      alias: "p",
      type: "string",
      default: "",
      describe: "Output root",
    })
    .option("chrome-profile", {
      type: "string",
      default: DEFAULT_CHROME_PROFILE,
      describe: "Chrome profile name",
    })
    .option("max-comment", {
      type: "number",
      default: DEFAULT_MAX_COMMENT,
      describe: "Max comments per item",
    })
    .option("max-danmaku", {
      type: "number",
      default: DEFAULT_MAX_DANMAKU,
      describe: "Max danmaku per item",
    })
    .option("dry-run", {
      alias: "d",
      type: "boolean",
      default: false,
    })
    .option("quiet", {
      type: "boolean",
      default: false,
    })
    .option("debug", {
      type: "boolean",
      default: false,
    })
    .strict(true)
    .exitProcess(false)
    .help(false)
    .version(false)
    .fail((message) => {
      const text = String(message || "");
      if (/Unknown argument/i.test(text))
        throw new Error(text.replace(/Unknown argument/i, "Unknown option"));
      throw new Error(text || "Unknown option");
    });

  const parsed = parser.parse();
  const mode = String(parsed.mode || "").trim();
  const url = String(parsed.url || "").trim();
  if (!mode || !url) {
    throw new Error("Missing required options: -M/--mode and -u/--url");
  }
  if (!ALLOWED_MODES.includes(mode)) {
    throw new Error(
      `Invalid --mode ${mode}. Allowed: like, post, one, collection`,
    );
  }

  return {
    mode,
    url,
    path: parsed.path ? String(parsed.path) : "",
    chrome_profile: parsed["chrome-profile"]
      ? String(parsed["chrome-profile"]).trim()
      : DEFAULT_CHROME_PROFILE,
    max_comment: Number(parsed["max-comment"]) || DEFAULT_MAX_COMMENT,
    max_danmaku: Number(parsed["max-danmaku"]) || DEFAULT_MAX_DANMAKU,
    dry_run: Boolean(parsed["dry-run"]),
    debug: Boolean(parsed.debug),
    quiet: Boolean(parsed.quiet),
  };
}

module.exports = {
  ALLOWED_MODES,
  DEFAULT_CHROME_PROFILE,
  DEFAULT_MAX_COMMENT,
  DEFAULT_MAX_DANMAKU,
  build_help_text,
  parse_cli,
};
