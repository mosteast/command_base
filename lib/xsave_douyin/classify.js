"use strict";

function has_playable_url(item) {
  const video_urls =
    item &&
    item.video &&
    item.video.play_addr &&
    Array.isArray(item.video.play_addr.url_list)
      ? item.video.play_addr.url_list
      : [];
  if (video_urls.some((url) => String(url || "").trim())) return true;
  const images = item && Array.isArray(item.images) ? item.images : [];
  for (const image of images) {
    const urls = image && Array.isArray(image.url_list) ? image.url_list : [];
    if (urls.some((url) => String(url || "").trim())) return true;
  }
  if (item && item.article_markdown) return true;
  return false;
}

function is_item_visible(item) {
  if (!item || typeof item !== "object") return false;
  if (item.is_prohibited) return false;
  if (Number(item.private_status) > 2) return false;
  if (item.detail_failed) return false;
  return has_playable_url(item);
}

function classify_item(item) {
  const visible = is_item_visible(item);
  return { visible, reason: visible ? "" : "invisible" };
}

module.exports = { has_playable_url, is_item_visible, classify_item };
