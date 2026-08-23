import path from "path";
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";

const compat_dir = path.resolve(__dirname, "../utility/f2_compat");
const python_bin = path.join(
  process.env.HOME || "",
  ".local/pipx/venvs/f2/bin/python",
);

function run_python(code) {
  return new Promise((resolve, reject) => {
    execFile(
      python_bin,
      ["-c", code],
      {
        env: {
          ...process.env,
          COMMAND_BASE_F2_PATCH: "1",
          PYTHONPATH: compat_dir,
        },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && error.code !== 0) {
          const exec_error = new Error(stderr || error.message);
          exec_error.stdout = stdout;
          exec_error.stderr = stderr;
          reject(exec_error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function last_json(stdout) {
  const json_line = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  return JSON.parse(json_line);
}

describe("f2 Douyin like browser fallback", () => {
  it("serves cached favorite pages by max_cursor", async () => {
    const result = await run_python(`
import json
from f2_douyin_like_browser import select_like_page

cache = {
    "pages": [
        {"max_cursor_in": 0, "max_cursor": 111, "has_more": 1, "aweme_list": [{"aweme_id": "a"}]},
        {"max_cursor_in": 111, "max_cursor": 222, "has_more": 0, "aweme_list": [{"aweme_id": "b"}]},
    ]
}
first = select_like_page(cache, 0)
second = select_like_page(cache, 111)
missing = select_like_page(cache, 999)
print(json.dumps({
    "first_id": first["aweme_list"][0]["aweme_id"],
    "first_has_more": first["has_more"],
    "second_id": second["aweme_list"][0]["aweme_id"],
    "missing": missing,
}))
`);
    const payload = last_json(result.stdout);
    expect(payload.first_id).toBe("a");
    expect(payload.first_has_more).toBe(1);
    expect(payload.second_id).toBe("b");
    expect(payload.missing).toBeNull();
  });

  it("patches fetch_user_like to use the browser helper after HTTP 403", async () => {
    const result = await run_python(`
import json
from types import SimpleNamespace
from f2_douyin_patch import apply_patch
from f2.apps.douyin.crawler import DouyinCrawler
from f2.apps.douyin.model import UserLike
from f2.exceptions.api_exceptions import APIResponseError
import f2_douyin_like_browser

apply_patch()

async def fake_original(self, params):
    raise APIResponseError("HTTP状态码错误：", 403)

async def fake_browser(self, params):
    return {
        "status_code": 0,
        "has_more": 0,
        "max_cursor": 1,
        "aweme_list": [{"aweme_id": "liked-1"}],
    }

f2_douyin_like_browser.fetch_like_via_browser = fake_browser
DouyinCrawler._original_fetch_user_like = fake_original
payload = __import__("asyncio").run(
    DouyinCrawler.fetch_user_like(
        SimpleNamespace(headers={"Cookie": "sessionid=dummy", "User-Agent": "test"}),
        UserLike(max_cursor=0, count=1, sec_user_id="sec"),
    )
)
print(json.dumps({
    "count": len(payload["aweme_list"]),
    "aweme_id": payload["aweme_list"][0]["aweme_id"],
    "has_cookie_leak": "sessionid=" in json.dumps(payload),
}))
`);
    const payload = last_json(result.stdout);
    expect(payload.count).toBe(1);
    expect(payload.aweme_id).toBe("liked-1");
    expect(payload.has_cookie_leak).toBe(false);
  });
});
