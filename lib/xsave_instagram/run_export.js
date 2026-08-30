"use strict";

const fs = require("fs/promises");
const path = require("path");
const chalk = require("chalk");
const { find_existing_media, sidecar_paths, build_stem } = require("./media_path");
const {
  DEFAULT_RUNTIME_PATH,
  DEFAULT_CHROME_USER_DATA,
  DEFAULT_F2_OUTPUT_DIR,
} = require("../gather_doctor/constants");
const { plan_item } = require("./plan_item");
const { build_meta, build_comments, write_sidecars } = require("./sidecar");

function doctor_hint(chrome_profile) {
  const profile = String(chrome_profile || "").trim();
  if (profile)
    return `gather doctor fix --platform instagram --chrome-profile ${profile}`;
  return "gather doctor fix --platform instagram";
}

async function resolve_chrome_profile(options) {
  const explicit = String((options && options.chrome_profile) || "").trim();
  if (explicit) return explicit;
  const {
    read_runtime_config,
    get_platform_runtime,
  } = require("../gather_doctor/runtime_config");
  const runtime = await read_runtime_config(options && options.runtime_path);
  const entry = get_platform_runtime(runtime.data, "instagram");
  return entry && entry.chrome_profile
    ? String(entry.chrome_profile).trim()
    : "";
}

function resolve_item_limit(options) {
  const explicit = Number(options && options.limit);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const env = Number(process.env.COMMAND_BASE_F2_LIKE_LIMIT);
  if (Number.isInteger(env) && env > 0) return env;
  return 0;
}

function default_output_dir(source, f2_root) {
  return path.join(
    f2_root || DEFAULT_F2_OUTPUT_DIR,
    "instagram",
    String(source || ""),
  );
}

function resolve_output_dir(options = {}, deps = {}) {
  const explicit = String((options && options.output) || "").trim();
  if (explicit) return path.resolve(explicit);
  return default_output_dir(
    options && options.source,
    deps.f2_output_dir || options.f2_output_dir,
  );
}

function flatten_items(pages) {
  if (!Array.isArray(pages)) return [];
  if (pages[0] && pages[0].shortcode) return pages;
  return pages.flatMap((page) => (page && page.items) || []);
}

async function file_exists(file_path) {
  try {
    const stat = await fs.stat(file_path);
    return stat.isFile() && stat.size > 0;
  } catch (_error) {
    return false;
  }
}

function describe_export_layout({
  source,
  url,
  output_dir,
  chrome_profile,
  runtime_path,
  max_comment,
  dry_run,
  full_scan,
  item_limit,
} = {}) {
  const stem = '"<username>","<shortcode>","<full_name>","<taken_at>","<caption>"';
  const root = output_dir || process.cwd();
  const limit = Number(item_limit) || 0;
  return [
    "Export plan",
    `  source: ${source || ""}`,
    `  url: ${url || ""}`,
    `  dry_run: ${Boolean(dry_run)}`,
    `  output_dir: ${root}`,
    `  item_file_stem: ${stem}`,
    `  media video: ${path.join(root, `${stem}_video.mp4`)}`,
    `  media image: ${path.join(root, `${stem}_image_1.jpeg`)}`,
    `  sidecar meta: ${path.join(root, `${stem}_meta.json`)}`,
    `  sidecar comments: ${path.join(root, `${stem}_comments.json`)} (max ${Number(max_comment) || 0})`,
    "  existing media is reused; missing sidecars are filled",
    `  full_scan: ${Boolean(full_scan)}`,
    "  default list collect stops at the first already downloaded item",
    `  chrome_profile: ${chrome_profile || "(gather runtime)"}`,
    `  chrome_user_data: ${DEFAULT_CHROME_USER_DATA}`,
    `  runtime: ${runtime_path || DEFAULT_RUNTIME_PATH}`,
    "  cookie: exported from Chrome profile (value not printed)",
    `  chrome_cdp: ${process.env.COMMAND_BASE_CHROME_CDP || "http://127.0.0.1:9222"} (used when Chrome debug port is open)`,
    `  item_limit: ${limit || "none"}`,
  ];
}

