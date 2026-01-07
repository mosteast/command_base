import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { unwrap_single_markdown_fence } = require("../utility/_ai_cli_utils");

describe("unwrap_single_markdown_fence", () => {
  it("unwraps a single fenced markdown block", () => {
    const input = ["```markdown", "# Title", "", "- a", "- b", "```"].join(
      "\n",
    );

    expect(unwrap_single_markdown_fence(input)).toBe(
      ["# Title", "", "- a", "- b"].join("\n"),
    );
  });

  it("leaves non-wrapped output unchanged", () => {
    expect(unwrap_single_markdown_fence("# Title\n- a")).toBe("# Title\n- a");
  });
});
