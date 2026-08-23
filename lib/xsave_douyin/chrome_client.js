"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const repo_root = path.resolve(__dirname, "..", "..");

function load_playwright() {
  return require(path.join(repo_root, "node_modules", "playwright"));
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
  return page.evaluate(
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
}

function attach_list_intercept(page, mode) {
  const intercepted = [];
  if (!page || typeof page.on !== "function") return intercepted;
  const needle = list_endpoint(mode);
  page.on("response", async (response) => {
    const url = typeof response.url === "function" ? response.url() : "";
    if (!url.includes(needle)) return;
    try {
      const json = await response.json();
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
      // ignore non-json list responses
    }
  });
  return intercepted;
}

async function default_scroll_for_more(page) {
  if (!page) return;
  if (typeof page.evaluate === "function") {
    await page
      .evaluate(() => {
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
} = {}) {
  const intercepted = Array.isArray(intercepted_pages) ? intercepted_pages : [];
  const pages = [];
  let seen = 0;
  let cursor_in = 0;

  function drain_intercept() {
    let added = 0;
    while (seen < intercepted.length) {
      const item = intercepted[seen];
      seen += 1;
      if (item.http !== 200 || item.status_code !== 0) continue;
      pages.push(summarize_page(item, cursor_in));
      cursor_in = item.max_cursor || cursor_in;
      added += 1;
    }
    return added;
  }

  drain_intercept();

  if (pages.length === 0) {
    const first = await fetch_list_page(page, {
      mode,
      sec_user_id,
      aweme_id,
      cursor: 0,
    });
    if (first.http !== 200 || first.status_code !== 0)
      throw new Error(`list blocked http=${first.http}`);
    pages.push(summarize_page(first, 0));
    cursor_in = first.max_cursor || 0;
  }

  const scroll = scroll_for_more || default_scroll_for_more;
  let last = pages[pages.length - 1];
  let total = pages.reduce((sum, item) => sum + item.aweme_list.length, 0);
  let idle_scrolls = 0;
  while (last.has_more && (!limit || total < limit)) {
    const next = await fetch_list_page(page, {
      mode,
      sec_user_id,
      aweme_id,
      cursor: last.max_cursor,
    });
    if (next.http === 200 && next.status_code === 0 && next.aweme_list.length) {
      pages.push(summarize_page(next, last.max_cursor));
      total += next.aweme_list.length;
      last = pages[pages.length - 1];
      idle_scrolls = 0;
      continue;
    }
    if (mode !== "like" && mode !== "post" && mode !== "collection") break;
    const before = pages.length;
    await scroll(page);
    drain_intercept();
    if (pages.length === before) {
      idle_scrolls += 1;
      if (idle_scrolls >= 3) break;
      continue;
    }
    idle_scrolls = 0;
    last = pages[pages.length - 1];
    total = pages.reduce((sum, item) => sum + item.aweme_list.length, 0);
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

async function open_session({ cookie_header, playwright } = {}) {
  if (!cookie_header) throw new Error("missing douyin cookie");
  const { chromium } = playwright || load_playwright();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({ locale: "zh-CN" });
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

async function prepare_list_page(page, { mode, url, sec_user_id } = {}) {
  const user_url = sec_user_id
    ? `https://www.douyin.com/user/${sec_user_id}`
    : url;
  if (!user_url) return;
  await page.goto(user_url, { waitUntil: "domcontentloaded", timeout: 45000 });
  if (typeof page.waitForTimeout === "function") await page.waitForTimeout(2500);
  if (mode === "like") {
    await page
      .locator("span, div, a")
      .filter({ hasText: /^喜欢$/ })
      .first()
      .click({ timeout: 8000 })
      .catch(() => {});
    if (typeof page.waitForResponse === "function") {
      await page
        .waitForResponse(
          (response) =>
            response.url().includes("/aweme/v1/web/aweme/favorite/") &&
            response.status() === 200,
          { timeout: 15000 },
        )
        .catch(() => {});
    } else if (typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(4000);
    }
  }
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
  const session = await open({ cookie_header: header });
  try {
    const intercepted_pages = session.page
      ? attach_list_intercept(session.page, "like")
      : [];
    if (session.page && (url || sec_user_id))
      await prepare(session.page, { mode: "like", url, sec_user_id });
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
  fetch_comments,
  fetch_danmaku,
  fetch_list_page,
  header_to_cookies,
  list_endpoint,
  open_session,
  prepare_list_page,
  probe_chrome_like,
  resolve_cookie_header,
  summarize_page,
};
