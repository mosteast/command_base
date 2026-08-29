"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const chalk = require("chalk");

const repo_root = path.resolve(__dirname, "..", "..");

function load_playwright() {
  try {
    return require("playwright");
  } catch (_error) {
    return require(path.join(repo_root, "node_modules", "playwright"));
  }
}

function list_endpoint(mode) {
  if (mode === "like") return "/aweme/v1/web/aweme/favorite/";
  if (mode === "post") return "/aweme/v1/web/aweme/post/";
  if (mode === "collection") return "/aweme/v1/web/aweme/listcollection/";
  if (mode === "one") return "/aweme/v1/web/aweme/detail/";
  throw new Error(`unsupported mode ${mode}`);
}

async function resolve_cookie_header(options = {}) {
  if (options.cookie_file) {
    const raw = fs.readFileSync(options.cookie_file, "utf8").trim();
    if (raw) return raw;
  }
  if (!options.chrome_profile) return "";
  const cookie_export = require("../gather_doctor/cookie_export");
  const { list_chrome_profiles } = require("../gather_doctor/chrome_profile");
  const listed = await list_chrome_profiles("", {
    chrome_profile: options.chrome_profile,
  });
  const profile = listed.profiles && listed.profiles[0];
  const directory = profile ? profile.directory : options.chrome_profile;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xsave-dy-ck-"));
  const cookies_path = path.join(tmp, "cookies.txt");
  const exported = await cookie_export.export_netscape_cookies({
    chrome_profile: directory,
    output_path: cookies_path,
    platform_key: "douyin",
  });
  if (!exported.ok) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error("cookie export failed");
  }
  const header = await cookie_export.netscape_to_cookie_header(
    cookies_path,
    "douyin",
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
        domain: ".douyin.com",
        path: "/",
      };
    })
    .filter(Boolean);
}

function summarize_page(page, max_cursor_in) {
  const list = Array.isArray(page.aweme_list) ? page.aweme_list : [];
  return {
    max_cursor_in,
    max_cursor: page.max_cursor || 0,
    has_more: page.has_more ? 1 : 0,
    status_code: page.status_code,
    aweme_list: list,
  };
}

async function fetch_list_page(page, { mode, sec_user_id, cursor, aweme_id } = {}) {
  const endpoint = list_endpoint(mode);
  const evaluate = page.evaluate(
    async ({ endpoint, mode, sec, cursor, aweme_id }) => {
      const params = new URLSearchParams({
        device_platform: "webapp",
        aid: "6383",
        channel: "channel_pc_web",
      });
      if (mode === "one") params.set("aweme_id", String(aweme_id || ""));
      else {
        if (sec) params.set("sec_user_id", sec);
        params.set("max_cursor", String(cursor || 0));
        params.set("count", "20");
      }
      const response = await fetch(`${endpoint}?${params.toString()}`, {
        credentials: "include",
      });
      const json = await response.json().catch(() => ({}));
      const detail = json.aweme_detail || json.aweme_info;
      const list = Array.isArray(json.aweme_list)
        ? json.aweme_list
        : detail
          ? [detail]
          : [];
      return {
        http: response.status,
        status_code: json.status_code,
        has_more: json.has_more,
        max_cursor: json.max_cursor,
        aweme_list: list,
      };
    },
    {
      endpoint,
      mode,
      sec: sec_user_id,
      cursor: cursor || 0,
      aweme_id,
    },
  );
  return Promise.race([
    evaluate,
    new Promise((resolve) => {
      setTimeout(
        () =>
          resolve({
            http: 0,
            status_code: -1,
            has_more: 0,
            aweme_list: [],
          }),
        15000,
      );
    }),
  ]);
}

function is_ok_list_page(item) {
  if (!item || item.http !== 200) return false;
  if (item.status_code != null && item.status_code !== 0) return false;
  return true;
}

async function wait_intercept_pending(intercepted) {
  if (intercepted && typeof intercepted.wait_pending === "function")
    await intercepted.wait_pending();
}

