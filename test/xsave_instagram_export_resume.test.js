import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { run_export } = require("../lib/xsave_instagram/run_export");

describe("xsave_instagram export resume", () => {
  it("removes empty files before comparing local media", async () => {
    const temp_root = await fs.mkdtemp(
      path.join(os.tmpdir(), "xsave-ig-empty-before-"),
    );
    const empty_path = path.join(
      temp_root,
      `"user","old-empty","Name","2026-01-01","cap"_video.mp4`,
    );
    const keep_path = path.join(
      temp_root,
      `"user","old-1","Name","2026-01-01","cap"_video.mp4`,
    );
    let collect_saw_empty = true;
    let stdout = "";
    try {
      await fs.writeFile(empty_path, "");
      await fs.writeFile(keep_path, "video");
      const result = await run_export(
        {
          source: "like",
          url: "https://www.instagram.com/example_user/",
          output: temp_root,
          dry_run: false,
          max_comment: 0,
          chrome_profile: "nori",
        },
        {
          page: {},
          resolve_cookie: async () => "dummy",
          prepare_list_page: async () => {},
          assert_logged_in_profile: async () => {},
          collect_list: async () => {
            collect_saw_empty = await fs
              .stat(empty_path)
              .then(() => true)
              .catch((error) =>
                error && error.code === "ENOENT" ? false : true,
              );
            return [{ shortcode: "new-1", video_url: "https://example.com/a.mp4" }];
          },
          download_media: async () => ({ ok: true, reason: "" }),
          fetch_comments: async () => [],
          log: (text) => {
            stdout += `${text}\n`;
          },
        },
      );
      expect(result.exit_code).toBe(0);
      expect(collect_saw_empty).toBe(false);
      await expect(fs.stat(empty_path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(keep_path, "utf8")).toBe("video");
      expect(stdout).toMatch(/Removed 1 empty file/);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

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
