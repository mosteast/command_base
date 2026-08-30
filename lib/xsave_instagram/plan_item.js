"use strict";

const { classify_item } = require("./classify");

function plan_item({ item, media, sidecar_exists, refresh } = {}) {
  const classified = classify_item(item);
  if (!classified.visible) {
    return {
      action: "skip",
      reason: "invisible",
      download: false,
      write_meta: false,
      write_comments: false,
    };
  }
  if (media && media.media_path && !refresh) {
    const exists = sidecar_exists || {};
    return {
      action: "fill",
      reason: "",
      download: false,
      write_meta: true,
      write_comments: !exists.comments,
    };
  }
  return {
    action: "download",
    reason: refresh && media && media.media_path ? "refresh" : "",
    download: true,
    write_meta: true,
    write_comments: true,
  };
}

module.exports = { plan_item };
