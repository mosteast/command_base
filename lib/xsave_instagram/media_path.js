"use strict";

const fs = require("fs/promises");
const path = require("path");

const MEDIA_SUFFIXES = ["_video.mp4", "_image_1.jpeg", "_image_1.jpg"];

function sidecar_paths(stem_path) {
  return {
    meta: `${stem_path}_meta.json`,
    comments: `${stem_path}_comments.json`,
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

function file_has_shortcode(file_name, shortcode) {
  const id = String(shortcode || "").trim();
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

async function find_existing_media(output_dir, shortcode) {
  const files = await list_candidate_files(output_dir);
  for (const file_path of files) {
    const file_name = path.basename(file_path);
    if (!file_has_shortcode(file_name, shortcode)) continue;
    const is_media =
      MEDIA_SUFFIXES.some((suffix) => file_name.endsWith(suffix)) ||
      file_name.endsWith(".mp4") ||
      file_name.endsWith(".jpg") ||
      file_name.endsWith(".jpeg");
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
  const shortcode = String((item && item.shortcode) || "").trim();
  const username = String((item && item.author && item.author.username) || "").trim();
  const full_name = String((item && item.author && item.author.full_name) || "").trim();
  const taken_at = String((item && item.taken_at) || "").trim();
  const caption = String((item && item.caption) || "").trim().slice(0, 40);
  const file_stem = `"${username}","${shortcode}","${full_name}","${taken_at}","${caption}"`;
  return path.join(output_dir, file_stem);
}

module.exports = {
  build_stem,
  find_existing_media,
  sidecar_paths,
};
