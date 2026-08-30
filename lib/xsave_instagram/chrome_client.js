"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const repo_root = path.resolve(__dirname, "..", "..");
const { DEFAULT_CHROME_USER_DATA } = require("../gather_doctor/constants");

function load_playwright() {
  try {
    return require("playwright");
  } catch (_error) {
    return require(path.join(repo_root, "node_modules", "playwright"));
  }
}

function normalize_username(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function extract_profile_username(url) {
  try {
    const parsed = new URL(url);
    const first = String(parsed.pathname.split("/").filter(Boolean)[0] || "");
    return normalize_username(first);
  } catch (_error) {
    return "";
  }
}

function caption_from_node(node) {
  const edges =
    (node &&
      node.edge_media_to_caption &&
      Array.isArray(node.edge_media_to_caption.edges) &&
      node.edge_media_to_caption.edges) ||
    [];
  return String((edges[0] && edges[0].node && edges[0].node.text) || "").trim();
}

function carousel_from_node(node) {
  const edges =
    (node &&
      node.edge_sidecar_to_children &&
      Array.isArray(node.edge_sidecar_to_children.edges) &&
      node.edge_sidecar_to_children.edges) ||
    [];
  return edges
    .map((edge) => {
      const child = edge && edge.node;
      if (!child) return null;
      if (child.video_url)
        return { url: String(child.video_url), type: "video" };
      if (child.display_url)
        return { url: String(child.display_url), type: "image" };
      return null;
    })
    .filter(Boolean);
}

function normalize_media_node(node) {
  if (!node || typeof node !== "object") return null;
  const shortcode = String(node.shortcode || node.code || "").trim();
  if (!shortcode) return null;
  const owner = node.owner || node.user || {};
  const image_urls = [];
  if (node.display_url) image_urls.push(String(node.display_url));
  return {
    shortcode,
    pk: String(node.id || node.pk || ""),
    typename: String(node.__typename || ""),
    author: {
      username: String(owner.username || ""),
      full_name: String(owner.full_name || owner.username || ""),
    },
    caption: caption_from_node(node) || String(node.caption || ""),
    taken_at: node.taken_at_timestamp || node.taken_at || "",
    like_count:
      (node.edge_liked_by && node.edge_liked_by.count) || node.like_count || 0,
    comment_count:
      (node.edge_media_to_comment && node.edge_media_to_comment.count) ||
      node.comment_count ||
      0,
    video_url: String(node.video_url || "").trim(),
    image_urls,
    carousel: carousel_from_node(node),
    is_prohibited: Boolean(node.is_prohibited),
  };
}

function walk_for_nodes(value, found) {
  if (!value || typeof value !== "object") return;
  if (value.shortcode || value.code) {
    const item = normalize_media_node(value);
    if (item) found.push(item);
  }
  if (Array.isArray(value)) {
    for (const entry of value) walk_for_nodes(entry, found);
    return;
  }
  for (const key of Object.keys(value)) walk_for_nodes(value[key], found);
}

function harvest_items_from_payload(payload) {
  const found = [];
  walk_for_nodes(payload, found);
  const seen = new Set();
  const items = [];
  for (const item of found) {
    if (seen.has(item.shortcode)) continue;
    seen.add(item.shortcode);
    items.push(item);
  }
  return items;
}

async function resolve_cookie_header(options = {}) {
  if (options.cookie_file) {
    if (!fs.existsSync(options.cookie_file))
      throw new Error("Missing Instagram cookie");
    const raw = fs.readFileSync(options.cookie_file, "utf8").trim();
    if (raw) return raw;
    throw new Error("Missing Instagram cookie");
  }
  if (!options.chrome_profile) return "";
  const cookie_export = require("../gather_doctor/cookie_export");
  const { list_chrome_profiles } = require("../gather_doctor/chrome_profile");
  const listed = await list_chrome_profiles("", {
    chrome_profile: options.chrome_profile,
  });
  const profile = listed.profiles && listed.profiles[0];
  const directory = profile ? profile.directory : options.chrome_profile;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xsave-ig-ck-"));
  const cookies_path = path.join(tmp, "cookies.txt");
  const exported = await cookie_export.export_netscape_cookies({
    chrome_profile: directory,
    output_path: cookies_path,
    platform_key: "instagram",
  });
  if (!exported.ok) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error("cookie export failed");
  }
  const header = await cookie_export.netscape_to_cookie_header(
    cookies_path,
    "instagram",
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  return header;
}

function header_to_cookies(header) {
  return String(header || "")
    .split(";")
    .map((part) => {
      const text = part.trim();
      const idx = text.indexOf("=");
      if (idx < 1) return null;
      return {
        name: text.slice(0, idx),
        value: text.slice(idx + 1),
        domain: ".instagram.com",
        path: "/",
      };
    })
    .filter(Boolean);
}

async function read_session_username(page) {
  if (!page || typeof page.evaluate !== "function") return "";
  const raw = await page.evaluate(() => {
    const input = document.querySelector('input[name="username"]');
    if (input && input.value) return String(input.value);
    const alt = document.querySelector(
      'img[alt$="profile picture"], img[alt$="的头像"]',
    );
    const from_alt = alt && alt.getAttribute("alt");
    if (from_alt) return String(from_alt).replace(/'s profile picture.*$/i, "");
    return "";
  });
  return normalize_username(raw);
}

async function assert_logged_in_profile({ page, url, source } = {}) {
  const wanted = extract_profile_username(url);
  const session = await read_session_username(page);
  if (!wanted || !session || wanted !== session) {
    throw new Error(`source ${source} requires the logged-in profile URL`);
  }
}

function default_persistent_user_data_dir() {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "command_base",
    "xsave_instagram",
    "chrome",
  );
}

function should_skip_profile_path(file_path) {
  return /\/(Cache|Code Cache|GPUCache|OptimizationGuide|SingletonLock|SingletonCookie|SingletonSocket)(\/|$)/.test(
    file_path,
  );
}

function clear_singleton_locks(user_data_dir) {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"])
    fs.rmSync(path.join(user_data_dir, name), { force: true });
}

function seed_chrome_user_data(source_dir, user_data_dir) {
  const dest_default = path.join(user_data_dir, "Default");
  if (fs.existsSync(dest_default)) return;
  fs.mkdirSync(user_data_dir, { recursive: true });
  fs.cpSync(source_dir, dest_default, {
    recursive: true,
    dereference: true,
    filter: (src) => !should_skip_profile_path(src),
  });
}

function prepare_persistent_user_data({
  source_dir,
  persistent_user_data_dir,
} = {}) {
  const user_data_dir =
    persistent_user_data_dir || default_persistent_user_data_dir();
  seed_chrome_user_data(source_dir, user_data_dir);
  clear_singleton_locks(user_data_dir);
  return user_data_dir;
}

async function resolve_profile_source_dir({
  chrome_profile,
  chrome_user_data_dir,
  profile_source_dir,
} = {}) {
  if (profile_source_dir) return profile_source_dir;
  const wanted = String(chrome_profile || "").trim();
  if (!wanted) return "";
  const { list_chrome_profiles } = require("../gather_doctor/chrome_profile");
  const listed = await list_chrome_profiles(chrome_user_data_dir || "", {
    chrome_profile: wanted,
  });
  const directory =
    listed.profiles && listed.profiles[0]
      ? listed.profiles[0].directory
      : wanted;
  const root = listed.root || DEFAULT_CHROME_USER_DATA;
  return path.join(root, directory);
}

async function open_persistent_session({
  chrome_profile,
  playwright,
  chrome_user_data_dir,
  profile_source_dir,
  persistent_user_data_dir,
} = {}) {
  const source_dir = await resolve_profile_source_dir({
    chrome_profile,
    chrome_user_data_dir,
    profile_source_dir,
  });
  if (!source_dir || !fs.existsSync(source_dir))
    throw new Error("chrome profile directory missing");
  const user_data = prepare_persistent_user_data({
    source_dir,
    persistent_user_data_dir,
  });
  const { chromium } = playwright || load_playwright();
  const context = await chromium.launchPersistentContext(user_data, {
    headless: false,
    channel: "chrome",
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
    chromiumSandbox: true,
    ignoreDefaultArgs: ["--enable-automation"],
  });
  const page =
    (context.pages && context.pages()[0]) || (await context.newPage());
  if (typeof page.setDefaultTimeout === "function")
    page.setDefaultTimeout(30000);
  return {
    browser: context,
    context,
    page,
    async close() {
      await context.close();
    },
  };
}

async function open_cookie_session({ cookie_header, playwright } = {}) {
  if (!cookie_header) throw new Error("missing instagram cookie");
  const { chromium } = playwright || load_playwright();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
  });
  await context.addCookies(header_to_cookies(cookie_header));
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    async close() {
      await browser.close();
    },
  };
}

