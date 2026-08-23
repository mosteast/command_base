"use strict";

const fs = require("fs/promises");
const path = require("path");

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

function add_urls(urls, list) {
  if (!Array.isArray(list)) return;
  for (const url of list) {
    const text = String(url || "").trim();
    if (text && !urls.includes(text)) urls.push(text);
  }
}

function collect_play_urls(item) {
  const urls = [];
  add_urls(
    urls,
    item &&
      item.video &&
      item.video.play_addr &&
      item.video.play_addr.url_list,
  );
  const rates =
    item && item.video && Array.isArray(item.video.bit_rate)
      ? item.video.bit_rate
      : [];
  for (const rate of rates)
    add_urls(urls, rate && rate.play_addr && rate.play_addr.url_list);
  return urls;
}

function first_play_url(item) {
  const urls = collect_play_urls(item);
  return urls[urls.length - 1] || "";
}

function download_headers(cookie_header) {
  return {
    Referer: "https://www.douyin.com/",
    "User-Agent": CHROME_UA,
    ...(cookie_header ? { Cookie: cookie_header } : {}),
  };
}

async function is_nonempty_file(file_path) {
  try {
    const stat = await fs.stat(file_path);
    return stat.isFile() && stat.size > 0;
  } catch (_error) {
    return false;
  }
}

async function write_media_file(target_path, bytes) {
  await fs.mkdir(path.dirname(target_path), { recursive: true });
  await fs.writeFile(target_path, bytes);
}

async function default_run_f2({ url, item, target_path, cookie_header } = {}) {
  const urls = [];
  if (url) urls.push(url);
  for (const candidate of collect_play_urls(item)) {
    if (!urls.includes(candidate)) urls.push(candidate);
  }
  if (!urls.length) return { ok: false, status: 0, reason: "missing_url" };
  let last = { ok: false, status: 0, reason: "missing_url" };
  for (const play_url of urls) {
    try {
      const response = await fetch(play_url, {
        headers: download_headers(cookie_header),
      });
      if (response.status === 403) {
        last = { ok: false, status: 403 };
        continue;
      }
      if (!response.ok) {
        last = { ok: false, status: response.status };
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) {
        last = { ok: false, status: response.status, reason: "empty" };
        continue;
      }
      await write_media_file(target_path, bytes);
      return { ok: true, status: response.status };
    } catch (error) {
      last = {
        ok: false,
        status: 0,
        reason: error && error.message ? error.message : "fetch_failed",
      };
    }
  }
  return last;
}

function request_api(page) {
  if (page && page.request && typeof page.request.get === "function")
    return page.request;
  if (
    page &&
    page.context &&
    page.context.request &&
    typeof page.context.request.get === "function"
  )
    return page.context.request;
  return null;
}

async function default_chrome_download({
  page,
  url,
  item,
  target_path,
} = {}) {
  const urls = [];
  if (url) urls.push(url);
  for (const candidate of collect_play_urls(item)) {
    if (!urls.includes(candidate)) urls.push(candidate);
  }
  const request = request_api(page);
  if (!request || !urls.length) return { ok: false };
  let last = { ok: false };
  for (const play_url of urls) {
    const response = await request.get(play_url, {
      timeout: 120000,
      headers: {
        Referer: "https://www.douyin.com/",
        "User-Agent": CHROME_UA,
      },
    });
    if (!response.ok()) {
      last = { ok: false, status: response.status() };
      continue;
    }
    const bytes = await response.body();
    if (!bytes || !bytes.length) {
      last = { ok: false, status: response.status(), reason: "empty" };
      continue;
    }
    await write_media_file(target_path, bytes);
    return { ok: true, status: response.status() };
  }
  return last;
}

async function download_media({
  item,
  target_path,
  run_f2,
  chrome_download,
  cookie_header,
  page,
} = {}) {
  const url = first_play_url(item);
  const http_download = run_f2 || default_run_f2;
  let f2_result = { ok: false, status: 0, reason: "missing_url" };
  if (url) {
    f2_result = await http_download({
      item,
      target_path,
      url,
      cookie_header,
    });
  }
  if (f2_result && f2_result.ok) return { ok: true, reason: "" };

  const chrome_fn = chrome_download || default_chrome_download;
  try {
    const chrome_result = await chrome_fn({
      item,
      target_path,
      url,
      page,
      cookie_header,
    });
    if (chrome_result && chrome_result.ok) return { ok: true, reason: "" };
    if (await is_nonempty_file(target_path)) return { ok: true, reason: "" };
    return { ok: false, reason: "media_forbidden" };
  } catch (error) {
    return {
      ok: false,
      reason: "chrome_download_failed",
      error: error && error.message ? error.message : String(error),
    };
  }
}

module.exports = {
  CHROME_UA,
  collect_play_urls,
  default_chrome_download,
  default_run_f2,
  download_media,
  first_play_url,
};
