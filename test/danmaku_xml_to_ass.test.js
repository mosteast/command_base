import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const converter_entry = path.resolve(
  __dirname,
  "../utility/danmaku_xml_to_ass.py",
);

function run_python(args) {
  return new Promise((resolve, reject) => {
    execFile("python3", args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const exec_error = new Error(stderr || error.message);
        exec_error.stdout = stdout;
        exec_error.stderr = stderr;
        reject(exec_error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

describe("danmaku_xml_to_ass", () => {
  it("converts bilibili danmaku xml into an ass subtitle file", async () => {
    const temp_dir = await fs.mkdtemp(path.join(os.tmpdir(), "danmaku-ass-"));
    const input_path = path.join(temp_dir, "sample.danmaku.xml");
    const output_path = path.join(temp_dir, "sample.danmaku.ass");

    await fs.writeFile(
      input_path,
      `<?xml version="1.0" encoding="UTF-8"?>
<i>
  <d p="1.5,1,25,16777215,1764297365,0,abc,1,10">scrolling test</d>
  <d p="2.0,5,30,16711680,1764297365,0,def,2,10">top fixed</d>
</i>
`,
      "utf8",
    );

    await run_python([converter_entry, input_path, output_path]);

    const output_bytes = await fs.readFile(output_path);
    const output_text = output_bytes.toString("utf8");
    expect(Array.from(output_bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(output_text).toContain("[Events]");
    expect(output_text).toContain("Dialogue:");
    expect(output_text).toContain(",134");
    expect(output_text).toContain("scrolling test");
    expect(output_text).toContain("top fixed");
    expect(output_text).toMatch(/\\move\(/);
    expect(output_text).toMatch(/\\pos\(/);
  });
});
