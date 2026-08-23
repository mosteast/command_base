import { describe, expect, it } from "vitest";

const {
  collect_list,
  fetch_comments,
  fetch_danmaku,
  list_endpoint,
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
});