function empty_export_stats() {
  return {
    collected: 0,
    download: 0,
    fill: 0,
    skip: 0,
    download_failed: 0,
    comments: 0,
  };
}

function describe_export_stats(stats, { dry_run, elapsed_ms } = {}) {
  const counts = stats || {};
  const lines = [
    "Export summary",
    `  collected: ${Number(counts.collected) || 0}`,
    `  download: ${Number(counts.download) || 0}`,
    `  fill: ${Number(counts.fill) || 0}`,
    `  skip: ${Number(counts.skip) || 0}`,
    `  download_failed: ${Number(counts.download_failed) || 0}`,
    `  comments: ${Number(counts.comments) || 0}`,
    `  elapsed_ms: ${Number(elapsed_ms) || 0}`,
  ];
  if (dry_run) lines.push("  dry_run: true");
  return lines;
}

function create_logger(options, deps) {
  return {
    log:
      deps.log ||
      ((text) => {
        if (!options.quiet) console.log(chalk.cyan(text));
      }),
    warn: deps.warn || ((text) => console.warn(chalk.yellow(text))),
    error: deps.error || ((text) => console.error(chalk.red(text))),
    debug:
      deps.debug ||
      ((text) => {
        if (options.debug) console.log(chalk.gray(text));
      }),
  };
}

function load_default_deps() {
  const chrome_client = require("./chrome_client");
  const download = require("./download_media");
  return {
    open_session: chrome_client.open_session,
    collect_list: chrome_client.collect_list,
    fetch_comments: chrome_client.fetch_comments,
    download_media: download.download_media,
    resolve_cookie: chrome_client.resolve_cookie_header,
    assert_logged_in_profile: chrome_client.assert_logged_in_profile,
    prepare_list_page: chrome_client.prepare_list_page,
  };
}

async function sidecar_exists_flags(stem_path) {
  const paths = sidecar_paths(stem_path);
  return { comments: await file_exists(paths.comments) };
}

