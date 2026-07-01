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
          exec_error.exit_code = error.code || 1;
          reject(exec_error);
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });
}

describe("f2 Douyin compatibility patch", () => {
  it("extracts fallback video and article fields from aweme_type 163 payloads", async () => {
    const code = `
import json
from f2.apps.douyin.filter import UserPostFilter, PostDetailFilter

fixture = {
    "aweme_list": [{
        "aweme_id": "1",
        "aweme_type": 163,
        "desc": "Example article",
        "author": {"sec_uid": "sec", "uid": "uid", "nickname": "Tester"},
        "status": {"private_status": 0, "is_prohibited": False},
        "video": {
            "bit_rate": [],
            "play_addr": {"url_list": ["https://example.com/video.mp4"]},
            "origin_cover": {"url_list": ["https://example.com/cover.jpeg"]}
        },
        "article_info": {
            "article_title": "Example article",
            "article_content": "{\\"markdown\\": \\"Line 1\\\\n\\\\nLine 2\\"}",
            "fe_data": "{\\"head_poster_list\\": {\\"url_list\\": [\\"https://example.com/poster.jpeg\\"]}, \\"image_list\\": [{\\"url_list\\": [\\"https://example.com/article-image.jpeg\\"]}]}"
        }
    }]
}

user_post = UserPostFilter(fixture)
post_detail = PostDetailFilter({"aweme_detail": fixture["aweme_list"][0]})

payload = {
    "user_post_video_play_addr": user_post.video_play_addr,
    "user_post_cover": user_post.cover,
    "user_post_article_markdown": user_post.article_markdown,
    "user_post_article_cover": user_post.article_cover,
    "user_post_article_images": user_post.article_images,
    "post_detail_video_play_addr": post_detail.video_play_addr,
    "post_detail_article_markdown": post_detail.article_markdown,
}

print(json.dumps(payload))
`;

    const result = await run_python(code);
    const json_line = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    const payload = JSON.parse(json_line);

    expect(payload.user_post_video_play_addr).toEqual([
      ["https://example.com/video.mp4"],
    ]);
    expect(payload.user_post_cover).toEqual(["https://example.com/cover.jpeg"]);
    expect(payload.user_post_article_markdown[0]).toContain("Line 1");
    expect(payload.user_post_article_cover).toEqual([
      "https://example.com/poster.jpeg",
    ]);
    expect(payload.user_post_article_images).toEqual([
      ["https://example.com/article-image.jpeg"],
    ]);
    expect(payload.post_detail_video_play_addr).toEqual([
      "https://example.com/video.mp4",
    ]);
    expect(payload.post_detail_article_markdown).toContain("Example article");
  });

  it("routes article payloads to article downloads before legacy aweme_type checks", async () => {
    const code = `
import asyncio
import json
from pathlib import Path
from f2.apps.douyin.dl import DouyinDownloader

class FakeDownloader:
    def __init__(self):
        self.saved = []

    async def download_music(self):
        self.saved.append("music")

    async def download_cover(self):
        self.saved.append("cover")

    async def download_desc(self):
        self.saved.append("desc")

    async def download_video(self):
        self.saved.append("video")

    async def download_images(self):
        self.saved.append("images")

    async def download_article_markdown(self):
        self.saved.append("article_markdown")

    async def download_article_cover(self):
        self.saved.append("article_cover")

    async def download_article_images(self):
        self.saved.append("article_images")

    async def save_last_aweme_id(self, sec_user_id, aweme_id):
        self.saved.append(["save", sec_user_id, aweme_id])

fake = FakeDownloader()
fake.handler_download = DouyinDownloader.handler_download.__get__(fake, FakeDownloader)

payload = {
    "sec_user_id": "sec",
    "aweme_id": "aweme",
    "aweme_type": 163,
    "private_status": 0,
    "is_prohibited": False,
    "article_markdown": "# Article",
    "article_cover": "https://example.com/poster.jpeg",
    "article_images": ["https://example.com/article-image.jpeg"],
    "video_play_addr": ["https://example.com/video.mp4"],
}

asyncio.run(fake.handler_download({"naming": "{aweme_id}"}, payload, Path("/tmp")))
print(json.dumps(fake.saved))
`;

    const result = await run_python(code);
    const json_line = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    const payload = JSON.parse(json_line);

    expect(payload).toContain("article_markdown");
    expect(payload).toContain("article_cover");
    expect(payload).toContain("article_images");
    expect(payload).not.toContain("video");
  });

  it("redownloads zero-byte files instead of treating them as completed", async () => {
    const code = `
import asyncio
import json
import tempfile
from pathlib import Path
from f2.dl.base_downloader import BaseDownloader

class FakeProgress:
    def __init__(self):
        self.events = []

    async def add_task(self, **kwargs):
        self.events.append({"op": "add", **kwargs})
        return len(self.events)

    async def update(self, task_id, **kwargs):
        self.events.append({"op": "update", "task_id": task_id, **kwargs})

class FakeDownloader:
    def __init__(self):
        self.progress = FakeProgress()
        self.download_tasks = []

    def _ensure_path(self, target_path):
        return Path(target_path)

    async def download_file(self, task_id, file_url, full_path):
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_bytes(b"downloaded")

async def main():
    temp_root = Path(tempfile.mkdtemp())
    target_path = temp_root / "sample.mp4"
    target_path.write_bytes(b"")

    fake = FakeDownloader()
    await BaseDownloader.initiate_download(
        fake,
        "视频",
        "https://example.com/video.mp4",
        temp_root,
        "sample",
        ".mp4",
    )

    if fake.download_tasks:
        await asyncio.gather(*fake.download_tasks)

    payload = {
        "download_task_count": len(fake.download_tasks),
        "file_size": target_path.stat().st_size,
        "progress_events": fake.progress.events,
    }
    print(json.dumps(payload))

asyncio.run(main())
`;

    const result = await run_python(code);
    const json_line = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    const payload = JSON.parse(json_line);

    expect(payload.download_task_count).toBe(1);
    expect(payload.file_size).toBeGreaterThan(0);
    expect(payload.progress_events[0].description).not.toContain("跳过");
  });
});
