"use strict";

const fs = require("fs/promises");
const path = require("path");
const readline = require("readline");

function confirm_result(confirmed, profile_query = "") {
  return { confirmed, profile_query };
}

async function confirm_plan(plan_lines, options = {}) {
  if (options.yes) return confirm_result(true);
  if (options.dry_run) return confirm_result(false);

  const output = options.output || process.stdout;
  const input = options.input || process.stdin;

  if (!options.skip_plan) {
    for (const line of plan_lines) {
      output.write(`${line}\n`);
    }
  }
  output.write("Proceed? [y / profile name / N] ");

  if (!input.isTTY) {
    output.write("\n");
    return confirm_result(false);
  }

  const rl = readline.createInterface({ input, output });
  const raw_answer = await new Promise((resolve) => {
    rl.question("", (value) => {
      rl.close();
      resolve(String(value || "").trim());
    });
  });
  const answer = raw_answer.toLowerCase();
  if (!answer || answer === "n" || answer === "no") return confirm_result(false);
  if (answer === "y" || answer === "yes") return confirm_result(true);
  return confirm_result(true, raw_answer);
}

async function ensure_writable_dir(dir_path) {
  const resolved = path.resolve(dir_path);
  try {
    await fs.mkdir(resolved, { recursive: true });
    const probe = path.join(resolved, `.gather_doctor_write_probe_${process.pid}`);
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
