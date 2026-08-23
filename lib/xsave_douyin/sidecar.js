"use strict";

const fs = require("fs/promises");
const { sidecar_paths } = require("./media_path");

const SECRET_PATTERN = /sessionid=|msToken|a_bogus/i;

function has_secret_leak(text) {
  return SECRET_PATTERN.test(String(text || ""));
}

function number_or_undefined(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function build_meta(item, fetched_at) {
  const stats = (item && item.statistics) || {};
  const meta = {
    aweme_id: String((item && item.aweme_id) || ""),
    author: String((item && item.author && item.author.nickname) || ""),
    title: String((item && item.desc) || ""),
    desc: String((item && item.desc) || ""),
    create_time: item && item.create_time,
    digg_count: number_or_undefined(stats.digg_count),
    collect_count: number_or_undefined(stats.collect_count),
    comment_count: number_or_undefined(stats.comment_count),
    share_count: number_or_undefined(stats.share_count),
    online_status: "visible",
    fetched_at: fetched_at,
  };
  const play_count = number_or_undefined(stats.play_count);
  if (play_count !== undefined) meta.play_count = play_count;
  return meta;
}

function map_entry(entry) {
  const user = (entry && entry.user) || {};
  return {
    id: String((entry && (entry.cid || entry.id)) || ""),
    text: String((entry && entry.text) || ""),
    author: String(user.nickname || ""),
    time: entry && (entry.create_time !== undefined ? entry.create_time : entry.time),
    like_count: number_or_undefined(entry && entry.digg_count) || 0,
  };
}

function build_comments(list, max_comment) {
  const items = Array.isArray(list) ? list : [];
  const limit = Number(max_comment) || 0;
  return items.slice(0, limit).map(map_entry);
}

function build_danmaku(list, max_danmaku) {
  const items = Array.isArray(list) ? list : [];
  const limit = Number(max_danmaku) || 0;
  return items.slice(0, limit).map(map_entry);
}

async function write_json(file_path, payload) {
  const text = JSON.stringify(payload, null, 2);
  if (has_secret_leak(text)) throw new Error("sidecar payload leaked secrets");
  await fs.writeFile(file_path, `${text}\n`, "utf8");
}

async function write_sidecars({
  stem_path,
  meta,
  comments,
  danmaku,
  write_comments,
  write_danmaku,
}) {
  const paths = sidecar_paths(stem_path);
  if (meta) await write_json(paths.meta, meta);
  if (write_comments) await write_json(paths.comments, comments || []);
  if (write_danmaku && Array.isArray(danmaku) && danmaku.length > 0)
    await write_json(paths.danmaku, danmaku);
}

module.exports = {
  build_comments,
  build_danmaku,
  build_meta,
  has_secret_leak,
  write_sidecars,
};
