import { describe, expect, it } from "vitest";
import { parse_size, format_size } from "../lib/cleanup_disk/size.js";

describe("cleanup_disk size", () => {
  it("parses binary-ish size suffixes", () => {
    expect(parse_size("100M")).toBe(100 * 1024 * 1024);
    expect(parse_size("1G")).toBe(1024 * 1024 * 1024);
    expect(parse_size("512")).toBe(512);
  });

  it("rejects invalid sizes", () => {
    expect(() => parse_size("nope")).toThrow(/invalid size/i);
  });

  it("formats sizes for display", () => {
    expect(format_size(512)).toBe("512B");
    expect(format_size(100 * 1024 * 1024)).toMatch(/^100M$/);
  });
});
