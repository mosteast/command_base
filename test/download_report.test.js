import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  build_download_report,
  create_default_report_dir,
  create_default_report_root,
  compute_archive_line_delta,
  parse_tool_output_summary,
  render_download_report_markdown,
  write_download_report,
} = require("../lib/download_report");

async function create_temp_dir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "download-report-test-"));
}

describe("download report helper", () => {
  it("builds and renders a normalized report", () => {
    const report = build_download_report({
      tool_name: "example_tool",
      tool_version: "1.2.3",
      status: "completed",
      started_at: "2026-05-31T00:00:00.000Z",
      ended_at: "2026-05-31T00:00:02.500Z",
      input: { target: ["https://example.com/a"] },
      output: { directory: "/tmp/output" },
      command: ["example_tool https://example.com/a"],
      summary: {
        total: 1,
        executed: 1,
        failed: 0,
        downloaded_count: 2,
      },
    });

    const markdown = render_download_report_markdown(report);

    expect(report).toMatchObject({
      schema_version: 1,
      tool_name: "example_tool",
      status: "completed",
      duration_ms: 2500,
      summary: {
        total: 1,
        executed: 1,
        failed: 0,
        downloaded_count: 2,
      },
    });
    expect(markdown).toContain("# example_tool Download Report");
    expect(markdown).toContain("- Status: completed");
    expect(markdown).toContain("| downloaded_count | 2 |");
  });

  it("computes archive line deltas from before snapshots", async () => {
    const temp_root = await create_temp_dir();
    const archive_file = path.join(temp_root, "archive.txt");

    try {
      await fs.writeFile(archive_file, "old-entry\nnew-entry\n", "utf8");

      const result = await compute_archive_line_delta([
        { path: archive_file, before_count: 1 },
      ]);

      expect(result).toMatchObject({
        before_count: 1,
        after_count: 2,
        delta_count: 1,
      });
      expect(result.file[0]).toMatchObject({
        path: archive_file,
        before_count: 1,
        after_count: 2,
        delta_count: 1,
      });
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("parses warning, error, skipped, and download markers from tool output", () => {
    const summary = parse_tool_output_summary(
      [
        "[download] Destination: video.mp4",
        "WARNING: already in archive: old",
        "ERROR: simulated failure",
        "[download] 100% of 1.00MiB",
      ].join("\n"),
    );

    expect(summary).toMatchObject({
      warning_count: 1,
      error_count: 1,
      skipped_count: 1,
      output_download_marker_count: 2,
    });
  });

  it("writes JSON and Markdown reports", async () => {
    const temp_root = await create_temp_dir();
    const report_dir = path.join(temp_root, "report");

    try {
      const report = build_download_report({
        tool_name: "example_tool",
        tool_version: "1.2.3",
        status: "dry_run",
        started_at: "2026-05-31T00:00:00.000Z",
        ended_at: "2026-05-31T00:00:00.000Z",
        summary: { dry_run: 1 },
      });

      const result = await write_download_report(report_dir, report);
      const saved_report = JSON.parse(
        await fs.readFile(result.json_path, "utf8"),
      );
      const markdown = await fs.readFile(result.markdown_path, "utf8");

      expect(saved_report.tool_name).toBe("example_tool");
      expect(saved_report.artifact.report_json_path).toBe(result.json_path);
      expect(markdown).toContain("# example_tool Download Report");
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("uses the largest existing numeric batch across report tool directories", async () => {
    const temp_root = await create_temp_dir();
    const report_root = path.join(temp_root, "report");

    try {
      await fs.mkdir(path.join(report_root, "gather", "1"), {
        recursive: true,
      });
      await fs.mkdir(path.join(report_root, "xsave_yt_dlp", "2"), {
        recursive: true,
      });
      await fs.mkdir(path.join(report_root, "xsave_yt_dlp", "draft"), {
        recursive: true,
      });

      expect(create_default_report_dir("gather", { report_root })).toBe(
        path.join(report_root, "gather", "3"),
      );
      expect(
        create_default_report_dir("xsave_yt_dlp", {
          report_root,
          batch_number: 3,
        }),
      ).toBe(path.join(report_root, "xsave_yt_dlp", "3"));
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("builds the default report root under the iCloud saved tmp directory", () => {
    expect(create_default_report_root("/tmp/example home")).toBe(
      path.join(
        "/tmp/example home",
        "Library",
        "Mobile Documents",
        "com~apple~CloudDocs",
        "main",
        "saved",
        "tmp",
        "report",
      ),
    );
  });
});
