import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const {
  attach_list_intercept,
  collect_list,
  default_persistent_user_data_dir,
  fetch_comments,
  fetch_danmaku,
  list_endpoint,
  open_session,
  prepare_list_page,
  prepare_persistent_user_data,
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

  it("waits after scroll for a delayed intercepted like page", async () => {
    const intercepted = Object.assign(
      [
        {
          http: 200,
          status_code: 0,
          has_more: 1,
          max_cursor: 10,
          aweme_list: [{ aweme_id: "a" }],
        },
      ],
      { wait_pending: async () => {} },
    );
    const evaluate = vi.fn(async () => {
      throw new Error("should not fetch like pages in Chrome intercept mode");
    });
    let scrolled = 0;
    const pages = await collect_list({
      page: { evaluate },
      mode: "like",
      intercepted_pages: intercepted,
      scroll_for_more: async () => {
        scrolled += 1;
        setTimeout(() => {
          intercepted.push({
            http: 200,
            status_code: 0,
            has_more: 0,
            max_cursor: 20,
            aweme_list: [{ aweme_id: "b" }],
          });
        }, 40);
      },
    });
    expect(pages.map((page) => page.aweme_list[0].aweme_id)).toEqual(["a", "b"]);
    expect(scrolled).toBe(1);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("keeps scrolling a full like page when has_more is omitted", async () => {
    const intercepted = Object.assign(
      [
        {
          http: 200,
          status_code: 0,
          max_cursor: 10,
          aweme_list: Array.from({ length: 20 }, (_, index) => ({
            aweme_id: `a${index}`,
          })),
        },
      ],
      { wait_pending: async () => {} },
    );
    let scrolled = 0;
    const pages = await collect_list({
      page: { evaluate: async () => ({ http: 403, aweme_list: [] }) },
      mode: "like",
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
    expect(pages.flatMap((page) => page.aweme_list).at(-1).aweme_id).toBe("b");
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

  it("seeds Default in a durable user-data dir and keeps it after close", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-profile-"));
    const source_dir = path.join(temp_root, "Profile 9");
    const user_data = path.join(temp_root, "chrome");
    await fs.mkdir(source_dir, { recursive: true });
    await fs.writeFile(path.join(source_dir, "Preferences"), "{}", "utf8");
    const launched = [];
    const page = { url: () => "about:blank" };
    try {
      const session = await open_session({
        cookie_header: "sessionid=dummy",
        chrome_profile: "Profile 9",
        profile_source_dir: source_dir,
        persistent_user_data_dir: user_data,
        playwright: {
          chromium: {
            launchPersistentContext: async (launched_user_data, options) => {
              launched.push({
                user_data: launched_user_data,
                channel: options.channel,
                headless: options.headless,
                chromiumSandbox: options.chromiumSandbox,
                args: options.args,
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
      expect(launched[0].user_data).toBe(user_data);
      expect(launched[0].chromiumSandbox).toBe(true);
      expect(launched[0].args || []).not.toContain("--no-sandbox");
      expect(launched[0].args || []).not.toContain(
        "--disable-blink-features=AutomationControlled",
      );
      expect(
        await fs.readFile(path.join(user_data, "Default", "Preferences"), "utf8"),
      ).toBe("{}");
      await session.close();
      expect(
        await fs.readFile(path.join(user_data, "Default", "Preferences"), "utf8"),
      ).toBe("{}");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("does not create persistent user-data when the source profile is missing", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-profile-"));
    const user_data = path.join(temp_root, "chrome");
    try {
      await expect(
        open_session({
          chrome_profile: "Profile 9",
          profile_source_dir: path.join(temp_root, "missing"),
          persistent_user_data_dir: user_data,
          playwright: {
            chromium: {
              launchPersistentContext: async () => {
                throw new Error("should not launch");
              },
            },
          },
        }),
      ).rejects.toThrow("chrome profile directory missing");
      await expect(fs.stat(user_data)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("keeps the persistent user-data dir when Chrome fails to launch", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-profile-"));
    const source_dir = path.join(temp_root, "Profile 9");
    const user_data = path.join(temp_root, "chrome");
    await fs.mkdir(source_dir, { recursive: true });
    await fs.writeFile(path.join(source_dir, "Preferences"), "{}", "utf8");
    try {
      await expect(
        open_session({
          chrome_profile: "Profile 9",
          profile_source_dir: source_dir,
          persistent_user_data_dir: user_data,
          playwright: {
            chromium: {
              launchPersistentContext: async () => {
                throw new Error("chrome explode");
              },
            },
          },
        }),
      ).rejects.toThrow("chrome explode");
      expect(
        await fs.readFile(path.join(user_data, "Default", "Preferences"), "utf8"),
      ).toBe("{}");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("opens the like tab with showTab and a force click", async () => {
    const gotos = [];
    const clicks = [];
    const waits = [];
    const page = {
      title: async () => "甘的抖音 - 抖音",
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

  it("waits for a captcha page to clear before clicking like", async () => {
    const titles = ["验证码中间页", "验证码中间页", "甘的抖音 - 抖音"];
    const clicks = [];
    const page = {
      title: async () => titles.shift() || "甘的抖音 - 抖音",
      url: () => "https://www.douyin.com/user/MS4wLjABAAAA/example",
      goto: async () => {},
      waitForTimeout: async () => {},
      waitForResponse: async () => {},
      keyboard: { press: async () => {} },
      evaluate: async () => {},
      locator: () => ({
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
      }),
    };
    await prepare_list_page(page, {
      mode: "like",
      url: "https://www.douyin.com/user/MS4wLjABAAAA/example",
      captcha_timeout_ms: 5000,
    });
    expect(titles).toHaveLength(0);
    expect(clicks.some((item) => item && item.force === true)).toBe(true);
  });

  it("attaches to an existing Chrome debug port when available", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-cdp-"));
    const source_dir = path.join(temp_root, "Profile 9");
    const user_data = path.join(temp_root, "chrome");
    await fs.mkdir(source_dir, { recursive: true });
    await fs.writeFile(path.join(source_dir, "Preferences"), "{}", "utf8");
    const page = { url: () => "about:blank" };
    let used_cdp = false;
    try {
      const session = await open_session({
        chrome_profile: "Profile 9",
        profile_source_dir: source_dir,
        persistent_user_data_dir: user_data,
        playwright: {
          chromium: {
            connectOverCDP: async () => {
              used_cdp = true;
              return {
                contexts: () => [
                  {
                    pages: () => [],
                    newPage: async () => page,
                  },
                ],
                close: async () => {},
              };
            },
            launchPersistentContext: async () => {
              throw new Error("should not copy the profile when CDP works");
            },
          },
        },
      });
      expect(used_cdp).toBe(true);
      expect(session.page).toBe(page);
      await expect(
        fs.stat(path.join(user_data, "Default")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await session.close();
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});

describe("xsave_douyin persistent user-data", () => {
  it("resolves the Application Support chrome dir from homedir", () => {
    expect(default_persistent_user_data_dir()).toBe(
      path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "command_base",
        "xsave_douyin",
        "chrome",
      ),
    );
  });

  it("seeds a Chrome profile into Default and skips cache and locks", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-persist-"));
    const source_dir = path.join(temp_root, "Profile 9");
    const user_data = path.join(temp_root, "chrome");
    try {
      await fs.mkdir(path.join(source_dir, "Cache"), { recursive: true });
      await fs.writeFile(path.join(source_dir, "Preferences"), "{}", "utf8");
      await fs.writeFile(path.join(source_dir, "Cache", "blob"), "c", "utf8");
      await fs.writeFile(path.join(source_dir, "SingletonLock"), "lock", "utf8");
      const result = prepare_persistent_user_data({
        source_dir,
        persistent_user_data_dir: user_data,
      });
      expect(result).toBe(user_data);
      expect(
        await fs.readFile(path.join(user_data, "Default", "Preferences"), "utf8"),
      ).toBe("{}");
      await expect(fs.stat(path.join(user_data, "Preferences"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        fs.stat(path.join(user_data, "Default", "Cache")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.stat(path.join(user_data, "Default", "SingletonLock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing Default profile", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-persist-"));
    const source_dir = path.join(temp_root, "Profile 9");
    const user_data = path.join(temp_root, "chrome");
    try {
      await fs.mkdir(source_dir, { recursive: true });
      await fs.writeFile(path.join(source_dir, "Preferences"), "new", "utf8");
      await fs.mkdir(path.join(user_data, "Default"), { recursive: true });
      await fs.writeFile(path.join(user_data, "Default", "sentinel"), "keep", "utf8");
      await fs.writeFile(path.join(user_data, "Default", "Preferences"), "old", "utf8");
      prepare_persistent_user_data({
        source_dir,
        persistent_user_data_dir: user_data,
      });
      expect(
        await fs.readFile(path.join(user_data, "Default", "sentinel"), "utf8"),
      ).toBe("keep");
      expect(
        await fs.readFile(path.join(user_data, "Default", "Preferences"), "utf8"),
      ).toBe("old");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("removes leftover Singleton locks at the user-data root", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "xsave-persist-"));
    const source_dir = path.join(temp_root, "Profile 9");
    const user_data = path.join(temp_root, "chrome");
    try {
      await fs.mkdir(source_dir, { recursive: true });
      await fs.writeFile(path.join(source_dir, "Preferences"), "{}", "utf8");
      await fs.mkdir(path.join(user_data, "Default"), { recursive: true });
      await fs.writeFile(path.join(user_data, "SingletonLock"), "old", "utf8");
      await fs.writeFile(path.join(user_data, "SingletonCookie"), "old", "utf8");
      await fs.writeFile(path.join(user_data, "SingletonSocket"), "old", "utf8");
      prepare_persistent_user_data({
        source_dir,
        persistent_user_data_dir: user_data,
      });
      await expect(
        fs.stat(path.join(user_data, "SingletonLock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.stat(path.join(user_data, "SingletonCookie")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.stat(path.join(user_data, "SingletonSocket")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
