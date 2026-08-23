"use strict";

const fs = require("fs/promises");
const chalk = require("chalk");
const { find_existing_media, sidecar_paths, build_stem } = require("./media_path");
const { plan_item } = require("./plan_item");
const {
  build_meta,
  build_comments,
  build_danmaku,
  write_sidecars,
} = require("./sidecar");

function doctor_hint(chrome_profile) {
  const profile = String(chrome_profile || "").trim();
  if (profile)
    return `gather doctor fix --platform douyin --chrome-profile ${profile}`;
  return "gather doctor fix --platform douyin";
}

async function resolve_chrome_profile(options) {
  const explicit = String((options && options.chrome_profile) || "").trim();
  if (explicit) return explicit;
  const {
    read_runtime_config,
    get_platform_runtime,
  } = require("../gather_doctor/runtime_config");
  const runtime = await read_runtime_config(options && options.runtime_path);
  const entry = get_platform_runtime(runtime.data, "douyin");
  return entry && entry.chrome_profile
    ? String(entry.chrome_profile).trim()
    : "";
}

function flatten_items(pages) {
  if (!Array.isArray(pages)) return [];
  if (pages[0] && pages[0].aweme_id) return pages;
  return pages.flatMap((page) => (page && page.aweme_list) || []);
}

function extract_sec_user_id(url) {
  const text = String(url || "");
  const match = text.match(/\/user\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function extract_aweme_id(url) {
  const text = String(url || "");
  const match = text.match(/\/video\/(\d+)/);
  return match ? match[1] : "";
}

async function file_exists(file_path) {
  try {
    const stat = await fs.stat(file_path);
    return stat.isFile() && stat.size > 0;
  } catch (_error) {
    return false;
  }
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
  const like_browser = require("../../utility/f2_compat/f2_douyin_like_browser");
  return {
    open_session: chrome_client.open_session,
    attach_list_intercept: chrome_client.attach_list_intercept,
    collect_list: chrome_client.collect_list,
    fetch_comments: chrome_client.fetch_comments,
    fetch_danmaku: chrome_client.fetch_danmaku,
    download_media: download.download_media,
    resolve_cookie: like_browser.resolve_cookie_header,
    prepare_list_page: chrome_client.prepare_list_page,
  };
}

async function sidecar_exists_flags(stem_path) {
  const paths = sidecar_paths(stem_path);
  return {
    comments: await file_exists(paths.comments),
    danmaku: await file_exists(paths.danmaku),
  };
}

async function run_export(options, deps = {}) {
  const resolved = { ...load_default_deps(), ...deps };
  const logger = create_logger(options || {}, deps);
  const chrome_profile = await resolve_chrome_profile(options);
  const output_dir = (options && options.path) || process.cwd();
  const now =
    resolved.now ||
    (() => new Date().toISOString());
  const items_out = [];

  logger.debug("Resolving Douyin cookie from Chrome profile");
  let cookie_header = "";
  try {
    cookie_header = await resolved.resolve_cookie({
      chrome_profile,
      cookie_file: options && options.cookie_file,
    });
  } catch (error) {
    logger.error(error.message || String(error));
    logger.error(doctor_hint(chrome_profile));
    return { exit_code: 1, items: items_out };
  }
  if (!cookie_header) {
    logger.error("Missing Douyin cookie");
    logger.error(doctor_hint(chrome_profile));
    return { exit_code: 1, items: items_out };
  }

  const sec_user_id =
    (options && options.sec_user_id) || extract_sec_user_id(options && options.url);
  const aweme_id =
    (options && options.aweme_id) || extract_aweme_id(options && options.url);
  const limit = Number(process.env.COMMAND_BASE_F2_LIKE_LIMIT) || 0;

  let session = null;
  let page = resolved.page || null;
  const needs_session = !options.dry_run || !deps.collect_list;
  if (needs_session && !page) {
    logger.debug("Opening Chrome session");
    try {
      session = await resolved.open_session({ cookie_header });
      page = session.page;
    } catch (error) {
      logger.error(error.message || String(error));
      logger.error(doctor_hint(chrome_profile));
      return { exit_code: 1, items: items_out };
    }
  }

  let intercepted_pages;
  try {
    if (page && options.mode !== "one") {
      if (resolved.attach_list_intercept)
        intercepted_pages = resolved.attach_list_intercept(page, options.mode);
      if (resolved.prepare_list_page) {
        logger.debug("Preparing Douyin list page");
        await resolved.prepare_list_page(page, {
          mode: options.mode,
          url: options.url,
          sec_user_id,
        });
      }
    }
  } catch (error) {
    logger.error(error.message || String(error));
    logger.error(doctor_hint(chrome_profile));
    if (session && session.close) await session.close();
    return { exit_code: 1, items: items_out };
  }

  try {
    logger.debug("Collecting Douyin item list");
    const pages = await resolved.collect_list({
      page,
      mode: options.mode,
      sec_user_id,
      aweme_id,
      limit,
      intercepted_pages,
    });
    const items = flatten_items(pages);
    logger.log(`Collected ${items.length} item(s) for mode ${options.mode}`);

    for (const item of items) {
      const id = String((item && item.aweme_id) || "");
      try {
        const media = await find_existing_media(output_dir, id);
        const stem_path = media
          ? media.stem_path
          : build_stem(item, output_dir);
        const sidecar_exists = await sidecar_exists_flags(stem_path);
        const planned = plan_item({ item, media, sidecar_exists });
        items_out.push({ aweme_id: id, ...planned });
        logger.log(
          `${planned.action} ${id}${planned.reason ? ` (${planned.reason})` : ""}`,
        );
        if (options.dry_run) continue;
        if (planned.action === "skip") continue;

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
            const detail = downloaded && downloaded.error
              ? String(downloaded.error).replace(/\?[^ \n]+/g, "")
              : "";
            logger.warn(`skip ${id} (${reason}${detail ? `: ${detail}` : ""})`);
            continue;
          }
        }

        let comments = [];
        let danmaku = [];
        if (planned.write_comments) {
          logger.debug(`Fetching comments for ${id}`);
          comments = build_comments(
            await resolved.fetch_comments({
              page,
              aweme_id: id,
              max_comment: options.max_comment,
            }),
            options.max_comment,
          );
        }
        if (planned.write_danmaku) {
          logger.debug(`Fetching danmaku for ${id}`);
          danmaku = build_danmaku(
            await resolved.fetch_danmaku({
              page,
              aweme_id: id,
              max_danmaku: options.max_danmaku,
            }),
            options.max_danmaku,
          );
        }
        await write_sidecars({
          stem_path,
          meta: build_meta(item, now()),
          comments,
          danmaku,
          write_comments: planned.write_comments,
          write_danmaku: planned.write_danmaku,
        });
      } catch (error) {
        logger.warn(`skip ${id} (${error.message || error})`);
      }
    }
  } finally {
    if (session && session.close) await session.close();
  }

  return { exit_code: 0, items: items_out };
}

module.exports = {
  doctor_hint,
  extract_aweme_id,
  extract_sec_user_id,
  resolve_chrome_profile,
  run_export,
};
