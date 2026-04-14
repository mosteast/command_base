import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";

const cli_entry = path.resolve(__dirname, "../bin/f2_compat");
const compat_dir = path.resolve(__dirname, "../utility/f2_compat");

function run_cli(args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cli_entry,
      args,
      {
        env: { ...process.env, ...env, FORCE_COLOR: "0" },
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

async function create_fake_upstream(temp_root) {
  const script_path = path.join(temp_root, "fake_f2");
  const script_text = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf '{\"args\":['",
    "first=true",
    "for arg in \"$@\"; do",
    "  if [ \"$first\" = true ]; then",
    "    first=false",
    "  else",
    "    printf ','",
    "  fi",
    "  python3 - <<'PY' \"$arg\"",
    "import json, sys",
    "print(json.dumps(sys.argv[1]), end='')",
    "PY",
    "done",
    "printf '],\"patch\":'",
    "python3 - <<'PY'",
    "import json, os",
    "print(json.dumps(os.environ.get('COMMAND_BASE_F2_PATCH')), end='')",
    "PY",
    "printf ',\"pythonpath\":'",
    "python3 - <<'PY'",
    "import json, os",
    "print(json.dumps(os.environ.get('PYTHONPATH')), end='')",
    "PY",
    "printf '}'",
    "",
  ].join("\n");

  await fs.writeFile(script_path, script_text, "utf8");
  await fs.chmod(script_path, 0o755);
  return script_path;
}

describe("f2_compat wrapper", () => {
  it("injects the compatibility patch for Douyin commands", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "f2-wrapper-"));

    try {
      const fake_upstream = await create_fake_upstream(temp_root);
      const result = await run_cli(
        ["dy", "-M", "post", "-u", "https://www.douyin.com/user/example"],
        {
          COMMAND_BASE_F2_UPSTREAM: fake_upstream,
        },
      );

      const payload = JSON.parse(result.stdout);
      expect(payload.args).toEqual([
        "dy",
        "-M",
        "post",
        "-u",
        "https://www.douyin.com/user/example",
      ]);
      expect(payload.patch).toBe("1");
      expect(payload.pythonpath).toContain(compat_dir);
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });

  it("passes through non-Douyin commands without patch injection", async () => {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "f2-wrapper-"));

    try {
      const fake_upstream = await create_fake_upstream(temp_root);
      const result = await run_cli(["--version"], {
        COMMAND_BASE_F2_UPSTREAM: fake_upstream,
      });

      const payload = JSON.parse(result.stdout);
      expect(payload.args).toEqual(["--version"]);
      expect(payload.patch).toBe(null);
      expect(payload.pythonpath === null || !payload.pythonpath.includes(compat_dir)).toBe(
        true,
      );
    } finally {
      await fs.rm(temp_root, { recursive: true, force: true });
    }
  });
});
