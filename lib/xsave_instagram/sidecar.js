"use strict";

const fs = require("fs/promises");
const { sidecar_paths } = require("./media_path");

const SECRET_PATTERN = /sessionid=|csrftoken=|ds_user_id=/i;

function has_secret_leak(text) {
  return SECRET_PATTERN.test(String(text || ""));
}

function number_or_undefined(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function build_meta(item, fetched_at) {
  return {
    shortcode: String((item && item.shortcode) || ""),
    pk: String((item && item.pk) || ""),
    author: String((item && item.author && item.author.full_name) || ""),
    title: String((item && item.caption) || ""),
    desc: String((item && item.caption) || ""),
    create_time: item && item.taken_at,
    like_count: number_or_undefined(item && item.like_count),
    comment_count: number_or_undefined(item && item.comment_count),
    online_status: "visible",
    fetched_at,
  };
}

function map_entry(entry) {
  const user = (entry && entry.user) || {};
  return {
    id: String((entry && (entry.pk || entry.id)) || ""),
    text: String((entry && (entry.text || entry.body)) || ""),
    author: String(user.username || user.full_name || ""),
    time: entry && (entry.created_at !== undefined ? entry.created_at : entry.time),
    like_count: number_or_undefined(entry && entry.like_count) || 0,
  };
}

function build_comments(list, max_comment) {
  const items = Array.isArray(list) ? list : [];
  const limit = Number(max_comment) || 0;
  return items.slice(0, limit).map(map_entry);
}

async function write_json(file_path, payload) {
  const text = JSON.stringify(payload, null, 2);
  if (has_secret_leak(text)) throw new Error("sidecar payload leaked secrets");
  await fs.writeFile(file_path, `${text}\n`, "utf8");
}

async function write_sidecars({ stem_path, meta, comments, write_comments }) {
  const paths = sidecar_paths(stem_path);
  if (meta) await write_json(paths.meta, meta);
  if (write_comments) await write_json(paths.comments, comments || []);
}

module.exports = {
  build_comments,
  build_meta,
  has_secret_leak,
  write_sidecars,
};