function chrome_cdp_url() {
  return (
    String(process.env.COMMAND_BASE_CHROME_CDP || "").trim() ||
    "http://127.0.0.1:9222"
  );
}

async function try_open_cdp_session(playwright) {
  const { chromium } = playwright || load_playwright();
  if (!chromium || typeof chromium.connectOverCDP !== "function") return null;
  try {
    const browser = await chromium.connectOverCDP(chrome_cdp_url());
    const context =
      browser.contexts && browser.contexts()[0] ? browser.contexts()[0] : null;
    if (!context) {
      await browser.close();
      return null;
    }
    const page =
      typeof context.newPage === "function"
        ? await context.newPage()
        : context.pages && context.pages()[0];
    if (!page) {
      await browser.close();
      return null;
    }
    if (typeof page.setDefaultTimeout === "function")
      page.setDefaultTimeout(30000);
    return {
      browser,
      context,
      page,
      async close() {
        await browser.close();
      },
    };
  } catch (_error) {
    return null;
  }
}

async function open_session({
  cookie_header,
  chrome_profile,
  playwright,
  chrome_user_data_dir,
  profile_source_dir,
  persistent_user_data_dir,
} = {}) {
  const cdp = await try_open_cdp_session(playwright);
  if (cdp) return cdp;
  if (chrome_profile || profile_source_dir)
    return open_persistent_session({
      chrome_profile,
      playwright,
      chrome_user_data_dir,
      profile_source_dir,
      persistent_user_data_dir,
    });
  return open_cookie_session({ cookie_header, playwright });
}

