"use strict";

const fs = require("fs/promises");
const path = require("path");
const readline = require("readline");

async function confirm_plan(plan_lines, options = {}) {
  if (options.yes) return true;
  if (options.dry_run) return false;

  const output = options.output || process.stdout;
  const input = options.input || process.stdin;

  for (const line of plan_lines) {
    output.write(`${line}\n`);
  }
  output.write("Proceed? [y/N] ");

  if (!input.isTTY) {
    output.write("\n");
    return false;
  }

  const rl = readline.createInterface({ input, output });
  const answer = await new Promise((resolve) => {
    rl.question("", (value) => {
      rl.close();
      resolve(String(value || "").trim().toLowerCase());
    });
  });
  return answer === "y" || answer === "yes";
}

async function ensure_writable_dir(dir_path) {
  const resolved = path.resolve(dir_path);
  try {
    await fs.mkdir(resolved, { recursive: true });
    const probe = path.join(resolved, `.gather_setup_write_probe_${process.pid}`);
    await fs.writeFile(probe, "ok", "utf8");
    await fs.unlink(probe);
    return { ok: true, path: resolved };
  } catch (error) {
    return { ok: false, path: resolved, error: error.message };
  }
}

module.exports = {
  confirm_plan,
  ensure_writable_dir,
};
