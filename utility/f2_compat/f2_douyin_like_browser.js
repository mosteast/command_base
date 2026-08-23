"use strict";

const chrome_client = require("../../lib/xsave_douyin/chrome_client");

function header_to_cookies(header) {
  return chrome_client.header_to_cookies(header);
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
  return chrome_client.resolve_cookie_header(options);
}

async function fetch_in_page(page, sec_user_id, max_cursor) {
  return chrome_client.fetch_list_page(page, {
    mode: "like",
    sec_user_id,
    cursor: max_cursor,
  });
}

async function collect_like_pages(options) {
  const cookie_header = await resolve_cookie_header(options);
  const session = await chrome_client.open_session({ cookie_header });
  const page = session.page;
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
    await chrome_client.prepare_list_page(page, {
      mode: "like",
      url: options.url,
      sec_user_id: options.sec_user_id,
    });
    const pages = await chrome_client.collect_list({
      page,
      mode: "like",
      sec_user_id: options.sec_user_id,
      limit: options.limit,
      intercepted_pages: intercepted,
    });
    return { ok: true, pages };
  } finally {
    await session.close();
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
  resolve_cookie_header,
  summarize_page,
  collect_like_pages,
};

if (require.main === module) {
  main().catch((error) => {
    emit({ ok: false, error: error.message || String(error) });
    process.exit(1);
  });
}
