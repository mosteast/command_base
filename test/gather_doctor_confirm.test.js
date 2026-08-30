import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

const { confirm_plan } = require("../lib/gather_doctor/confirm");

function create_tty_input(answer) {
  const input = new PassThrough();
  input.isTTY = true;
  queueMicrotask(() => {
    input.write(`${answer}\n`);
    input.end();
  });
  return input;
}

describe("gather_doctor confirm", () => {
  it("treats a Chrome profile name as confirmation, not cancel", async () => {
    const output = new PassThrough();
    const result = await confirm_plan(["Fix plan:"], {
      input: create_tty_input("Zheng"),
      output,
    });
    expect(result.confirmed).toBe(true);
    expect(result.profile_query).toBe("Zheng");
  });

  it("accepts y as most-recent confirmation without a profile query", async () => {
    const output = new PassThrough();
    const result = await confirm_plan(["Fix plan:"], {
      input: create_tty_input("y"),
      output,
    });
    expect(result.confirmed).toBe(true);
    expect(result.profile_query).toBe("");
  });

  it("cancels on empty or n", async () => {
    const output = new PassThrough();
    const result = await confirm_plan(["Fix plan:"], {
      input: create_tty_input(""),
      output,
    });
    expect(result.confirmed).toBe(false);
  });
});
