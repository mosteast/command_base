"use strict";

function has_playable_url(item) {
  if (item && String(item.video_url || "").trim()) return true;
  const images = item && Array.isArray(item.image_urls) ? item.image_urls : [];
  if (images.some((url) => String(url || "").trim())) return true;
  const carousel = item && Array.isArray(item.carousel) ? item.carousel : [];
  return carousel.some((entry) => String((entry && entry.url) || "").trim());
}

function is_item_visible(item) {
  if (!item || typeof item !== "object") return false;
  if (item.is_prohibited) return false;
  return has_playable_url(item);
}

function classify_item(item) {
  const visible = is_item_visible(item);
  return { visible, reason: visible ? "" : "invisible" };
}

module.exports = { has_playable_url, is_item_visible, classify_item };
