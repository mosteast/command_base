"use strict";

const fs = require("fs/promises");
const path = require("path");
function first_play_url(item) {
  const urls =
    item &&
    item.video &&
    item.video.play_addr &&
    Array.isArray(item.video.play_addr.url_list)
      ? item.video.play_addr.url_list
      : [];
  const found = urls.find((url) => String(url || "").trim());
  return found ? String(found).trim() : "";
}

async function is_nonempty_file(file_path) {
  try {
    const stat = await fs.stat(file_path);
    return stat.isFile() && stat.size > 0;
  } catch (_error) {
    return false;
  }
}

async function default_run_f2({ url, target_path, cookie_header } = {}) {
  if (!url) return { ok: false, status: 0, reason: "missing_url" };
  const response = await fetch(url, {
    headers: {
      Referer: "https://www.douyin.com/",
      ...(cookie_header ? { Cookie: cookie_header } : {}),
    },
  });
  if (response.status === 403) return { ok: false, status: 403 };
  if (!response.ok) return { ok: false, status: response.status };
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) return { ok: false, status: response.status, reason: "empty" };
  await fs.mkdir(path.dirname(target_path), { recursive: true });
  await fs.writeFile(target_path, bytes);
  return { ok: true, status: response.status };
}

async function default_chrome_download({ page, url, target_path } = {}) {
  if (!page || !url) return { ok: false };
  const payload = await page.evaluate(async (play_url) => {
    const response = await fetch(play_url, { credentials: "include" });
    if (!response.ok) return { ok: false, status: response.status, bytes: [] };
    const buffer = await response.arrayBuffer();
    return {
      ok: true,
      status: response.status,
      bytes: Array.from(new Uint8Array(buffer)),
    };
  }, url);
  if (!payload || !payload.ok || !payload.bytes || !payload.bytes.length)
    return { ok: false, status: payload && payload.status };
  await fs.mkdir(path.dirname(target_path), { recursive: true });
  await fs.writeFile(target_path, Buffer.from(payload.bytes));
  return { ok: true, status: payload.status };
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
  } catch (_error) {
    return { ok: false, reason: "chrome_download_failed" };
  }
}

module.exports = {
  default_chrome_download,
  default_run_f2,
  download_media,
  first_play_url,
};
