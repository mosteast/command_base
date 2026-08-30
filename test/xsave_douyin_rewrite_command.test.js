import { describe, expect, it } from "vitest";

const {
  rewrite_xsave_douyin_command_text,
} = require("../lib/xsave_douyin/rewrite_command");

describe("xsave_douyin rewrite_command", () => {
  it("rewrites f2 dy F2 flags to positional source and url", () => {
    expect(
      rewrite_xsave_douyin_command_text(
        "f2 dy -M like -u https://v.douyin.com/kIg44MNOKz8/",
      ),
    ).toBe("xsave_douyin like https://v.douyin.com/kIg44MNOKz8/");
    expect(
      rewrite_xsave_douyin_command_text(
        "f2_compat dy -M post -u https://www.douyin.com/user/MS4wLjABAAAA",
      ),
    ).toBe("xsave_douyin post https://www.douyin.com/user/MS4wLjABAAAA");
    expect(
      rewrite_xsave_douyin_command_text(
        "f2 dy -M collection -u https://www.douyin.com/user/MS4wLjABAAAA --dry-run",
      ),
    ).toBe(
      "xsave_douyin collection https://www.douyin.com/user/MS4wLjABAAAA --dry-run",
    );
    expect(
      rewrite_xsave_douyin_command_text(
        "f2 dy -M one -u https://v.douyin.com/AbCdEf/",
      ),
    ).toBe("xsave_douyin video https://v.douyin.com/AbCdEf/");
  });

  it("rewrites already-prefixed xsave_douyin F2 flags", () => {
    expect(
      rewrite_xsave_douyin_command_text(
        "xsave_douyin -M post -u https://www.douyin.com/user/EXAMPLE_ID",
      ),
    ).toBe("xsave_douyin post https://www.douyin.com/user/EXAMPLE_ID");
    expect(
      rewrite_xsave_douyin_command_text(
        "xsave_douyin --check-all -M like -u https://v.douyin.com/a/ --path /tmp/out",
      ),
    ).toBe(
      "xsave_douyin like https://v.douyin.com/a/ --full-scan --output /tmp/out",
    );
  });

  it("leaves non-douyin f2 commands on f2_compat", () => {
    expect(rewrite_xsave_douyin_command_text("f2 x -M like -u https://x.com/a")).toBe(
      "f2_compat x -M like -u https://x.com/a",
    );
  });
});
