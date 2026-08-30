"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const chalk = require("chalk");

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
  const from_edges = String(
    (edges[0] && edges[0].node && edges[0].node.text) || "",
  ).trim();
  if (from_edges) return from_edges;
  if (node && node.caption && typeof node.caption === "object")
    return String(node.caption.text || "").trim();
  return String((node && node.caption) || "").trim();
}

function image_urls_from_node(node) {
  const urls = [];
  if (node && node.display_url) urls.push(String(node.display_url));
  const candidates =
    (node &&
      node.image_versions2 &&
      Array.isArray(node.image_versions2.candidates) &&
      node.image_versions2.candidates) ||
    [];
  for (const item of candidates) {
    if (item && item.url) urls.push(String(item.url));
  }
  return [...new Set(urls)];
}

function video_url_from_node(node) {
  const direct = String((node && node.video_url) || "").trim();
  if (direct) return direct;
  const versions =
    (node && Array.isArray(node.video_versions) && node.video_versions) || [];
  return String((versions[0] && versions[0].url) || "").trim();
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
  return {
    shortcode,
    pk: String(node.id || node.pk || ""),
    typename: String(node.__typename || ""),
    author: {
      username: String(owner.username || ""),
      full_name: String(owner.full_name || owner.username || ""),
    },
    caption: caption_from_node(node),
    taken_at: node.taken_at_timestamp || node.taken_at || "",
    like_count:
      (node.edge_liked_by && node.edge_liked_by.count) || node.like_count || 0,
    comment_count:
      (node.edge_media_to_comment && node.edge_media_to_comment.count) ||
      node.comment_count ||
      0,
    video_url: video_url_from_node(node),
    image_urls: image_urls_from_node(node),
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

const WBLOKS_MEDIA_RE =
  /"(\d{15,}_\d+)"\s*,\s*"([A-Za-z0-9_-]{5,14})"\s*,\s*"([^"]*)"\s*,\s*\(bk\.action\.i32\.Const,\s*(\d+)\)\s*,\s*"(https:[^"]+)"/g;

function unescape_ig_url(value) {
  return String(value || "").replace(/\\\//g, "/");
}

function collect_strings(value, found) {
  if (typeof value === "string") {
    found.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collect_strings(entry, found);
    return;
  }
  for (const key of Object.keys(value)) collect_strings(value[key], found);
}

function parse_wbloks_input(input) {
  if (input && typeof input === "object") return input;
  const raw = String(input || "").replace(/^for \(;;\);/, "");
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function harvest_items_from_wbloks(input) {
  const parsed = parse_wbloks_input(input);
  const strings = [];
  if (parsed) collect_strings(parsed, strings);
  else strings.push(String(input || ""));
  const blob = strings.join("\n");
  const seen = new Set();
  const items = [];
  WBLOKS_MEDIA_RE.lastIndex = 0;
  let match;
  while ((match = WBLOKS_MEDIA_RE.exec(blob))) {
    const shortcode = String(match[2] || "").trim();
    if (!shortcode || seen.has(shortcode)) continue;
    seen.add(shortcode);
    const image_url = unescape_ig_url(match[5]);
    const product = String(match[3] || "");
    items.push({
      shortcode,
      pk: String(match[1] || "").split("_")[0],
      typename: product,
      author: { username: "", full_name: "" },
      caption: "",
      taken_at: "",
      like_count: 0,
      comment_count: 0,
      video_url: "",
      image_urls: image_url ? [image_url] : [],
      carousel: [],
      is_prohibited: false,
    });
  }
  return items;
}

function is_likes_wbloks_url(url) {
  return (
    /async\/wbloks\/fetch/i.test(String(url || "")) &&
    /activity_center\.liked_/i.test(String(url || ""))
  );
}

function is_likes_list_page(page) {
  const href =
    page && typeof page.url === "function" ? String(page.url() || "") : "";
  return /your_activity\/interactions\/likes/i.test(href);
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

function apply_persist_profile_name(user_data_dir, profile_name) {
  const name = String(profile_name || "").trim();
  if (!name) return;
  const local_state_path = path.join(user_data_dir, "Local State");
  let data = {};
  if (fs.existsSync(local_state_path)) {
    try {
      data = JSON.parse(fs.readFileSync(local_state_path, "utf8"));
    } catch (_error) {
      data = {};
    }
  }
  if (!data.profile || typeof data.profile !== "object") data.profile = {};
  if (!data.profile.info_cache || typeof data.profile.info_cache !== "object")
    data.profile.info_cache = {};
  const current =
    data.profile.info_cache.Default &&
    typeof data.profile.info_cache.Default === "object"
      ? data.profile.info_cache.Default
      : {};
  data.profile.info_cache.Default = { ...current, name };
  fs.writeFileSync(local_state_path, `${JSON.stringify(data)}\n`);
}

function prepare_persistent_user_data({
  source_dir,
  persistent_user_data_dir,
  profile_name,
} = {}) {
  const user_data_dir =
    persistent_user_data_dir || default_persistent_user_data_dir();
  seed_chrome_user_data(source_dir, user_data_dir);
  apply_persist_profile_name(user_data_dir, profile_name);
  clear_singleton_locks(user_data_dir);
  return user_data_dir;
}

async function resolve_profile_source({
  chrome_profile,
  chrome_user_data_dir,
  profile_source_dir,
} = {}) {
  if (profile_source_dir)
    return {
      source_dir: profile_source_dir,
      profile_name: String(chrome_profile || "").trim() || "Default",
    };
  const wanted = String(chrome_profile || "").trim();
  if (!wanted) return { source_dir: "", profile_name: "" };
  const { list_chrome_profiles } = require("../gather_doctor/chrome_profile");
  const listed = await list_chrome_profiles(chrome_user_data_dir || "", {
    chrome_profile: wanted,
  });
  const exact_dir = (listed.profiles || []).find(
    (profile) => profile.directory === wanted,
  );
  const profile = exact_dir || (listed.profiles && listed.profiles[0]);
  const directory = profile ? profile.directory : wanted;
  const root = listed.root || DEFAULT_CHROME_USER_DATA;
  return {
    source_dir: path.join(root, directory),
    profile_name: (profile && profile.name) || directory,
  };
}

async function open_persistent_session({
  chrome_profile,
  playwright,
  chrome_user_data_dir,
  profile_source_dir,
  persistent_user_data_dir,
} = {}) {
  const { source_dir, profile_name } = await resolve_profile_source({
    chrome_profile,
    chrome_user_data_dir,
    profile_source_dir,
  });
  if (!source_dir || !fs.existsSync(source_dir))
    throw new Error("chrome profile directory missing");
  const user_data = prepare_persistent_user_data({
    source_dir,
    persistent_user_data_dir,
    profile_name,
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
  const browser = await chromium.launch({ headless: false, channel: "chrome" });
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
  if (cookie_header) return open_cookie_session({ cookie_header, playwright });
  if (!chrome_profile && !profile_source_dir) {
    const cdp = await try_open_cdp_session(playwright);
    if (cdp) return cdp;
  }
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

function is_login_or_challenge_page(title, url) {
  const href = String(url || "");
  if (
    /accounts\/login|accounts\/onetap|\/challenge\/|two_factor|checkpoint/i.test(
      href,
    )
  )
    return true;
  if (href) return false;
  return /log\s*in|登录|sign\s*in/i.test(String(title || ""));
}

async function wait_for_page_ready(page, { timeout_ms } = {}) {
  if (!page) return { login: false };
  const can_read =
    typeof page.title === "function" || typeof page.url === "function";
  if (!can_read) return { login: false };
  const deadline = Date.now() + (Number(timeout_ms) || 180000);
  let login = false;
  while (Date.now() < deadline) {
    const title =
      typeof page.title === "function"
        ? await page.title().catch(() => "")
        : "";
    const url = typeof page.url === "function" ? page.url() : "";
    if (!is_login_or_challenge_page(title, url)) return { login, title, url };
    if (!login)
      console.warn(
        chalk.yellow(
          "Instagram login: complete it in the Chrome window, then wait",
        ),
      );
    login = true;
    if (typeof page.waitForTimeout === "function")
      await page.waitForTimeout(1000);
    else await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("instagram login not completed");
}

function is_list_response_url(url) {
  return /graphql\/query|\/api\/graphql|\/api\/v1\/(?:feed\/liked|your_activity|media\/liked)/i.test(
    String(url || ""),
  );
}

const intercept_buckets = new WeakMap();

function attach_list_intercept(page, bucket) {
  if (!page || typeof page.on !== "function") return;
  page.on("response", async (response) => {
    try {
      const url = String((response && response.url && response.url()) || "");
      if (is_likes_wbloks_url(url)) {
        const text =
          typeof response.text === "function" ? await response.text() : "";
        bucket.push(...harvest_items_from_wbloks(text));
        return;
      }
      if (is_likes_list_page(page)) return;
      if (!is_list_response_url(url)) return;
      const json = await response.json();
      bucket.push(...harvest_items_from_payload(json));
    } catch (_error) {
      /* ignore non-json */
    }
  });
}

function ensure_list_intercept(page) {
  if (!page) return [];
  if (intercept_buckets.has(page)) return intercept_buckets.get(page);
  const bucket = [];
  attach_list_intercept(page, bucket);
  intercept_buckets.set(page, bucket);
  return bucket;
}

async function wait_for_intercept_items(bucket, timeout_ms) {
  const deadline = Date.now() + (Number(timeout_ms) || 8000);
  while (Date.now() < deadline) {
    if (Array.isArray(bucket) && bucket.length) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return Boolean(bucket && bucket.length);
}

async function wait_for_new_intercept_items(
  bucket,
  previous_length,
  timeout_ms,
) {
  const deadline = Date.now() + (Number(timeout_ms) || 4000);
  while (Date.now() < deadline) {
    if (Array.isArray(bucket) && bucket.length > previous_length) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return Boolean(bucket && bucket.length > previous_length);
}

async function scroll_list_container(page, { bounce, phase } = {}) {
  if (!page || typeof page.evaluate !== "function") return;
  await page
    .evaluate(
      ({ bounce, phase }) => {
        const nodes = Array.from(
          document.querySelectorAll("div, main, section, article"),
        );
        let best = null;
        let best_overflow = 0;
        for (const node of nodes) {
          const style = window.getComputedStyle(node);
          if (style.overflowY !== "auto" && style.overflowY !== "scroll")
            continue;
          const extra = node.scrollHeight - node.clientHeight;
          if (extra > best_overflow && extra > 20) {
            best = node;
            best_overflow = extra;
          }
        }
        const viewport = best
          ? best.clientHeight
          : Math.max(window.innerHeight, 400);
        if (phase === "up") {
          if (best) best.scrollTop = Math.max(0, best.scrollTop - viewport);
          else window.scrollBy(0, -viewport);
          return;
        }
        if (best) {
          best.scrollTop = best.scrollHeight;
          return;
        }
        window.scrollTo(0, document.documentElement.scrollHeight);
        void bounce;
      },
      { bounce: Boolean(bounce), phase: phase || "down" },
    )
    .catch(() => {});
}

async function default_scroll_for_more(page, { bounce } = {}) {
  if (!page) return;
  if (bounce) {
    await scroll_list_container(page, { bounce: true, phase: "up" });
    if (typeof page.waitForTimeout === "function")
      await page.waitForTimeout(400);
    else await new Promise((resolve) => setTimeout(resolve, 400));
  }
  await scroll_list_container(page, { bounce: Boolean(bounce), phase: "down" });
  if (page.keyboard && typeof page.keyboard.press === "function")
    await page.keyboard.press("End").catch(() => {});
  if (typeof page.waitForTimeout === "function")
    await page.waitForTimeout(bounce ? 700 : 400);
}

function liked_feed_url(host, cursor) {
  const url = new URL("/api/v1/feed/liked/", host);
  url.searchParams.set("count", "50");
  if (cursor) url.searchParams.set("max_id", String(cursor));
  return url.toString();
}

function summarize_liked_payload(json, http) {
  if (!json || !Array.isArray(json.items)) return null;
  return {
    http: Number(http) || 0,
    items: json.items,
    more_available: Boolean(json.more_available),
    next_max_id: String(json.next_max_id || ""),
  };
}

const IPHONE_LIKED_UA =
  "Instagram 361.0.0.35.82 (iPad13,8; iOS 18_0; en_US; en-US; scale=2.00; 2048x2732; 674117118) AppleWebKit/420+";

function page_context(page) {
  if (!page) return null;
  if (typeof page.context === "function") return page.context();
  return page.context || null;
}

function page_request(page) {
  const context = page_context(page);
  if (context && context.request && typeof context.request.get === "function")
    return context.request;
  if (page && page.request && typeof page.request.get === "function")
    return page.request;
  return null;
}

async function read_csrf_token(page) {
  const context = page_context(page);
  if (context && typeof context.cookies === "function") {
    const cookies = await context.cookies("https://www.instagram.com");
    const csrf = (cookies || []).find(
      (item) => item && item.name === "csrftoken",
    );
    if (csrf && csrf.value) return String(csrf.value);
  }
  if (!page || typeof page.evaluate !== "function") return "";
  const raw = await page
    .evaluate(() => {
      const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
      return match ? decodeURIComponent(match[1]) : "";
    })
    .catch(() => "");
  return String(raw || "");
}

function next_max_id_from_text(text) {
  const match = String(text || "").match(/"next_max_id"\s*:\s*"?([^",}\s]+)"?/);
  return match ? String(match[1] || "").trim() : "";
}

async function read_liked_response(response) {
  if (!response) return null;
  const http =
    typeof response.status === "function" ? response.status() : response.status;
  if (typeof response.text === "function") {
    const text = await response.text();
    let json = {};
    try {
      json = JSON.parse(text);
    } catch (_error) {
      json = {};
    }
    const summarized = summarize_liked_payload(json, http);
    if (!summarized) return null;
    const next_max_id = next_max_id_from_text(text);
    if (next_max_id) summarized.next_max_id = next_max_id;
    return summarized;
  }
  if (typeof response.json !== "function") return null;
  const json = await response.json().catch(() => ({}));
  return summarize_liked_payload(json, http);
}

async function fetch_liked_page_via_request(page, { cursor } = {}) {
  const request = page_request(page);
  if (!request) return null;
  const csrf = await read_csrf_token(page);
  const headers = {
    Accept: "*/*",
    "User-Agent": IPHONE_LIKED_UA,
    "X-CSRFToken": csrf,
    "X-IG-App-ID": "124024574287414",
    "X-IG-Capabilities": "36r/F/8=",
    "X-IG-Connection-Type": "WiFi",
  };
  const hosts = ["https://i.instagram.com", "https://www.instagram.com"];
  for (const host of hosts) {
    try {
      const response = await request.get(liked_feed_url(host, cursor), {
        headers,
      });
      const summarized = await read_liked_response(response);
      if (summarized && (summarized.items.length || summarized.more_available))
        return summarized;
    } catch (_error) {
      /* try next host */
    }
  }
  return null;
}

async function fetch_liked_page_via_evaluate(page, { cursor } = {}) {
  if (!page || typeof page.evaluate !== "function") return null;
  return page.evaluate(
    async ({ max_id }) => {
      const params = new URLSearchParams({ count: "50" });
      if (max_id) params.set("max_id", String(max_id));
      const csrf_match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
      const response = await fetch(`/api/v1/feed/liked/?${params.toString()}`, {
        credentials: "include",
        headers: {
          "X-CSRFToken": csrf_match ? decodeURIComponent(csrf_match[1]) : "",
          "X-IG-App-ID": "936619743392459",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      const json = await response.json().catch(() => ({}));
      return {
        http: response.status,
        items: Array.isArray(json.items) ? json.items : [],
        more_available: Boolean(json.more_available),
        next_max_id: String(json.next_max_id || ""),
      };
    },
    { max_id: cursor || "" },
  );
}

async function fetch_liked_page(page, { cursor } = {}) {
  const via_request = await fetch_liked_page_via_request(page, { cursor });
  if (via_request) return via_request;
  return fetch_liked_page_via_evaluate(page, { cursor });
}

function drain_intercepted(intercepted, seen, items) {
  let added = 0;
  for (const item of intercepted) {
    if (!item || seen.has(item.shortcode)) continue;
    seen.add(item.shortcode);
    items.push(item);
    added += 1;
  }
  return added;
}

async function prepare_list_page(
  page,
  { source, url, session_username, login_timeout_ms } = {},
) {
  const username = await resolve_list_username({
    page,
    source,
    url,
    session_username,
  });
  const targets = list_page_urls(source, url, username);
  ensure_list_intercept(page);
  if (!page || typeof page.goto !== "function") return;
  if (targets[0])
    await page.goto(targets[0], { waitUntil: "domcontentloaded" });
  const ready = await wait_for_page_ready(page, {
    timeout_ms: login_timeout_ms,
  });
  if (ready.login && targets[0])
    await page.goto(targets[0], { waitUntil: "domcontentloaded" });
}

async function collect_list({
  page,
  source,
  url,
  session_username,
  limit,
  should_stop,
  intercept_timeout_ms,
  new_item_timeout_ms,
  idle_scroll_limit,
  scroll_for_more,
} = {}) {
  const username = await resolve_list_username({
    page,
    source,
    url,
    session_username,
  });
  const items = [];
  const seen = new Set();
  const intercepted = ensure_list_intercept(page);
  const targets = list_page_urls(source, url, username);
  const scroll = scroll_for_more || default_scroll_for_more;
  const idle_limit = Number(idle_scroll_limit) || (source === "like" ? 12 : 5);
  const more_timeout =
    Number(new_item_timeout_ms) ||
    (source === "like" ? 6000 : Number(intercept_timeout_ms) || 4000);

  async function paginate_liked_feed() {
    let cursor = "";
    let used = false;
    let page_index = 0;
    for (;;) {
      const payload = await fetch_liked_page(page, { cursor });
      if (!payload || !Array.isArray(payload.items)) return used;
      if (!payload.items.length && !payload.more_available) return used;
      used = true;
      page_index += 1;
      const harvested = harvest_items_from_payload({ items: payload.items });
      let added = 0;
      for (const item of harvested) {
        if (!item || seen.has(item.shortcode)) continue;
        seen.add(item.shortcode);
        items.push(item);
        added += 1;
      }
      console.log(
        chalk.cyan(
          `liked feed page ${page_index}: +${added}/${payload.items.length} http=${payload.http || "?"} more=${payload.more_available ? 1 : 0} next=${payload.next_max_id || "-"} (${items.length} total)`,
        ),
      );
      if (limit && items.length >= limit) return true;
      if (!payload.more_available || !payload.next_max_id) return true;
      cursor = payload.next_max_id;
    }
  }

  for (const target of targets) {
    if (page && typeof page.goto === "function")
      await page.goto(target, { waitUntil: "domcontentloaded" });
    if (source === "like") {
      drain_intercepted(intercepted, seen, items);
      const used_liked_api = await paginate_liked_feed();
      if (used_liked_api) break;
    }
    await wait_for_intercept_items(intercepted, intercept_timeout_ms);
    drain_intercepted(intercepted, seen, items);
    if (source === "like")
      console.log(
        chalk.cyan(`liked wbloks: ${items.length} item(s) after first page`),
      );
    if (limit && items.length >= limit) break;
    if (source !== "like" && should_stop && (await should_stop(items))) break;
    if (source === "video") break;
    let idle_scrolls = 0;
    while (!limit || items.length < limit) {
      const before = intercepted.length;
      const count_before = items.length;
      await scroll(page, { bounce: idle_scrolls > 0 });
      await wait_for_new_intercept_items(intercepted, before, more_timeout);
      drain_intercepted(intercepted, seen, items);
      if (source === "like" && items.length !== count_before)
        console.log(
          chalk.cyan(
            `liked wbloks: +${items.length - count_before} (${items.length} total)`,
          ),
        );
      if (source !== "like" && should_stop && (await should_stop(items)))
        return limit ? items.slice(0, limit) : items;
      if (items.length === count_before) {
        idle_scrolls += 1;
        if (idle_scrolls >= idle_limit) break;
        continue;
      }
      idle_scrolls = 0;
    }
    if (limit && items.length >= limit) break;
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
  default_scroll_for_more,
  is_login_or_challenge_page,
  default_persistent_user_data_dir,
  extract_profile_username,
  fetch_comments,
  harvest_items_from_payload,
  harvest_items_from_wbloks,
  list_page_urls,
  normalize_media_node,
  normalize_username,
  open_session,
  prepare_list_page,
  prepare_persistent_user_data,
  read_session_username,
  resolve_cookie_header,
  resolve_list_username,
};