async function parse_response_json(response) {
  if (typeof response.body === "function") {
    const buffer = await response.body();
    if (!buffer || !buffer.length) throw new Error("empty body");
    const text = Buffer.isBuffer(buffer)
      ? buffer.toString("utf8")
      : Buffer.from(buffer).toString("utf8");
    return JSON.parse(text);
  }
  return response.json();
}

function read_response_json(response, timeout_ms) {
  return Promise.race([
    parse_response_json(response),
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("response json timeout")),
        timeout_ms || 20000,
      );
    }),
  ]);
}

async function wait_for_intercept_items(intercepted, timeout_ms) {
  if (!intercepted || typeof intercepted.wait_pending !== "function")
    return Boolean(
      intercepted &&
        intercepted.some(
          (item) => is_ok_list_page(item) && (item.aweme_list || []).length,
        ),
    );
  const deadline = Date.now() + (timeout_ms || 20000);
  while (Date.now() < deadline) {
    await wait_intercept_pending(intercepted);
    if (
      intercepted.some(
        (item) => is_ok_list_page(item) && (item.aweme_list || []).length,
      )
    )
      return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function attach_list_intercept(page, mode) {
  const intercepted = [];
  const pending = [];
  intercepted.wait_pending = async function wait_pending() {
    await Promise.all(pending);
  };
  if (!page || typeof page.on !== "function") return intercepted;
  const needle = list_endpoint(mode);
  page.on("response", (response) => {
    const url = typeof response.url === "function" ? response.url() : "";
    if (!url.includes(needle)) return;
    const work = (async () => {
      try {
        const json = await read_response_json(response, 20000);
        const detail = json.aweme_detail || json.aweme_info;
        intercepted.push({
          http: typeof response.status === "function" ? response.status() : 0,
          status_code: json.status_code,
          has_more: json.has_more,
          max_cursor: json.max_cursor,
          aweme_list: Array.isArray(json.aweme_list)
            ? json.aweme_list
            : detail
              ? [detail]
              : [],
        });
      } catch (_error) {
        // ignore empty or non-json list responses
      }
    })();
    pending.push(work);
  });
  return intercepted;
}

async function wait_for_new_intercept_pages(intercepted, seen_count, timeout_ms) {
  const deadline = Date.now() + (timeout_ms || 4000);
  while (Date.now() < deadline) {
    await wait_intercept_pending(intercepted);
    if (intercepted.length > seen_count) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function should_collect_more(last, total, limit, { seeking_resume } = {}) {
  if (!last) return false;
  if (limit && total >= limit) return false;
  if (seeking_resume) return true;
  if (last.has_more) return true;
  return (last.aweme_list || []).length >= 20;
}

async function default_scroll_for_more(page) {
  if (!page) return;
  if (typeof page.evaluate === "function") {
    await page
      .evaluate(() => {
        const blocked = new Set(["douyin-navigation"]);
        const preferred = document.querySelector(
          "[class*='route-scroll-container']",
        );
        if (
          preferred &&
          preferred.scrollHeight > preferred.clientHeight + 20
        ) {
          preferred.scrollTop += Math.max(preferred.clientHeight * 2, 1200);
          return;
        }
        const like = document.querySelector("[data-e2e='user-like-list']");
        let node = like;
        while (node && node !== document.body) {
          const style = window.getComputedStyle(node);
          const key = node.getAttribute("data-e2e") || "";
          if (
            !blocked.has(key) &&
            (style.overflowY === "auto" || style.overflowY === "scroll") &&
            node.scrollHeight > node.clientHeight + 20
          ) {
            node.scrollTop += Math.max(node.clientHeight * 2, 1200);
            return;
          }
          node = node.parentElement;
        }
        window.scrollBy(0, Math.max(window.innerHeight * 2, 1200));
      })
      .catch(() => {});
  }
  if (typeof page.waitForTimeout === "function")
    await page.waitForTimeout(800);
}

async function collect_list({
  page,
  mode,
  sec_user_id,
  aweme_id,
  limit,
  intercepted_pages,
  scroll_for_more,
  should_stop,
} = {}) {
  const intercepted = Array.isArray(intercepted_pages) ? intercepted_pages : [];
  const pages = [];
  const seen_ids = new Set();
  let seen = 0;
  let cursor_in = 0;

  function unique_aweme_list(list) {
    return (list || []).filter((item) => {
      const id = String((item && item.aweme_id) || "");
      if (!id || seen_ids.has(id)) return false;
      seen_ids.add(id);
      return true;
    });
  }

  function drain_intercept() {
    const added = [];
    while (seen < intercepted.length) {
      const item = intercepted[seen];
      seen += 1;
      if (!is_ok_list_page(item) || !(item.aweme_list || []).length) continue;
      const summarized = summarize_page(item, cursor_in);
      summarized.aweme_list = unique_aweme_list(summarized.aweme_list);
      if (!summarized.aweme_list.length) continue;
      pages.push(summarized);
      cursor_in = item.max_cursor || cursor_in;
      added.push(...summarized.aweme_list);
    }
    return added;
  }

  async function reached_resume(items) {
    if (typeof should_stop !== "function" || !items || !items.length)
      return false;
    return Boolean(await should_stop(items));
  }

  await wait_for_intercept_items(intercepted, 20000);
  let first_items = drain_intercept();

  if (pages.length === 0 && typeof intercepted.wait_pending !== "function") {
    const first = await fetch_list_page(page, {
      mode,
      sec_user_id,
      aweme_id,
      cursor: 0,
    });
    if (!is_ok_list_page(first))
      throw new Error(`list blocked http=${first.http}`);
    const summarized = summarize_page(first, 0);
    summarized.aweme_list = unique_aweme_list(summarized.aweme_list);
    pages.push(summarized);
    cursor_in = first.max_cursor || 0;
    first_items = summarized.aweme_list;
  }

  if (await reached_resume(first_items)) return pages;

  const seeking_resume = typeof should_stop === "function";
  const uses_intercept =
    intercepted.length > 0 || typeof intercepted.wait_pending === "function";
  const scroll = scroll_for_more || default_scroll_for_more;
  let last = pages[pages.length - 1];
  let total = pages.reduce((sum, item) => sum + item.aweme_list.length, 0);
  let idle_scrolls = 0;
  while (should_collect_more(last, total, limit, { seeking_resume })) {
    if (typeof intercepted.wait_pending !== "function") {
      const next = await fetch_list_page(page, {
        mode,
        sec_user_id,
        aweme_id,
        cursor: last.max_cursor,
      });
      if (is_ok_list_page(next) && next.aweme_list.length) {
        const summarized = summarize_page(next, last.max_cursor);
        summarized.aweme_list = unique_aweme_list(summarized.aweme_list);
        if (summarized.aweme_list.length) {
          pages.push(summarized);
          total += summarized.aweme_list.length;
          last = pages[pages.length - 1];
          idle_scrolls = 0;
          if (await reached_resume(summarized.aweme_list)) break;
          continue;
        }
      } else if (seeking_resume && !uses_intercept) {
        break;
      }
    }
    if (mode !== "like" && mode !== "post" && mode !== "collection") break;
    const before = pages.length;
    const seen_intercept = intercepted.length;
    await scroll(page);
    await wait_for_new_intercept_pages(intercepted, seen_intercept, 4000);
    const added = drain_intercept();
    if (pages.length === before) {
      idle_scrolls += 1;
      if (idle_scrolls >= 5) break;
      continue;
    }
    idle_scrolls = 0;
    last = pages[pages.length - 1];
    total = pages.reduce((sum, item) => sum + item.aweme_list.length, 0);
    if (await reached_resume(added)) break;
  }
  return pages;
}

async function fetch_comments({ page, aweme_id, max_comment } = {}) {
  const items = [];
  const limit = Number(max_comment) || 0;
  let cursor = 0;
  while (items.length < limit) {
    const payload = await page.evaluate(
      async ({ aweme_id, cursor }) => {
        const params = new URLSearchParams({
          aweme_id: String(aweme_id || ""),
          cursor: String(cursor || 0),
          count: "20",
        });
        const response = await fetch(
          `/aweme/v1/web/comment/list/?${params.toString()}`,
          { credentials: "include" },
        );
        const json = await response.json().catch(() => ({}));
        return {
          http: response.status,
          comments: Array.isArray(json.comments) ? json.comments : [],
          cursor: json.cursor,
          has_more: json.has_more,
        };
      },
      { aweme_id, cursor },
    );
    if (payload.http !== 200) break;
    if (!payload.comments.length) break;
    items.push(...payload.comments);
    if (!payload.has_more) break;
    cursor = payload.cursor || cursor + payload.comments.length;
  }
  return items.slice(0, limit);
}

async function fetch_danmaku({ page, aweme_id, max_danmaku } = {}) {
  const items = [];
  const limit = Number(max_danmaku) || 0;
  try {
    const payload = await page.evaluate(
      async ({ aweme_id }) => {
        const params = new URLSearchParams({
          item_id: String(aweme_id || ""),
        });
        const response = await fetch(
          `/aweme/v1/web/danmaku/get/?${params.toString()}`,
          { credentials: "include" },
        );
        const json = await response.json().catch(() => ({}));
        const list = Array.isArray(json.danmaku_list)
          ? json.danmaku_list
          : Array.isArray(json.danmakus)
            ? json.danmakus
            : [];
        return { http: response.status, danmaku_list: list };
      },
      { aweme_id },
    );
    if (payload.http !== 200) return [];
    items.push(...payload.danmaku_list);
  } catch (_error) {
    return [];
  }
  return items.slice(0, limit);
}

const { DEFAULT_CHROME_USER_DATA } = require("../gather_doctor/constants");

function default_persistent_user_data_dir() {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "command_base",
    "xsave_douyin",
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
    locale: "zh-CN",
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
  if (!cookie_header) throw new Error("missing douyin cookie");
  const { chromium } = playwright || load_playwright();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({
    locale: "zh-CN",
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
  return String(process.env.COMMAND_BASE_CHROME_CDP || "").trim()
    || "http://127.0.0.1:9222";
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

async function dismiss_login_overlay(page) {
  if (page.keyboard && page.keyboard.press)
    await page.keyboard.press("Escape").catch(() => {});
  if (typeof page.evaluate === "function") {
    await page
      .evaluate(() => {
        for (const node of document.querySelectorAll("[id^='login-full-panel']"))
          node.remove();
      })
      .catch(() => {});
  }
}

async function click_like_tab(page) {
  const tab = page.locator("#semiTablike, [data-tabkey='semiTablike']");
  const tab_count = tab && tab.count ? await tab.count() : 0;
  if (tab_count > 0) {
    await tab.first().click({ force: true, timeout: 8000 }).catch(() => {});
    return;
  }
  await page
    .locator("span, div, a")
    .filter({ hasText: /^喜欢/ })
    .first()
    .click({ force: true, timeout: 8000 })
    .catch(() => {});
}

function with_like_tab(raw_url) {
  try {
    const parsed = new URL(raw_url);
    if (parsed.pathname.includes("/user/"))
      parsed.searchParams.set("showTab", "like");
    return parsed.toString();
  } catch (_error) {
    return raw_url;
  }
}

function extract_sec_user_id_from_url(raw_url) {
  try {
    const parsed = new URL(raw_url);
    const from_query = parsed.searchParams.get("sec_uid");
    if (from_query) return from_query;
    const match = String(parsed.pathname).match(
      /\/(?:share\/)?user\/([^/?#]+)/,
    );
    return match ? decodeURIComponent(match[1]) : "";
  } catch (_error) {
    return "";
  }
}

async function resolve_user_profile_url(raw_url, sec_user_id) {
  if (sec_user_id) return `https://www.douyin.com/user/${sec_user_id}`;
  const from_url = extract_sec_user_id_from_url(raw_url);
  if (from_url) return `https://www.douyin.com/user/${from_url}`;
  try {
    const response = await fetch(raw_url, { redirect: "follow" });
    const sec = extract_sec_user_id_from_url(response.url);
    if (sec) return `https://www.douyin.com/user/${sec}`;
  } catch (_error) {
    // keep the original short URL
  }
  return raw_url;
}

function is_favorite_json_response(response) {
  const url = typeof response.url === "function" ? response.url() : "";
  if (!url.includes("/aweme/v1/web/aweme/favorite/")) return false;
  if (typeof response.status === "function" && response.status() !== 200)
    return false;
  const headers =
    typeof response.headers === "function" ? response.headers() : {};
  if ((headers["content-length"] || "") === "0") return false;
  return String(headers["content-type"] || "").includes("application/json");
}

function start_like_response_wait(page) {
  if (!page || typeof page.waitForResponse !== "function") return null;
  return page.waitForResponse(is_favorite_json_response, { timeout: 20000 });
}

function is_captcha_page(title, url) {
  return /验证码|captcha|verifycenter|security_verify/i.test(
    `${title || ""} ${url || ""}`,
  );
}

async function wait_for_page_ready(page, { timeout_ms } = {}) {
  if (!page || typeof page.title !== "function") return { captcha: false };
  const deadline = Date.now() + (Number(timeout_ms) || 180000);
  let captcha = false;
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => "");
    const url = typeof page.url === "function" ? page.url() : "";
    if (!is_captcha_page(title, url)) return { captcha, title, url };
    if (!captcha)
      console.warn(
        chalk.yellow(
          "Douyin captcha: complete it in the Chrome window, then wait",
        ),
      );
    captcha = true;
    if (typeof page.waitForTimeout === "function")
      await page.waitForTimeout(1000);
    else await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("douyin captcha not solved");
}

async function prepare_list_page(page, { mode, url, sec_user_id, intercepted_pages, captcha_timeout_ms } = {}) {
  if (mode === "like") {
    const target = await resolve_user_profile_url(url, sec_user_id);
    if (!target) return;
    let like_wait = start_like_response_wait(page);
    await page.goto(with_like_tab(target), {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    const ready = await wait_for_page_ready(page, {
      timeout_ms: captcha_timeout_ms,
    });
    if (ready.captcha) like_wait = start_like_response_wait(page);
    await dismiss_login_overlay(page);
    await click_like_tab(page);
    if (like_wait) await like_wait.catch(() => {});
    else if (typeof page.waitForTimeout === "function")
      await page.waitForTimeout(4000);
    await wait_for_intercept_items(intercepted_pages, 20000);
    return;
  }

  const target = sec_user_id
    ? `https://www.douyin.com/user/${sec_user_id}`
    : url;
  if (!target) return;
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
  if (typeof page.waitForTimeout === "function") await page.waitForTimeout(2500);
}

async function probe_chrome_like({
  cookie_header,
  url,
  sec_user_id,
  chrome_profile,
  limit,
  open_session: open_session_fn,
  collect_list: collect_list_fn,
  prepare_list_page: prepare_list_page_fn,
} = {}) {
  const open = open_session_fn || open_session;
  const collect = collect_list_fn || collect_list;
  const prepare = prepare_list_page_fn || prepare_list_page;
  const header =
    cookie_header ||
    (await resolve_cookie_header({ chrome_profile }));
  const session = await open({ cookie_header: header, chrome_profile });
  try {
    const intercepted_pages = session.page
      ? attach_list_intercept(session.page, "like")
      : [];
    if (session.page && (url || sec_user_id))
      await prepare(session.page, {
        mode: "like",
        url,
        sec_user_id,
        intercepted_pages,
      });
    const pages = await collect({
      page: session.page,
      mode: "like",
      sec_user_id,
      limit: limit || 1,
      intercepted_pages,
    });
    const aweme_list = pages.flatMap((item) => item.aweme_list || []);
    const first = pages[0] || {};
    return {
      status_code: first.status_code === undefined ? 0 : first.status_code,
      aweme_list,
    };
  } finally {
    if (session && session.close) await session.close();
  }
}

module.exports = {
  attach_list_intercept,
  collect_list,
  default_persistent_user_data_dir,
  fetch_comments,
  fetch_danmaku,
  fetch_list_page,
  header_to_cookies,
  list_endpoint,
  open_session,
  prepare_list_page,
  prepare_persistent_user_data,
  probe_chrome_like,
  resolve_cookie_header,
  summarize_page,
};