async function run_export(options, deps = {}) {
  const resolved = deps.collect_list
    ? {
        download_media: require("./download_media").download_media,
        ...deps,
      }
    : { ...load_default_deps(), ...deps };
  const logger = create_logger(options || {}, deps);
  const chrome_profile = await resolve_chrome_profile(options);
  const output_dir = resolve_output_dir(options, resolved);
  const now = resolved.now || (() => new Date().toISOString());
  const items_out = [];
  const source = options && options.source;
  const item_limit = resolve_item_limit(options);
  const started_ms = Date.now();
  const stats = empty_export_stats();

  function finish(exit_code) {
    for (const line of describe_export_stats(stats, {
      dry_run: Boolean(options && options.dry_run),
      elapsed_ms: Date.now() - started_ms,
    }))
      logger.log(line);
    return { exit_code, items: items_out, stats };
  }

  for (const line of describe_export_layout({
    source,
    url: options && options.url,
    output_dir,
    chrome_profile,
    runtime_path: (options && options.runtime_path) || DEFAULT_RUNTIME_PATH,
    max_comment: options && options.max_comment,
    dry_run: options && options.dry_run,
    full_scan: options && options.full_scan,
    item_limit,
  }))
    logger.debug(line);

  logger.debug("Resolving Instagram cookie from Chrome profile");
  let cookie_header = "";
  try {
    cookie_header = await resolved.resolve_cookie({
      chrome_profile,
      cookie_file: options && options.cookie_file,
    });
  } catch (error) {
    logger.error(error.message || String(error));
    logger.error(doctor_hint(chrome_profile));
    return finish(1);
  }
  if (!cookie_header) {
    logger.error("Missing Instagram cookie");
    logger.error(doctor_hint(chrome_profile));
    return finish(1);
  }

  let session = null;
  let page = resolved.page || null;
  const needs_session = !options.dry_run || !deps.collect_list;
  if (needs_session && !page) {
    logger.debug("Opening Chrome session");
    logger.log("Complete any Instagram captcha in the Chrome window");
    try {
      session = await resolved.open_session({ cookie_header, chrome_profile });
      page = session.page;
    } catch (error) {
      logger.error(error.message || String(error));
      logger.error(doctor_hint(chrome_profile));
      return finish(1);
    }
  }

  if (
    (source === "like" || source === "collection") &&
    resolved.assert_logged_in_profile
  ) {
    try {
      await resolved.assert_logged_in_profile({
        page,
        url: options && options.url,
        source,
      });
    } catch (error) {
      logger.error(error.message || String(error));
      logger.error(doctor_hint(chrome_profile));
      if (session && session.close) await session.close();
      return finish(1);
    }
  }

  try {
    if (page && source !== "video" && resolved.prepare_list_page) {
      logger.debug("Preparing Instagram list page");
      await resolved.prepare_list_page(page, {
        source,
        url: options.url,
      });
    }
  } catch (error) {
    logger.error(error.message || String(error));
    logger.error(doctor_hint(chrome_profile));
    if (session && session.close) await session.close();
    return finish(1);
  }

  try {
    logger.debug("Collecting Instagram item list");
    const should_stop_list =
      options.full_scan || source === "video"
        ? undefined
        : async (items) => {
            for (const item of items || []) {
              const id = String((item && item.shortcode) || "");
              if (!id) continue;
              logger.debug(`Comparing recent item ${id} with local media`);
              const media = await find_existing_media(output_dir, id);
              if (!(media && media.media_path)) continue;
              logger.log(`Resume at downloaded item ${id}`);
              return true;
            }
            return false;
          };
    const pages = await resolved.collect_list({
      page,
      source,
      url: options && options.url,
      limit: item_limit,
      should_stop: should_stop_list,
    });
    const items = item_limit
      ? flatten_items(pages).slice(0, item_limit)
      : flatten_items(pages);
    logger.log(`Collected ${items.length} item(s) for source ${source}`);
    stats.collected = items.length;

    for (const item of items) {
      const id = String((item && item.shortcode) || "");
      try {
        const media = await find_existing_media(output_dir, id);
        const stem_path = media ? media.stem_path : build_stem(item, output_dir);
        const sidecar_exists = await sidecar_exists_flags(stem_path);
        const planned = plan_item({
          item,
          media,
          sidecar_exists,
          refresh: Boolean(options && options.refresh),
        });
        items_out.push({ shortcode: id, ...planned });
        logger.log(
          `${planned.action} ${id}${planned.reason ? ` (${planned.reason})` : ""}`,
        );
        if (options.dry_run) {
          if (planned.action === "skip") stats.skip += 1;
          else if (planned.action === "fill") stats.fill += 1;
          else if (planned.action === "download") stats.download += 1;
          if (planned.write_comments) stats.comments += 1;
          continue;
        }
        if (planned.action === "skip") {
          stats.skip += 1;
          continue;
        }

        if (planned.download) {
          logger.debug(`Downloading media for ${id}`);
          const target_path = `${stem_path}_video.mp4`;
          const downloaded = await resolved.download_media({
            item,
            target_path,
            cookie_header,
            page,
          });
          if (!downloaded || !downloaded.ok) {
            const reason = (downloaded && downloaded.reason) || "download_failed";
            logger.warn(`skip ${id} (${reason})`);
            stats.download_failed += 1;
            continue;
          }
        }

        let comments = [];
        if (planned.write_comments && Number(options.max_comment) > 0) {
          logger.debug(`Fetching comments for ${id}`);
          comments = build_comments(
            await resolved.fetch_comments({
              page,
              shortcode: id,
              max_comment: options.max_comment,
            }),
            options.max_comment,
          );
        }
        await write_sidecars({
          stem_path,
          meta: build_meta(item, now()),
          comments,
          write_comments: planned.write_comments && Number(options.max_comment) > 0,
        });
        if (planned.action === "fill") stats.fill += 1;
        else stats.download += 1;
        if (planned.write_comments && Number(options.max_comment) > 0)
          stats.comments += 1;
      } catch (error) {
        logger.warn(`skip ${id} (${error.message || error})`);
        stats.skip += 1;
      }
    }
  } finally {
    if (session && session.close) await session.close();
  }

  return finish(0);
}

module.exports = {
  doctor_hint,
  default_output_dir,
  describe_export_layout,
  describe_export_stats,
  empty_export_stats,
  resolve_chrome_profile,
  resolve_output_dir,
  run_export,
};
