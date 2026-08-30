import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  assert_logged_in_profile,
  default_persistent_user_data_dir,
  extract_profile_username,
  harvest_items_from_payload,
  normalize_media_node,
  normalize_username,
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
});