function list_page_urls(source, url, session_username) {
  const username =
    extract_profile_username(url) || normalize_username(session_username || "");
  if (source === "video") return [String(url || "")];
  if (source === "like")
    return ["https://www.instagram.com/your_activity/interactions/likes/"];
  if (source === "collection" && username)
    return [`https://www.instagram.com/${username}/saved/all-posts/`];
  if (source === "post" && username)
    return [
      `https://www.instagram.com/${username}/`,
      `https://www.instagram.com/${username}/reels/`,
    ];
  return [String(url || "")];
}

async function resolve_list_username({
  page,
  source,
  url,
  session_username,
} = {}) {
  const from_url = extract_profile_username(url);
  if (from_url) return from_url;
  const from_arg = normalize_username(session_username || "");
  if (from_arg) return from_arg;
  if (source !== "collection") return "";
  const from_session = await read_session_username(page);
  if (!from_session)
    throw new Error("source collection requires a logged-in Instagram session");
  return from_session;
}

function attach_graphql_intercept(page, bucket) {
  if (!page || typeof page.on !== "function") return;
  page.on("response", async (response) => {
    try {
      const url = String((response && response.url && response.url()) || "");
      if (!/graphql\/query/i.test(url)) return;
      const json = await response.json();
      bucket.push(...harvest_items_from_payload(json));
    } catch (_error) {
      /* ignore non-json */
    }
  });
}

async function prepare_list_page(
  page,
  { source, url, session_username } = {},
) {
  const username = await resolve_list_username({
    page,
    source,
    url,
    session_username,
  });
  const targets = list_page_urls(source, url, username);
  if (!page || typeof page.goto !== "function") return;
  if (targets[0]) await page.goto(targets[0], { waitUntil: "domcontentloaded" });
}

async function collect_list({
  page,
  source,
  url,
  session_username,
  limit,
  should_stop,
} = {}) {
  const username = await resolve_list_username({
    page,
    source,
    url,
    session_username,
  });
  const items = [];
  const seen = new Set();
  const intercepted = [];
  attach_graphql_intercept(page, intercepted);
  const targets = list_page_urls(source, url, username);
  for (const target of targets) {
    if (page && typeof page.goto === "function")
      await page.goto(target, { waitUntil: "domcontentloaded" });
    if (page && page.keyboard && page.keyboard.press)
      await page.keyboard.press("End").catch(() => {});
    for (const item of intercepted.concat(harvest_items_from_payload({}))) {
      if (!item || seen.has(item.shortcode)) continue;
      seen.add(item.shortcode);
      items.push(item);
    }
    if (limit && items.length >= limit) break;
    if (should_stop && (await should_stop(items))) break;
  }
  return limit ? items.slice(0, limit) : items;
}

async function fetch_comments({ page, shortcode, max_comment } = {}) {
  const limit = Number(max_comment) || 0;
  if (!limit || !page || typeof page.evaluate !== "function") return [];
  const payload = await page.evaluate(
    async ({ code, cap }) => {
      const response = await fetch(
        `/api/v1/media/${code}/comments/?can_support_threading=true`,
        { credentials: "include" },
      );
      const json = await response.json().catch(() => ({}));
      const list = Array.isArray(json.comments) ? json.comments : [];
      return list.slice(0, cap);
    },
    { code: shortcode, cap: limit },
  );
  return Array.isArray(payload) ? payload.slice(0, limit) : [];
}

module.exports = {
  assert_logged_in_profile,
  collect_list,
  default_persistent_user_data_dir,
  extract_profile_username,
  fetch_comments,
  harvest_items_from_payload,
  list_page_urls,
  normalize_media_node,
  normalize_username,
  open_session,
  prepare_list_page,
  read_session_username,
  resolve_cookie_header,
  resolve_list_username,
};
