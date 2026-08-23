"use strict";

const path = require("path");
const os = require("os");

const DEFAULT_STATE_DIR =
  "/Users/hailang/Library/Mobile Documents/com~apple~CloudDocs/main/saved/state";

const DEFAULT_CONFIG_PATH = path.join(DEFAULT_STATE_DIR, "gather.config.yaml");
const DEFAULT_STATE_FILE = path.join(DEFAULT_STATE_DIR, "gather.state.json");
const DEFAULT_RUNTIME_PATH = path.join(DEFAULT_STATE_DIR, "gather.runtime.yaml");
const DEFAULT_F2_OUTPUT_DIR =
  "/Users/hailang/Library/Mobile Documents/com~apple~CloudDocs/main/saved/f2";
const DEFAULT_GALLERY_DL_COOKIES = path.join(
  os.homedir(),
  "Downloads",
  "cookies.txt",
);
const DEFAULT_CHROME_USER_DATA = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Google",
  "Chrome",
);
const MINIMUM_GALLERY_DL_VERSION = "1.31.10";
const RUNTIME_VERSION = 1;

const PLATFORM_ALIASES = {
  bili: "bilibili",
  dy: "douyin",
  douyin_f2: "douyin",
  tiktok: "douyin",
  twitter: "x_f2",
  tw: "x_f2",
  x: "x_f2",
  yt: "youtube",
};

const PLATFORM_KEYS = [
  "youtube",
  "bilibili",
  "rumble",
  "bitchute",
  "douyin",
  "x_f2",
  "x_gallery_dl",
];

const HOST_PATTERNS = {
  youtube: ["youtube.com", "youtu.be", "google.com"],
  bilibili: ["bilibili.com", "biliapi.net", "bilivideo.com"],
  rumble: ["rumble.com"],
  bitchute: ["bitchute.com"],
  douyin: ["douyin.com", "iesdouyin.com"],
  x_f2: ["x.com", "twitter.com"],
  x_gallery_dl: ["x.com", "twitter.com"],
};

const PLATFORM_PROBE_URLS = {
  youtube: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  bilibili: "https://www.bilibili.com/video/BV1xx411c7mD",
  rumble: "https://rumble.com/",
  bitchute: "https://www.bitchute.com/",
  douyin: "https://www.douyin.com/",
  x_f2: "https://x.com/",
  x_gallery_dl: "https://x.com/",
};

module.exports = {
  DEFAULT_CONFIG_PATH,
  DEFAULT_STATE_FILE,
  DEFAULT_RUNTIME_PATH,
  DEFAULT_F2_OUTPUT_DIR,
  DEFAULT_GALLERY_DL_COOKIES,
  DEFAULT_CHROME_USER_DATA,
  MINIMUM_GALLERY_DL_VERSION,
  RUNTIME_VERSION,
  PLATFORM_ALIASES,
  PLATFORM_KEYS,
  HOST_PATTERNS,
  PLATFORM_PROBE_URLS,
};
