import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const mimic = require("../bin/mimic");

function create_cli_argv(overrides = {}) {
  return {
    repo_uri: "mosteast/giao",
    dir_path: "workspace/demo",
    branch: "",
    "keep-origin": false,
    "keep-branch": false,
    "parent-name": "parent",
    "fork-branch": "master",
    "create-remote": false,
    "remote-name": "",
    "remote-alias": "",
    "remote-visibility": "private",
    "dry-run": false,
    quiet: false,
    debug: false,
    ...overrides,
  };
}

describe("mimic helpers", () => {
  it("builds clone args with gh git-flag separator", () => {
    const clone_args = mimic.build_clone_args(
      {
        repo_uri: "mosteast/giao",
        branch: "feature/login",
      },
      "/tmp/demo",
    );

    expect(clone_args).toEqual([
      "repo",
      "clone",
      "mosteast/giao",
      "/tmp/demo",
      "--",
      "--recursive",
      "--single-branch",
      "--branch=feature/login",
    ]);
  });

  it("derives the remote repo name from the target directory", () => {
    expect(
      mimic.derive_remote_repo_name(
        {
          remote_name: "",
        },
        "/tmp/workspace/demo",
      ),
    ).toBe("demo");
  });

  it("defaults the created remote alias to fork when origin is preserved", () => {
    expect(
      mimic.resolve_remote_alias({
        remote_alias: "",
        keep_origin: true,
      }),
    ).toBe("fork");
  });

  it("rejects create-remote when keep-origin still uses origin", () => {
    expect(() =>
      mimic.normalize_cli_options(
        create_cli_argv({
          "keep-origin": true,
          "create-remote": true,
          "remote-alias": "origin",
        }),
      ),
    ).toThrow(/--remote-alias origin conflicts with --keep-origin/);
  });

  it("parses create-remote options and keeps the safe alias fallback", () => {
    const cli_result = mimic.parse_cli_arguments([
      "mosteast/giao",
      "workspace/demo",
      "--create-remote",
      "--keep-origin",
    ]);

    expect(cli_result.action).toBe("run");
    expect(cli_result.options.create_remote).toBe(true);
    expect(mimic.resolve_remote_alias(cli_result.options)).toBe("fork");
  });
});
