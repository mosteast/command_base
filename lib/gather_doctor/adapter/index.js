"use strict";

const youtube = require("./youtube");
const bilibili = require("./bilibili");
const { rumble, bitchute } = require("./yt_dlp_only");
const x_gallery_dl = require("./x_gallery_dl");
const { douyin, x_f2 } = require("./f2_platforms");
const instagram = require("./instagram");

const ADAPTERS = {
  youtube,
  bilibili,
  rumble,
  bitchute,
  douyin,
  instagram,
  x_f2,
  x_gallery_dl,
};

function get_adapter(platform_key) {
  const adapter = ADAPTERS[platform_key];
  if (!adapter) throw new Error(`No adapter for platform: ${platform_key}`);
  return adapter;
}

module.exports = {
  ADAPTERS,
  get_adapter,
};
