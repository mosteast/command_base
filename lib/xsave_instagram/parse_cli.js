"use strict";

const package_json = require("../../package.json");

const ALLOWED_SOURCES = ["like", "post", "collection", "video"];
const LIST_SOURCES = ["like", "post", "collection"];
const SIGNER_SOURCES = ["like", "collection"];
const DEFAULT_CHROME_PROFILE = "";
const DEFAULT_MAX_COMMENT = 500;
const RESERVED_PROFILE_SEGMENTS = new Set([
  "p",
  "reel",
  "reels",
  "stories",
  "explore",
  "accounts",
  "direct",
  "tv",
]);
const SHORT_HOSTS = new Set(["instagr.am", "l.instagram.com"]);

function build_help_text(script_name) {
  const name = script_name || "xsave_instagram";
  return [
    "Usage",
    `  ${name} <source> <url> [options]`,
    `  ${name} <item-url> [options]`,
    `  ${name} like --signer [options]`,
    `  ${name} collection --signer [options]`,
    "",
    "Description",
    "  Export Instagram likes, posts, collections, or a single post/reel through Chrome.",
    "  Existing media is not re-downloaded unless --refresh is set. Missing sidecars are filled.",
    "  Invisible items are skipped even when a local file exists.",
    "  After the list page loads, compare recent items with local files",
    "  and resume from the last already downloaded position.",
    "  After each run, print counts for collected, download, fill, skip, and sidecars.",
    "",
    "Options",
    "      <source>                 List source: like, post, collection, video",
    "      <url>                    Instagram profile, short URL, or /p/ /reel/ URL",
    "  -o, --output <dir>           Output root (default: instagram/<source> library)",
    "      --chrome-profile <name>  Chrome profile name or directory (default: gather runtime Instagram profile)",
    "      --max-comment <n>        Max comments per item (default: 500; 0 skips comments)",
    "      --limit <n>              Process at most n items",
    "      --full-scan              Scan the entire list instead of stopping at already downloaded items (default: false)",
    "      --refresh                Re-download existing media and rewrite sidecars (default: false)",
    "      --cookie-file <path>     Cookie file instead of exporting from the Chrome profile",
    "      --signer                  Export the logged-in account for like or collection (default: false)",
    "  -d, --dry-run                Print planned actions without writing (default: false)",
    "      --quiet                  Print only warnings and errors (default: false)",
    "      --debug                  Print export paths and verbose debug logs (default: false)",
    "  -v, --version                Print the version number and exit",
    "  -h, --help                   Show this help message",
    "",
    "Examples",
    "  # Download liked posts",
    "  $0 like https://www.instagram.com/example_user/",
    "",
    "  # Download the logged-in account's likes",
    "  $0 like --signer",
    "",
    "  # Download the logged-in account's collections",
    "  $0 collection --signer",
    "",
    "  # Download a user's posts and reels",
    "  $0 post https://www.instagram.com/example_user/",
    "",
    "  # Download a single post",
    "  $0 https://www.instagram.com/p/AbCdEfGhIjK/",
    "",
    "  # Scan the entire list instead of resuming at already downloaded items",
    "  $0 --full-scan like https://www.instagram.com/example_user/",
    "",
    "  # Preview collection export without writing files",
    "  $0 --dry-run collection https://www.instagram.com/example_user/",
  ].join("\n");
}

function is_help_flag(arg) {
  return arg === "-h" || arg === "--help";
}

function is_version_flag(arg) {
  return arg === "-v" || arg === "--version";
}

function looks_like_url(token) {
  const text = String(token || "");
  return /:\/\//.test(text) || /instagram\.com|instagr\.am/i.test(text);
}

function parsed_url(url) {
  try {
    return new URL(url);
  } catch (_error) {
    return null;
  }
}

function hostname_of(url) {
  const parsed = parsed_url(url);
  return parsed ? parsed.hostname.toLowerCase() : "";
}

function pathname_of(url) {
  const parsed = parsed_url(url);
  return parsed ? parsed.pathname : String(url || "");
}

function is_instagram_host(host) {
  return host === "instagram.com" || host.endsWith(".instagram.com");
}

function is_short_url(url) {
  return SHORT_HOSTS.has(hostname_of(url));
}

function is_item_url(url) {
  if (is_short_url(url)) return false;
  const host = hostname_of(url);
  if (!is_instagram_host(host)) return false;
  return /\/(?:p|reel)\/[A-Za-z0-9_-]+/.test(pathname_of(url));
}

