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

function collect_media_urls(item) {
  const urls = [];
  if (item && String(item.video_url || "").trim())
    urls.push(String(item.video_url).trim());
  const carousel = item && Array.isArray(item.carousel) ? item.carousel : [];
  add_urls(
    urls,
    carousel.map((entry) => (entry && entry.url) || ""),
  );
  add_urls(urls, item && item.image_urls);
  return urls;
}

function first_media_url(item) {
  return collect_media_urls(item)[0] || "";
}

function download_headers(cookie_header) {
  return {
    Referer: "https://www.instagram.com/",
    "User-Agent": CHROME_UA,
    ...(cookie_header ? { Cookie: cookie_header } : {}),
  };
}

async function write_media_file(target_path, bytes) {
  await fs.mkdir(path.dirname(target_path), { recursive: true });
  await fs.writeFile(target_path, bytes);
}

async function default_http_download({ url, item, target_path, cookie_header } = {}) {
  const urls = [];
  if (url) urls.push(url);
  for (const candidate of collect_media_urls(item)) {
    if (!urls.includes(candidate)) urls.push(candidate);
  }
  if (!urls.length) return { ok: false, status: 0, reason: "missing_url" };
  let last = { ok: false, status: 0, reason: "missing_url" };
  for (const media_url of urls) {
    try {
      const response = await fetch(media_url, {
        headers: download_headers(cookie_header),
      });
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

async function download_media({
  item,
  target_path,
  cookie_header,
  http_download,
} = {}) {
  const url = first_media_url(item);
  const download = http_download || default_http_download;
  if (!url) return { ok: false, reason: "missing_url" };
  const result = await download({
    item,
    target_path,
    url,
    cookie_header,
  });
  if (result && result.ok) return { ok: true, reason: "" };
  return { ok: false, reason: (result && result.reason) || "download_failed" };
}

module.exports = {
  CHROME_UA,
  collect_media_urls,
  default_http_download,
  download_media,
  first_media_url,
};
