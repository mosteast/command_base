import { describe, expect, it } from "vitest";

const { is_item_visible, classify_item } = require("../lib/xsave_douyin/classify");

describe("xsave_douyin classify", () => {
  it("marks prohibited, private, failed detail, and no-playable as invisible", () => {
    expect(is_item_visible({ aweme_id: "1", is_prohibited: true })).toBe(false);
    expect(is_item_visible({ aweme_id: "1", private_status: 3 })).toBe(false);
    expect(is_item_visible({ aweme_id: "1", detail_failed: true })).toBe(false);
    expect(is_item_visible({ aweme_id: "1" })).toBe(false);
    expect(
      is_item_visible({
        aweme_id: "1",
        video: { play_addr: { url_list: ["https://example.com/a.mp4"] } },
      }),
    ).toBe(true);
    expect(
      is_item_visible({
        aweme_id: "2",
        images: [{ url_list: ["https://example.com/a.jpeg"] }],
      }),
    ).toBe(true);
    expect(classify_item({ aweme_id: "1", is_prohibited: true }).reason).toBe(
      "invisible",
    );
  });
});
