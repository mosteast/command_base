import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  assert_logged_in_profile,
  collect_list,
  default_scroll_for_more,
  default_persistent_user_data_dir,
  extract_profile_username,
  harvest_items_from_payload,
  harvest_items_from_wbloks,
  list_page_urls,
  normalize_media_node,
  normalize_username,
  open_session,
  prepare_list_page,
  prepare_persistent_user_data,
} = require("../lib/xsave_instagram/chrome_client");

describe("xsave_instagram chrome_client", () => {
  it("normalizes usernames and profile urls", () => {
    expect(normalize_username("@Nori/")).toBe("nori");
    expect(
      extract_profile_username("https://www.instagram.com/Example_User/"),
    ).toBe("example_user");
  });

  it("harvests shortcode items from a GraphQL payload", () => {
    const items = harvest_items_from_payload({
      data: {
        user: {
          edge_owner_to_timeline_media: {
            edges: [
              {
                node: {
                  id: "99",
                  shortcode: "AbCdEfGhIjK",
                  __typename: "GraphVideo",
                  taken_at_timestamp: 1700000000,
                  video_url: "https://example.com/a.mp4",
                  display_url: "https://example.com/a.jpg",
                  edge_media_to_caption: {
                    edges: [{ node: { text: "hello" } }],
                  },
                  owner: { username: "nori", id: "1", full_name: "Nori" },
                  edge_liked_by: { count: 3 },
                  edge_media_to_comment: { count: 2 },
                },
              },
            ],
          },
        },
      },
    });
    expect(items).toHaveLength(1);
    expect(items[0].shortcode).toBe("AbCdEfGhIjK");
    expect(items[0].video_url).toBe("https://example.com/a.mp4");
    expect(normalize_media_node(null)).toBe(null);
  });

  it("harvests liked items from an activity media payload", () => {
    const items = harvest_items_from_payload({
      items: [
        {
          media: {
            code: "LikeCode1",
            pk: "1",
            image_versions2: {
              candidates: [{ url: "https://example.com/a.jpg" }],
            },
            video_versions: [{ url: "https://example.com/a.mp4" }],
            user: { username: "nori", full_name: "Nori" },
            caption: { text: "liked" },
          },
        },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].shortcode).toBe("LikeCode1");
    expect(items[0].image_urls).toEqual(["https://example.com/a.jpg"]);
    expect(items[0].video_url).toBe("https://example.com/a.mp4");
    expect(items[0].caption).toBe("liked");
  });

  it("harvests liked items from an activity wbloks payload", () => {
    const items = harvest_items_from_wbloks({
      payload: {
        layout: {
          bloks_payload: {
            data: [
              {
                type: "gs",
                data: {
                  key: "x",
                  initial_lispy:
                    '(bk.action.array.Make, "3880207368814812783_73445092680", "DXZRAsxD15v", "clips", (bk.action.i32.Const, 2), "https:\\/\\/example.com\\/a.jpg")',
                },
              },
            ],
          },
        },
      },
    });
    expect(items).toHaveLength(1);
    expect(items[0].shortcode).toBe("DXZRAsxD15v");
    expect(items[0].pk).toBe("3880207368814812783");
    expect(items[0].image_urls).toEqual(["https://example.com/a.jpg"]);
  });

  it("collects likes from api/graphql after the response arrives", async () => {
    const handlers = [];
    const page = {
      on(event, fn) {
        if (event === "response") handlers.push(fn);
      },
      goto: async () => {
        setTimeout(() => {
          const handler = handlers[0];
          if (!handler) return;
          handler({
            url: () =>
              "https://www.instagram.com/async/wbloks/fetch/?appid=com.instagram.privacy.activity_center.liked_media_screen&type=app",
            text: async () =>
              `for (;;);${JSON.stringify({
                payload: {
                  layout: {
                    bloks_payload: {
                      data: [
                        {
                          type: "gs",
                          data: {
                            key: "x",
                            initial_lispy:
                              '(bk.action.array.Make, "3880207368814812783_73445092680", "LateCode", "clips", (bk.action.i32.Const, 2), "https://example.com/a.jpg")',
                          },
                        },
                      ],
                    },
                  },
                },
              })}`,
          });
        }, 30);
      },
      keyboard: { press: async () => {} },
      url: () => "https://www.instagram.com/your_activity/interactions/likes/",
    };
    const items = await collect_list({
      page,
      source: "like",
      url: "",
      intercept_timeout_ms: 2000,
      new_item_timeout_ms: 50,
      idle_scroll_limit: 1,
    });
    expect(items.map((item) => item.shortcode)).toContain("LateCode");
  });

  it("keeps scrolling likes until intercept pages go idle", async () => {
    const handlers = [];
    const codes = ["PageOne", "PageTwo", "PageThree"];
    let emitted = 0;
    function emit_next() {
      const index = emitted;
      if (index >= codes.length) return;
      emitted += 1;
      const handler = handlers[0];
      if (!handler) return;
      const code = codes[index];
      handler({
        url: () =>
          "https://www.instagram.com/async/wbloks/fetch/?appid=com.instagram.privacy.activity_center.liked_next&type=action",
        text: async () =>
          `for (;;);${JSON.stringify({
            payload: {
              layout: {
                bloks_payload: {
                  data: [
                    {
                      type: "gs",
                      data: {
                        key: "x",
                        initial_lispy: `(bk.action.array.Make, "3880207368814812783_73445092680", "${code}", "clips", (bk.action.i32.Const, 2), "https://example.com/${code}.jpg")`,
                      },
                    },
                  ],
                },
              },
            },
          })}`,
      });
    }
    const page = {
      on(event, fn) {
        if (event === "response") handlers.push(fn);
      },
      goto: async () => {
        emit_next();
      },
      keyboard: {
        press: async () => {
          emit_next();
        },
      },
      evaluate: async () => {},
      url: () => "https://www.instagram.com/your_activity/interactions/likes/",
    };
    const items = await collect_list({
      page,
      source: "like",
      url: "",
      intercept_timeout_ms: 200,
      new_item_timeout_ms: 200,
      idle_scroll_limit: 2,
    });
    expect(items.map((item) => item.shortcode)).toEqual([
      "PageOne",
      "PageTwo",
      "PageThree",
    ]);
  });

  it("paginates likes from the feed/liked API", async () => {
    const cursors = [];
    const page = {
      on() {},
      goto: async () => {},
      url: () => "https://www.instagram.com/your_activity/interactions/likes/",
      keyboard: { press: async () => {} },
      evaluate: async (_fn, arg) => {
        if (!arg || !Object.prototype.hasOwnProperty.call(arg, "max_id"))
          return undefined;
        cursors.push(arg.max_id);
        if (arg.max_id === "c2") {
          return {
            items: [{ code: "LikeC", video_url: "https://example.com/c.mp4" }],
            more_available: false,
            next_max_id: "",
          };
        }
        if (arg.max_id === "c1") {
          return {
            items: [{ code: "LikeB", video_url: "https://example.com/b.mp4" }],
            more_available: true,
            next_max_id: "c2",
          };
        }
        return {
          items: [{ code: "LikeA", video_url: "https://example.com/a.mp4" }],
          more_available: true,
          next_max_id: "c1",
        };
      },
    };
    const items = await collect_list({
      page,
      source: "like",
      url: "",
      intercept_timeout_ms: 20,
      new_item_timeout_ms: 20,
      idle_scroll_limit: 1,
    });
    expect(items.map((item) => item.shortcode)).toEqual([
      "LikeA",
      "LikeB",
      "LikeC",
    ]);
    expect(cursors).toEqual(["", "c1", "c2"]);
  });

  it("keeps fetching liked API pages after the first intercept batch", async () => {
    const handlers = [];
    const page = {
      on(event, fn) {
        if (event === "response") handlers.push(fn);
      },
      goto: async () => {
        const handler = handlers[0];
        if (!handler) return;
        await handler({
          url: () =>
            "https://www.instagram.com/async/wbloks/fetch/?appid=com.instagram.privacy.activity_center.liked_media_screen&type=app",
          text: async () =>
            `for (;;);${JSON.stringify({
              payload: {
                layout: {
                  bloks_payload: {
                    data: [
                      {
                        type: "gs",
                        data: {
                          key: "x",
                          initial_lispy:
                            '(bk.action.array.Make, "3880207368814812783_73445092680", "LikeIntercept", "clips", (bk.action.i32.Const, 2), "https://example.com/i.jpg")',
                        },
                      },
                    ],
                  },
                },
              },
            })}`,
        });
      },
      url: () => "https://www.instagram.com/your_activity/interactions/likes/",
      keyboard: { press: async () => {} },
      evaluate: async (_fn, arg) => {
        if (!arg || !Object.prototype.hasOwnProperty.call(arg, "max_id"))
          return undefined;
        if (arg.max_id) {
          return {
            items: [
              { code: "LikeApi2", video_url: "https://example.com/2.mp4" },
            ],
            more_available: false,
            next_max_id: "",
          };
        }
        return {
          items: [{ code: "LikeApi1", video_url: "https://example.com/1.mp4" }],
          more_available: true,
          next_max_id: "next",
        };
      },
    };
    const items = await collect_list({
      page,
      source: "like",
      url: "",
      intercept_timeout_ms: 200,
      new_item_timeout_ms: 20,
      idle_scroll_limit: 1,
      should_stop: async (batch) =>
        batch.length === 1 && batch[0].shortcode === "LikeIntercept",
    });
    expect(items.map((item) => item.shortcode)).toEqual([
      "LikeIntercept",
      "LikeApi1",
      "LikeApi2",
    ]);
  });

  it("paginates likes from i.instagram.com via page.request", async () => {
    const urls = [];
    const page = {
      on() {},
      goto: async () => {},
      url: () => "https://www.instagram.com/your_activity/interactions/likes/",
      keyboard: { press: async () => {} },
      request: {
        get: async (url) => {
          urls.push(String(url));
          if (String(url).includes("max_id=3923043970305606349")) {
            return {
              status: () => 200,
              text: async () =>
                JSON.stringify({
                  items: [
                    { code: "ReqB", video_url: "https://example.com/b.mp4" },
                  ],
                  more_available: false,
                  next_max_id: "",
                }),
            };
          }
          return {
            status: () => 200,
            text: async () =>
              '{"items":[{"code":"ReqA","video_url":"https://example.com/a.mp4"}],"more_available":true,"next_max_id":3923043970305606349}',
          };
        },
      },
      evaluate: async () => undefined,
    };
    const items = await collect_list({
      page,
      source: "like",
      url: "",
      intercept_timeout_ms: 20,
      new_item_timeout_ms: 20,
      idle_scroll_limit: 1,
    });
    expect(items.map((item) => item.shortcode)).toEqual(["ReqA", "ReqB"]);
    expect(urls[0]).toMatch(/i\.instagram\.com\/api\/v1\/feed\/liked/);
  });

  it("does not scroll the likes page between feed/liked API pages", async () => {
    let scrolls = 0;
    const page = {
      on() {},
      goto: async () => {},
      url: () => "https://www.instagram.com/your_activity/interactions/likes/",
      keyboard: { press: async () => {} },
      evaluate: async (_fn, arg) => {
        if (!arg || !Object.prototype.hasOwnProperty.call(arg, "max_id"))
          return undefined;
        if (arg.max_id) {
          return {
            items: [{ code: "ApiB", video_url: "https://example.com/b.mp4" }],
            more_available: false,
            next_max_id: "",
          };
        }
        return {
          items: [{ code: "ApiA", video_url: "https://example.com/a.mp4" }],
          more_available: true,
          next_max_id: "c1",
        };
      },
    };
    await collect_list({
      page,
      source: "like",
      url: "",
      intercept_timeout_ms: 20,
      new_item_timeout_ms: 20,
      idle_scroll_limit: 1,
      scroll_for_more: async () => {
        scrolls += 1;
      },
    });
    expect(scrolls).toBe(0);
  });

  it("bounces the list up before scrolling to the bottom", async () => {
    const seen = [];
    await default_scroll_for_more(
      {
        evaluate: async (_fn, arg) => {
          seen.push(arg);
        },
        waitForTimeout: async () => {},
      },
      { bounce: true },
    );
    expect(seen[0]).toMatchObject({ bounce: true });
  });

  it("bounces the list after an idle likes scroll", async () => {
    const bounces = [];
    const handlers = [];
    const page = {
      on(event, fn) {
        if (event === "response") handlers.push(fn);
      },
      goto: async () => {
        const handler = handlers[0];
        if (!handler) return;
        await handler({
          url: () =>
            "https://www.instagram.com/async/wbloks/fetch/?appid=com.instagram.privacy.activity_center.liked_media_screen&type=app",
          text: async () =>
            `for (;;);${JSON.stringify({
              payload: {
                layout: {
                  bloks_payload: {
                    data: [
                      {
                        type: "gs",
                        data: {
                          key: "x",
                          initial_lispy:
                            '(bk.action.array.Make, "3880207368814812783_73445092680", "IdleOne", "clips", (bk.action.i32.Const, 2), "https://example.com/a.jpg")',
                        },
                      },
                    ],
                  },
                },
              },
            })}`,
        });
      },
      url: () => "https://www.instagram.com/your_activity/interactions/likes/",
      keyboard: { press: async () => {} },
      evaluate: async () => undefined,
    };
    await collect_list({
      page,
      source: "like",
      url: "",
      intercept_timeout_ms: 20,
      new_item_timeout_ms: 20,
      idle_scroll_limit: 2,
      scroll_for_more: async (_page, opts) => {
        bounces.push(Boolean(opts && opts.bounce));
      },
    });
    expect(bounces).toContain(true);
  });

  it("does not stop liked API pagination at the first downloaded item", async () => {
    const page = {
      on() {},
      goto: async () => {},
      url: () => "https://www.instagram.com/your_activity/interactions/likes/",
      keyboard: { press: async () => {} },
      evaluate: async (_fn, arg) => {
        if (!arg || !Object.prototype.hasOwnProperty.call(arg, "max_id"))
          return undefined;
        if (arg.max_id === "c1") {
          return {
            items: [{ code: "KeepB", video_url: "https://example.com/b.mp4" }],
            more_available: false,
            next_max_id: "",
          };
        }
        return {
          items: [{ code: "KeepA", video_url: "https://example.com/a.mp4" }],
          more_available: true,
          next_max_id: "c1",
        };
      },
    };
    const items = await collect_list({
      page,
      source: "like",
      url: "",
      intercept_timeout_ms: 20,
      new_item_timeout_ms: 20,
      idle_scroll_limit: 1,
      should_stop: async () => true,
    });
    expect(items.map((item) => item.shortcode)).toEqual(["KeepA", "KeepB"]);
  });

  it("asserts like/collection against the session username", async () => {
    await expect(
      assert_logged_in_profile({
        page: {
          evaluate: async () => "nori",
        },
        url: "https://www.instagram.com/other_user/",
        source: "like",
      }),
    ).rejects.toThrow(/source like requires the logged-in profile URL/);
    await assert_logged_in_profile({
      page: { evaluate: async () => "Nori" },
      url: "https://www.instagram.com/nori/",
      source: "collection",
    });
  });

  it("opens likes on your_activity/interactions/likes", () => {
    expect(list_page_urls("like", "")).toEqual([
      "https://www.instagram.com/your_activity/interactions/likes/",
    ]);
    expect(
      list_page_urls("like", "https://www.instagram.com/example_user/"),
    ).toEqual(["https://www.instagram.com/your_activity/interactions/likes/"]);
  });

  it("builds collection saved url from the session username", () => {
    expect(list_page_urls("collection", "", "Nori")).toEqual([
      "https://www.instagram.com/nori/saved/all-posts/",
    ]);
  });

  it("fails collection --signer when the session username is empty", async () => {
    await expect(
      prepare_list_page(
        { evaluate: async () => "", goto: async () => {} },
        { source: "collection", url: "" },
      ),
    ).rejects.toThrow(
      /source collection requires a logged-in Instagram session/,
    );
  });

  it("waits for the Instagram login page to clear before returning", async () => {
    const urls = [
      "https://www.instagram.com/accounts/login/",
      "https://www.instagram.com/accounts/login/",
      "https://www.instagram.com/your_activity/interactions/likes/",
    ];
    const page = {
      goto: async () => {},
      title: async () => "Login • Instagram",
      url: () =>
        urls.shift() ||
        "https://www.instagram.com/your_activity/interactions/likes/",
      waitForTimeout: async () => {},
    };
    await prepare_list_page(page, {
      source: "like",
      url: "",
      login_timeout_ms: 5000,
    });
    expect(urls).toHaveLength(0);
  });

  it("fails when Instagram login is not completed", async () => {
    await expect(
      prepare_list_page(
        {
          goto: async () => {},
          title: async () => "Login • Instagram",
          url: () => "https://www.instagram.com/accounts/login/",
          waitForTimeout: async () => {},
        },
        { source: "like", url: "", login_timeout_ms: 50 },
      ),
    ).rejects.toThrow(/instagram login not completed/);
  });

  it("uses a dedicated persistent user-data dir", () => {
    const dir = default_persistent_user_data_dir();
    expect(dir).toBe(
      path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "command_base",
        "xsave_instagram",
        "chrome",
      ),
    );
  });

  it("does not attach over CDP when chrome_profile is set", async () => {
    const temp_root = fs.mkdtempSync(
      path.join(os.tmpdir(), "xsave-ig-profile-"),
    );
    const source_dir = path.join(temp_root, "Default");
    const user_data = path.join(temp_root, "chrome");
    fs.mkdirSync(source_dir, { recursive: true });
    fs.writeFileSync(path.join(source_dir, "Preferences"), "{}", "utf8");
    const page = { setDefaultTimeout() {} };
    let used_cdp = false;
    try {
      const session = await open_session({
        chrome_profile: "Default",
        profile_source_dir: source_dir,
        persistent_user_data_dir: user_data,
        playwright: {
          chromium: {
            connectOverCDP: async () => {
              used_cdp = true;
              return {
                contexts: () => [
                  {
                    pages: () => [page],
                    newPage: async () => page,
                  },
                ],
                close: async () => {},
              };
            },
            launchPersistentContext: async () => ({
              pages: () => [page],
              close: async () => {},
            }),
          },
        },
      });
      expect(used_cdp).toBe(false);
      expect(session.page).toBe(page);
    } finally {
      fs.rmSync(temp_root, { recursive: true, force: true });
    }
  });

  it("uses exported cookies instead of copying the Chrome profile", async () => {
    let launched_persist = false;
    let launch_options = null;
    let added = [];
    const page = {};
    const session = await open_session({
      chrome_profile: "Default",
      cookie_header: "sessionid=abc; csrftoken=def",
      playwright: {
        chromium: {
          connectOverCDP: async () => {
            throw new Error("should not use CDP when cookies exist");
          },
          launchPersistentContext: async () => {
            launched_persist = true;
            throw new Error("should not copy the Chrome profile");
          },
          launch: async (options) => {
            launch_options = options;
            return {
              newContext: async () => ({
                addCookies: async (cookies) => {
                  added = cookies;
                },
                newPage: async () => page,
              }),
              close: async () => {},
            };
          },
        },
      },
    });
    expect(launched_persist).toBe(false);
    expect(launch_options && launch_options.headless).toBe(false);
    expect(added.map((item) => item.name)).toEqual(["sessionid", "csrftoken"]);
    expect(session.page).toBe(page);
  });

  it("labels the persistent profile with the source Chrome profile name", () => {
    const temp_root = fs.mkdtempSync(path.join(os.tmpdir(), "xsave-ig-name-"));
    const source_dir = path.join(temp_root, "Default");
    const user_data = path.join(temp_root, "chrome");
    fs.mkdirSync(source_dir, { recursive: true });
    fs.writeFileSync(path.join(source_dir, "Preferences"), "{}", "utf8");
    try {
      prepare_persistent_user_data({
        source_dir,
        persistent_user_data_dir: user_data,
        profile_name: "Zheng",
      });
      const local_state = JSON.parse(
        fs.readFileSync(path.join(user_data, "Local State"), "utf8"),
      );
      expect(local_state.profile.info_cache.Default.name).toBe("Zheng");
    } finally {
      fs.rmSync(temp_root, { recursive: true, force: true });
    }
  });
});
