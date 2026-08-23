"use strict";

const fs = require("fs/promises");
const path = require("path");

const MEDIA_SUFFIXES = ["_video.mp4", "_article.md", "_image_1.jpeg"];

function sidecar_paths(stem_path) {
  return {
    meta: `${stem_path}_meta.json`,
    comments: `${stem_path}_comments.json`,
    danmaku: `${stem_path}_danmaku.json`,
  };
}

function stem_from_media_name(file_name) {
  for (const suffix of MEDIA_SUFFIXES) {
    if (file_name.endsWith(suffix)) return file_name.slice(0, -suffix.length);
  }
  const ext = path.extname(file_name);
  if (ext) return file_name.slice(0, -ext.length);
  return file_name;
}

function file_has_aweme_id(file_name, aweme_id) {
  const id = String(aweme_id || "").trim();
  if (!id) return false;
  return (
    file_name.includes(`"${id}"`) ||
    file_name.includes(`,${id},`) ||
    file_name.includes(`"${id}",`)
  );
}

async function list_candidate_files(output_dir) {
  const entries = [];
  let names = [];
  try {
    names = await fs.readdir(output_dir, { withFileTypes: true });
  } catch (_error) {
    return entries;
  }
  for (const entry of names) {
    const full_path = path.join(output_dir, entry.name);
    if (entry.isFile()) {
      entries.push(full_path);
      continue;
    }
    if (!entry.isDirectory()) continue;
    let nested = [];
    try {
      nested = await fs.readdir(full_path, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const child of nested) {
      if (child.isFile()) entries.push(path.join(full_path, child.name));
    }
  }
  return entries;
}

async function find_existing_media(output_dir, aweme_id) {
  const files = await list_candidate_files(output_dir);
  for (const file_path of files) {
    const file_name = path.basename(file_path);
    if (!file_has_aweme_id(file_name, aweme_id)) continue;
    const is_media =
      MEDIA_SUFFIXES.some((suffix) => file_name.endsWith(suffix)) ||
      file_name.endsWith(".mp4") ||
      file_name.endsWith(".md");
    if (!is_media) continue;
    let stat;
    try {
      stat = await fs.stat(file_path);
    } catch (_error) {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0) continue;
    return {
      media_path: file_path,
      stem_path: path.join(path.dirname(file_path), stem_from_media_name(file_name)),
    };
  }
  return null;
}

function build_stem(item, output_dir) {
  const aweme_id = String((item && item.aweme_id) || "").trim();
  const uid = String((item && item.author && item.author.uid) || "").trim();
  const nickname = String((item && item.author && item.author.nickname) || "").trim();
  const create_time = String((item && item.create_time_text) || "").trim();
  const desc = String((item && item.desc) || "").trim().slice(0, 40);
  const file_stem = `"${uid}","${aweme_id}","${nickname}","${create_time}","${desc}"`;
  return path.join(output_dir, file_stem);
}

module.exports = {
  build_stem,
  find_existing_media,
  sidecar_paths,
};
