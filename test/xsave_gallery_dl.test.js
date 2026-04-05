import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cli_entry = path.resolve(__dirname, "../bin/xsave_gallery_dl");

function run_cli(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cli_entry,
      args,
      {
        env: { ...process.env, FORCE_COLOR: "0", ...env },
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

        resolve({
          stdout,
          stderr,
          exit_code: error ? error.code || 0 : 0,
        });
      },
    );
  });
}

function strip_ansi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

async function create_temp_dir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "xsave-gallery-dl-test-"));
}

async function create_fake_gallery_dl_bin(temp_root, version_text) {
  const bin_dir = path.join(temp_root, "fake_bin");
  const script_path = path.join(bin_dir, "gallery-dl");

  await fs.mkdir(bin_dir, { recursive: true });
  await fs.writeFile(
    script_path,
    `#!/usr/bin/env bash
set -u

log_file="\${FAKE_GALLERY_DL_LOG:?}"
printf '%s\\n' "$*" >> "$log_file"

if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' "${version_text}"
  exit 0
fi

printf '%s\\n' "[fake-gallery-dl] unexpected execution" >&2
exit 99
`,
    "utf8",
  );
  await fs.chmod(script_path, 0o755);

  return { bin_dir };
}

describe("xsave_gallery_dl gallery-dl version guard", () => {
  it("fails early with an actionable error for outdated gallery-dl versions", async () => {
    const temp_root = await create_temp_dir();
    const fake_gallery_dl_log = path.join(temp_root, "fake_gallery_dl.log");
    const output_dir = path.join(temp_root, "output");

    await fs.writeFile(fake_gallery_dl_log, "", "utf8");

    try {
      const fake_gallery_dl = await create_fake_gallery_dl_bin(
        temp_root,
        "1.31.2",
      );

      let exec_error;
      try {
        await run_cli(
          [
            "--debug",
            "--dry-run",
            "--no-cookies",
            "--no-archive",
            "--output-dir",
            output_dir,
            "https://x.com/example",
          ],
          {
            env: {
              PATH: `${fake_gallery_dl.bin_dir}:${process.env.PATH || ""}`,
              FAKE_GALLERY_DL_LOG: fake_gallery_dl_log,
            },
          },
        );
      } catch (error) {
        exec_error = error;
      }

      const invocation_lines = (await fs.readFile(fake_gallery_dl_log, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean);

      const combined_output = strip_ansi(
        `${exec_error.stdout}\n${exec_error.stderr}`,
      );

      expect(exec_error?.exit_code).toBe(1);
      expect(combined_output).toContain(
        "gallery-dl 1.31.10 or newer is required for current X downloads. Detected 1.31.2.",
      );
      expect(combined_output).toContain(
        "Older gallery-dl releases fail on X with 'ondemand.s.a.js' 404 errors.",
      );
      expect(combined_output).toContain("brew upgrade gallery-dl");
      expect(invocation_lines).toContain("--version");
      expect(invocation_lines.some((line) => line !== "--version")).toBe(false);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("allows dry-runs to proceed when gallery-dl meets the minimum version", async () => {
    const temp_root = await create_temp_dir();
    const fake_gallery_dl_log = path.join(temp_root, "fake_gallery_dl.log");
    const output_dir = path.join(temp_root, "output");

    await fs.writeFile(fake_gallery_dl_log, "", "utf8");

    try {
      const fake_gallery_dl = await create_fake_gallery_dl_bin(
        temp_root,
        "1.31.10",
      );

      const result = await run_cli(
        [
          "--debug",
          "--dry-run",
          "--no-cookies",
          "--no-archive",
          "--output-dir",
          output_dir,
          "https://x.com/example",
        ],
        {
          env: {
            PATH: `${fake_gallery_dl.bin_dir}:${process.env.PATH || ""}`,
            FAKE_GALLERY_DL_LOG: fake_gallery_dl_log,
          },
        },
      );

      const stdout_text = strip_ansi(result.stdout);
      const invocation_lines = (await fs.readFile(fake_gallery_dl_log, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean);

      expect(result.exit_code).toBe(0);
      expect(stdout_text).toContain("Detected gallery-dl version 1.31.10.");
      expect(stdout_text).toContain("Dry-run command: gallery-dl");
      expect(stdout_text).toContain("https://x.com/example");
      expect(invocation_lines).toEqual(["--version"]);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
