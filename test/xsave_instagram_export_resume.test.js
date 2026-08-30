import { describe, expect, it } from "vitest";

const { run_export } = require("../lib/xsave_instagram/run_export");

describe("xsave_instagram export resume", () => {
  it("passes source video to collect_list and skips resume stop", async () => {
    const seen = [];
    await run_export(
      {
        source: "video",
        url: "https://www.instagram.com/p/AbCdEfGhIjK/",
        output: "/tmp",
        dry_run: true,
        chrome_profile: "nori",
      },
      {
        resolve_cookie: async () => "dummy",
        collect_list: async (opts) => {
          seen.push(opts.source);
          expect(opts.should_stop).toBeUndefined();
          return [];
        },
        assert_logged_in_profile: async () => {},
        log: () => {},
      },
    );
    expect(seen).toEqual(["video"]);
  });

  it("fails like when the session user does not match the url", async () => {
    const result = await run_export(
      {
        source: "like",
        url: "https://www.instagram.com/other_user/",
        output: "/tmp",
        dry_run: true,
        chrome_profile: "nori",
      },
      {
        resolve_cookie: async () => "dummy",
        open_session: async () => ({ page: {}, close: async () => {} }),
        assert_logged_in_profile: async () => {
          throw new Error("source like requires the logged-in profile URL");
        },
        collect_list: async () => {
          throw new Error("should not collect");
        },
        log: () => {},
        error: () => {},
      },
    );
    expect(result.exit_code).toBe(1);
  });
});
