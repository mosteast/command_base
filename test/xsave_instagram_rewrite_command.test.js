import { describe, expect, it } from "vitest";

const {
  rewrite_xsave_instagram_command_text,
} = require("../lib/xsave_instagram/rewrite_command");

describe("xsave_instagram rewrite_command", () => {
  it("keeps already-valid source plus url", () => {
    expect(
      rewrite_xsave_instagram_command_text(
        "xsave_instagram post https://www.instagram.com/example_user/ --dry-run",
      ),
    ).toBe(
      "xsave_instagram post https://www.instagram.com/example_user/ --dry-run",
    );
  });

  it("does not rewrite instagram_likes_export", () => {
    expect(
      rewrite_xsave_instagram_command_text(
        "instagram_likes_export my_account --content-type liked",
      ),
    ).toBe("instagram_likes_export my_account --content-type liked");
  });

  it("keeps like --signer without inventing a url", () => {
    expect(
      rewrite_xsave_instagram_command_text("xsave_instagram like --signer"),
    ).toBe("xsave_instagram like --signer");
    expect(
      rewrite_xsave_instagram_command_text(
        "xsave_instagram collection --signer --dry-run",
      ),
    ).toBe("xsave_instagram collection --signer --dry-run");
  });

  it("leaves douyin commands unchanged", () => {
    expect(
      rewrite_xsave_instagram_command_text(
        "xsave_douyin post https://www.douyin.com/user/EXAMPLE_ID",
      ),
    ).toBe("xsave_douyin post https://www.douyin.com/user/EXAMPLE_ID");
  });
});
