"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const repo_root = path.resolve(__dirname, "..", "..");

function load_playwright() {
  return require(path.join(repo_root, "node_modules", "playwright"));
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

function parse_args(argv) {
  const options = {
    url: "",
    sec_user_id: "",
    cookie_file: "",
    chrome_profile: "",
    max_cursor: 0,
    limit: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--url") options.url = value;
    else if (key === "--sec-user-id") options.sec_user_id = value;
    else if (key === "--cookie-file") options.cookie_file = value;
    else if (key === "--chrome-profile") options.chrome_profile = value;
    else if (key === "--max-cursor") options.max_cursor = Number(value) || 0;
    else if (key === "--limit") options.limit = Number(value) || 0;
    else continue;
    index += 1;
  }
  return options;
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function summarize_page(page, max_cursor_in) {
  const list = Array.isArray(page.aweme_list) ? page.aweme_list : [];
  return {
    max_cursor_in,
    max_cursor: page.max_cursor || 0,
    has_more: page.has_more ? 1 : 0,
    aweme_list: list,
  };
}

async function resolve_cookie_header(options) {
  if (options.cookie_file) {
    const raw = fs.readFileSync(options.cookie_file, "utf8").trim();
    if (raw) return raw;
  }
  if (!options.chrome_profile) return "";
  const cookie_export = require(path.join(
    repo_root,
    "lib",
    "gather_doctor",
    "cookie_export",
  ));
  const { list_chrome_profiles } = require(path.join(
    repo_root,
    "lib",
    "gather_doctor",
    "chrome_profile",
  ));
  const listed = await list_chrome_profiles("", {
    chrome_profile: options.chrome_profile,
  });
  const profile = listed.profiles && listed.profiles[0];
  const directory = profile ? profile.directory : options.chrome_profile;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "f2-like-ck-"));
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

async function fetch_in_page(page, sec_user_id, max_cursor) {
  return page.evaluate(
    async ({ sec, cursor }) => {
      const params = new URLSearchParams({
        device_platform: "webapp",
        aid: "6383",
        channel: "channel_pc_web",
        sec_user_id: sec,
        max_cursor: String(cursor),
        count: "20",
      });
      const response = await fetch(
        `/aweme/v1/web/aweme/favorite/?${params.toString()}`,
        { credentials: "include" },
      );
      const json = await response.json().catch(() => ({}));
      return {
        http: response.status,
        status_code: json.status_code,
        has_more: json.has_more,
        max_cursor: json.max_cursor,
        aweme_list: Array.isArray(json.aweme_list) ? json.aweme_list : [],
      };
    },
    { sec: sec_user_id, cursor: max_cursor },
  );
}

async function collect_like_pages(options) {
  const cookie_header = await resolve_cookie_header(options);
  if (!cookie_header) throw new Error("missing douyin cookie");
  const { chromium } = load_playwright();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({ locale: "zh-CN" });
  await context.addCookies(header_to_cookies(cookie_header));
  const page = await context.newPage();
  const intercepted = [];
  page.on("response", async (response) => {
    if (!response.url().includes("/aweme/v1/web/aweme/favorite/")) return;
    try {
      const json = await response.json();
      intercepted.push({
        http: response.status(),
        status_code: json.status_code,
        has_more: json.has_more,
        max_cursor: json.max_cursor,
        aweme_list: Array.isArray(json.aweme_list) ? json.aweme_list : [],
      });
    } catch (_error) {
      // ignore non-json favorite responses
    }
  });

  try {
    const user_url = options.sec_user_id
      ? `https://www.douyin.com/user/${options.sec_user_id}`
      : options.url;
    await page.goto(user_url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    await page
      .locator("span, div, a")
      .filter({ hasText: /^喜欢$/ })
      .first()
      .click({ timeout: 8000 })
      .catch(() => {});
    await page.waitForTimeout(4000);

    const pages = [];
    let cursor_in = 0;
    for (const item of intercepted) {
      if (item.http !== 200 || item.status_code !== 0) continue;
      pages.push(summarize_page(item, cursor_in));
      cursor_in = item.max_cursor || cursor_in;
    }

    if (pages.length === 0) {
      const first = await fetch_in_page(page, options.sec_user_id, 0);
      if (first.http !== 200 || first.status_code !== 0)
        throw new Error(`favorite still blocked http=${first.http}`);
      pages.push(summarize_page(first, 0));
    }

    let last = pages[pages.length - 1];
    let total = pages.reduce((sum, item) => sum + item.aweme_list.length, 0);
    while (last.has_more && (!options.limit || total < options.limit)) {
      const next = await fetch_in_page(page, options.sec_user_id, last.max_cursor);
      if (next.http !== 200 || next.status_code !== 0) break;
      if (!next.aweme_list.length) break;
      pages.push(summarize_page(next, last.max_cursor));
      total += next.aweme_list.length;
      last = pages[pages.length - 1];
      await page.waitForTimeout(150);
    }
    return { ok: true, pages };
  } finally {
    await browser.close();
  }
}

async function main() {
  const options = parse_args(process.argv.slice(2));
  if (!options.sec_user_id && !options.url) {
    emit({ ok: false, error: "missing url or sec_user_id" });
    process.exit(1);
  }
  const payload = await collect_like_pages(options);
  emit(payload);
}

module.exports = {
  header_to_cookies,
  parse_args,
  summarize_page,
  collect_like_pages,
};

if (require.main === module) {
  main().catch((error) => {
    emit({ ok: false, error: error.message || String(error) });
    process.exit(1);
  });
}
