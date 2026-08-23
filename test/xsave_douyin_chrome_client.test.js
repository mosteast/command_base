import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const {
  attach_list_intercept,
  collect_list,
  fetch_comments,
  fetch_danmaku,
  list_endpoint,
  open_session,
  prepare_list_page,
} = require("../lib/xsave_douyin/chrome_client");

function create_fake_page(handler) {
  return {
    evaluate: async (_fn, arg) => handler(arg),
  };
}

describe("xsave_douyin chrome_client", () => {
  it("maps modes to list endpoints", () => {
    expect(list_endpoint("like")).toBe("/aweme/v1/web/aweme/favorite/");
    expect(list_endpoint("post")).toBe("/aweme/v1/web/aweme/post/");
    expect(list_endpoint("collection")).toBe("/aweme/v1/web/aweme/listcollection/");
    expect(list_endpoint("one")).toBe("/aweme/v1/web/aweme/detail/");
  });

  it("paginates collect_list from canned evaluate pages", async () => {
    const pages_by_cursor = {
      0: {
        http: 200,
        status_code: 0,
        has_more: 1,
        max_cursor: 10,
        aweme_list: [{ aweme_id: "a" }],
      },
      10: {
        http: 200,
        status_code: 0,
        has_more: 0,
        max_cursor: 20,
        aweme_list: [{ aweme_id: "b" }],
      },
    };
    const page = create_fake_page((arg) => pages_by_cursor[arg.cursor]);
    const pages = await collect_list({
      page,
      mode: "like",
      sec_user_id: "sec",
      limit: 2,
    });
    expect(pages).toHaveLength(2);
    expect(pages[0].aweme_list[0].aweme_id).toBe("a");
    expect(pages[1].aweme_list[0].aweme_id).toBe("b");
  });

  it("paginates comments until max_comment", async () => {
    const page = create_fake_page((arg) => {
      if (Number(arg.cursor) === 0) {
        return {
          http: 200,
          comments: [{ cid: "1", text: "one" }, { cid: "2", text: "two" }],
          cursor: 2,
          has_more: 1,
        };
      }
      return {
        http: 200,
        comments: [{ cid: "3", text: "three" }],
        cursor: 3,
        has_more: 0,
      };
    });
    const comments = await fetch_comments({
      page,
      aweme_id: "123",
      max_comment: 3,
    });
    expect(comments.map((item) => item.cid)).toEqual(["1", "2", "3"]);
  });

  it("returns empty danmaku when HTTP is not 200", async () => {
    const page = create_fake_page(() => ({
      http: 404,
      danmaku_list: [{ id: "1" }],
    }));
    const danmaku = await fetch_danmaku({
      page,
      aweme_id: "123",
      max_danmaku: 500,
    });
    expect(danmaku).toEqual([]);
  });

  it("waits for in-flight intercept json before falling back to fetch", async () => {
    let resolve_json;
    const json_promise = new Promise((resolve) => {
      resolve_json = resolve;
    });
    const evaluate = vi.fn(async () => ({
      http: 403,
      status_code: -1,
      has_more: 0,
      aweme_list: [],
    }));
    let handler;
    const intercepted = attach_list_intercept(
      {
        on: (event, fn) => {
          if (event === "response") handler = fn;
        },
      },
      "like",
    );
    handler({
      url: () => "https://www.douyin.com/aweme/v1/web/aweme/favorite/?x=1",
      status: () => 200,
      json: () => json_promise,
    });
    const collect_promise = collect_list({
      page: { evaluate },
      mode: "like",
      intercepted_pages: intercepted,
    });
    await Promise.resolve();
    expect(evaluate).not.toHaveBeenCalled();
    resolve_json({
      status_code: 0,
      has_more: 0,
      max_cursor: 1,
      aweme_list: [{ aweme_id: "liked-1" }],
    });
    const pages = await collect_promise;
    expect(pages[0].aweme_list[0].aweme_id).toBe("liked-1");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("keeps intercepted pages when status_code is omitted", async () => {
    const evaluate = vi.fn(async () => ({
      http: 403,
      status_code: -1,
      aweme_list: [],
    }));
    const pages = await collect_list({
      page: { evaluate },
      mode: "like",
      intercepted_pages: [
        {
          http: 200,
          has_more: 0,
          max_cursor: 1,
          aweme_list: [{ aweme_id: "liked-1" }],
        },
      ],
    });
    expect(pages[0].aweme_list[0].aweme_id).toBe("liked-1");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("uses intercepted favorite pages instead of a blocked in-page fetch", async () => {
    const evaluate = vi.fn(async () => ({
      http: 403,
      status_code: -1,
      has_more: 0,
      aweme_list: [],
    }));
    const pages = await collect_list({
      page: { evaluate },
      mode: "like",
      intercepted_pages: [
        {
          http: 200,
          status_code: 0,
          has_more: 0,
          max_cursor: 1,
          aweme_list: [{ aweme_id: "liked-1" }],
        },
      ],
    });
    expect(pages[0].aweme_list[0].aweme_id).toBe("liked-1");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("scrolls to load more intercepted like pages when fetch is blocked", async () => {
    const intercepted = [
      {
        http: 200,
        status_code: 0,
        has_more: 1,
        max_cursor: 10,
        aweme_list: [{ aweme_id: "a" }],
      },
    ];
    let scrolled = 0;
    const pages = await collect_list({
      page: {
        evaluate: async () => ({
          http: 403,
          status_code: -1,
          has_more: 0,
          aweme_list: [],
        }),
      },
      mode: "like",
      limit: 2,
      intercepted_pages: intercepted,
      scroll_for_more: async () => {
        scrolled += 1;
        intercepted.push({
          http: 200,
          status_code: 0,
          has_more: 0,
          max_cursor: 20,
          aweme_list: [{ aweme_id: "b" }],
        });
      },
    });
    expect(pages.map((page) => page.aweme_list[0].aweme_id)).toEqual(["a", "b"]);
    expect(scrolled).toBe(1);
  });

  it("records Chrome favorite responses on the page", async () => {
    let handler;
    const intercepted = attach_list_intercept(
      {
        on: (event, fn) => {
          if (event === "response") handler = fn;
        },
      },
      "like",
    );
    handler({
      url: () => "https://www.douyin.com/aweme/v1/web/aweme/favorite/?x=1",
      status: () => 200,
      json: async () => ({
        status_code: 0,
        has_more: 0,
        max_cursor: 1,
        aweme_list: [{ aweme_id: "liked-1" }],
      }),
    });
    await intercepted.wait_pending();
    expect(intercepted[0].aweme_list[0].aweme_id).toBe("liked-1");
  });

  it("opens a copied Chrome profile instead of a cookie-only context", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-profile-"));
    const source_dir = path.join(temp_root, "Profile 9");
    await fs.mkdir(source_dir, { recursive: true });
    await fs.writeFile(path.join(source_dir, "Preferences"), "{}", "utf8");
    const launched = [];
    const page = { url: () => "about:blank" };
    try {
      const session = await open_session({
        cookie_header: "sessionid=dummy",
        chrome_profile: "Profile 9",
        profile_source_dir: source_dir,
        playwright: {
          chromium: {
            launchPersistentContext: async (user_data, options) => {
              launched.push({
                user_data,
                channel: options.channel,
                headless: options.headless,
              });
              return {
                pages: () => [page],
                newPage: async () => page,
                close: async () => {},
              };
            },
            launch: async () => {
              throw new Error("should not use cookie-only launch");
            },
          },
        },
      });
      expect(launched).toHaveLength(1);
      expect(launched[0].channel).toBe("chrome");
      expect(launched[0].headless).toBe(false);
      expect(launched[0].user_data).not.toBe(source_dir);
      await session.close();
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("opens the like tab with showTab and a force click", async () => {
    const gotos = [];
    const clicks = [];
    const waits = [];
    const page = {
      url: () =>
        "https://www.douyin.com/user/MS4wLjABAAAA/example",
      goto: async (url) => {
        gotos.push(url);
      },
      waitForTimeout: async () => {},
      waitForResponse: async () => {
        waits.push(gotos.length);
      },
      keyboard: { press: async () => {} },
      evaluate: async () => {},
      locator: (selector) => {
        clicks.push(selector);
        return {
          first: () => ({
            click: async (options) => {
              clicks.push(options);
            },
            count: async () => 1,
          }),
          count: async () => 1,
          filter: () => ({
            first: () => ({
              click: async () => {},
              count: async () => 0,
            }),
          }),
        };
      },
    };
    await prepare_list_page(page, {
      mode: "like",
      url: "https://v.douyin.com/kIg44MNOKz8/",
    });
    expect(gotos.some((url) => String(url).includes("showTab=like"))).toBe(true);
    expect(clicks).toContain("#semiTablike, [data-tabkey='semiTablike']");
    expect(clicks.some((item) => item && item.force === true)).toBe(true);
    expect(waits[0]).toBeLessThan(gotos.length);
  });
});
