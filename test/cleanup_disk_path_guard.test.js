import { describe, expect, it } from "vitest";
import { is_dangerous_path } from "../lib/cleanup_disk/path_guard.js";

describe("cleanup_disk path_guard", () => {
  const home = "/Users/hailang";

  it("rejects home, /Users, /", () => {
    expect(is_dangerous_path("/", { home })).toBe(true);
    expect(is_dangerous_path("/Users", { home })).toBe(true);
    expect(is_dangerous_path(home, { home })).toBe(true);
    expect(is_dangerous_path("/private/var/folders", { home })).toBe(true);
  });

  it("allows nested cache paths", () => {
    expect(
      is_dangerous_path(`${home}/Library/Caches/JetBrains`, { home }),
    ).toBe(false);
  });
});