function is_profile_url(url) {
  if (is_short_url(url) || is_item_url(url)) return false;
  const host = hostname_of(url);
  if (!is_instagram_host(host)) return false;
  const first = String(pathname_of(url).split("/").filter(Boolean)[0] || "");
  if (!first || RESERVED_PROFILE_SEGMENTS.has(first.toLowerCase())) return false;
  return true;
}

function parse_non_negative_int(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ${flag} ${raw}`);
  return n;
}

function parse_positive_int(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`Invalid ${flag} ${raw}. Use a positive integer`);
  return n;
}

function resolve_limit(parsed) {
  if (parsed.limit !== undefined && parsed.limit !== null) {
    return parse_positive_int(parsed.limit, "--limit");
  }
  const env = process.env.COMMAND_BASE_F2_LIKE_LIMIT;
  if (env === undefined || env === "") return 0;
  const n = Number(env);
  if (!Number.isInteger(n) || n < 1) return 0;
  return n;
}

function resolve_source_and_url(positionals, { signer } = {}) {
  if (positionals.length === 0) throw new Error("Missing URL");
  const first = String(positionals[0] || "").trim();
  if (ALLOWED_SOURCES.includes(first)) {
    const url = String(positionals[1] || "").trim();
    if (signer && SIGNER_SOURCES.includes(first)) {
      if (positionals.length > 1)
        throw new Error(`Unexpected argument ${positionals[1]}`);
      return { source: first, url: "" };
    }
    if (!url) throw new Error("Missing URL");
    if (positionals.length > 2)
      throw new Error(`Unexpected argument ${positionals[2]}`);
    return { source: first, url };
  }
  if (!looks_like_url(first)) {
    throw new Error(
      `Invalid source ${first}. Allowed: like, post, collection, video`,
    );
  }
  if (positionals.length > 1)
    throw new Error(`Unexpected argument ${positionals[1]}`);
  if (is_item_url(first)) return { source: "video", url: first };
  throw new Error(
    "Missing source. Use like, post, collection, or a /p/ or /reel/ URL",
  );
}

function assert_source_url_match(source, url) {
  if (source === "video" && is_profile_url(url))
    throw new Error("source video does not match profile URL");
  if (LIST_SOURCES.includes(source) && is_item_url(url))
    throw new Error(`source ${source} does not match item URL`);
}

function parse_cli(argv) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.some(is_help_flag)) return { help: true };
  if (args.some(is_version_flag))
    return { version: true, version_text: package_json.version };

  const yargs = require("yargs/yargs");
  const parser = yargs(args)
    .parserConfiguration({
      "camel-case-expansion": false,
      "unknown-options-as-args": false,
    })
    .option("output", {
      alias: "o",
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
    .option("limit", {
      type: "number",
      describe: "Max items to process",
    })
    .option("full-scan", {
      type: "boolean",
      default: false,
      describe: "Scan the entire list",
    })
    .option("refresh", {
      type: "boolean",
      default: false,
      describe: "Re-download existing media",
    })
    .option("cookie-file", {
      type: "string",
      default: "",
      describe: "Cookie file",
    })
    .option("signer", {
      type: "boolean",
      default: false,
      describe: "Export the logged-in account for like or collection",
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
  const positionals = (parsed._ || []).map((token) => String(token));
  const signer = Boolean(parsed.signer);
  const { source, url } = resolve_source_and_url(positionals, { signer });
  if (signer && !SIGNER_SOURCES.includes(source))
    throw new Error(`source ${source} does not accept --signer`);
  if (url) assert_source_url_match(source, url);

  return {
    source,
    url,
    signer,
    output: parsed.output ? String(parsed.output) : "",
    chrome_profile: parsed["chrome-profile"]
      ? String(parsed["chrome-profile"]).trim()
      : DEFAULT_CHROME_PROFILE,
    max_comment: parse_non_negative_int(
      parsed["max-comment"],
      "--max-comment",
    ),
    limit: resolve_limit(parsed),
    refresh: Boolean(parsed.refresh),
    cookie_file: parsed["cookie-file"]
      ? String(parsed["cookie-file"]).trim()
      : "",
    dry_run: Boolean(parsed["dry-run"]),
    full_scan: Boolean(parsed["full-scan"]),
    debug: Boolean(parsed.debug),
    quiet: Boolean(parsed.quiet),
  };
}

module.exports = {
  ALLOWED_SOURCES,
  SIGNER_SOURCES,
  DEFAULT_CHROME_PROFILE,
  DEFAULT_MAX_COMMENT,
  build_help_text,
  is_item_url,
  is_profile_url,
  is_short_url,
  parse_cli,
};
