import { describe, it, expect } from "vitest";

import instagram_likes_export_cli from "../bin/instagram_likes_export";

const {
  extract_json_summary_from_exporter_output,
  normalize_content_types,
  normalize_download_file_name_delimiter,
  normalize_download_file_name_format,
  normalize_modes,
  resolve_python_bin,
} = instagram_likes_export_cli;
const { compute_output_strategy } = instagram_likes_export_cli;

describe("instagram_likes_export output parser", () => {
  it("parses JSON when stdout has leading non-JSON logs", () => {
    const raw_output = [
      "Loaded session from /Users/me/.config/instaloader/session-me",
      "[DEBUG] something else",
      JSON.stringify({
        processed_posts: 5,
        skipped_posts: 0,
        unique_likers: 10,
        ghost_followers: 2,
      }),
      "",
    ].join("\n");

    const summary = extract_json_summary_from_exporter_output(raw_output);

    expect(summary.processed_posts).toBe(5);
    expect(summary.unique_likers).toBe(10);
  });

  it("throws when output contains no JSON", () => {
    expect(() =>
      extract_json_summary_from_exporter_output("Loaded session\nNo summary"),
    ).toThrow(/JSON/i);
  });
});

describe("instagram_likes_export python resolver", () => {
  function create_stub_logger() {
    const warn_messages = [];
    const debug_messages = [];
    return {
      warn_messages,
      debug_messages,
      warn(message) {
        warn_messages.push(String(message));
      },
      debug(message) {
        debug_messages.push(String(message));
      },
    };
  }

  function create_spawn_sync({ working_bin }) {
    return (python_bin) => {
      if (python_bin === working_bin) {
        return {
          stdout: JSON.stringify({
            ok: true,
            executable: "/opt/homebrew/opt/python@3.11/bin/python3.11",
            python_version: "3.11.13",
            instaloader_version: "4.15",
          }),
          stderr: "",
          status: 0,
        };
      }

      return {
        stdout: JSON.stringify({
          ok: false,
          executable: String(python_bin),
          python_version: "3.9.6",
          error_type: "ModuleNotFoundError",
          error: "No module named 'instaloader'",
        }),
        stderr: "",
        status: 1,
      };
    };
  }

  it("falls back when default python cannot import Instaloader", () => {
    const logger = create_stub_logger();
    const spawn_sync = create_spawn_sync({ working_bin: "python3.11" });

    const python_bin = resolve_python_bin({
      requested_python_bin: "python3",
      user_provided_python: false,
      logger,
      spawn_sync,
    });

    expect(python_bin).toBe("python3.11");
    expect(logger.warn_messages.join("\n")).toMatch(/using 'python3\.11'/i);
  });

  it("fails fast when user-specified python cannot import Instaloader", () => {
    const logger = create_stub_logger();
    const spawn_sync = create_spawn_sync({ working_bin: "python3.11" });

    expect(() =>
      resolve_python_bin({
        requested_python_bin: "/usr/bin/python3",
        user_provided_python: true,
        logger,
        spawn_sync,
      }),
    ).toThrow(/-m pip install instaloader==4\.15/i);
  });
});

describe("instagram_likes_export content type normalization", () => {
  it("defaults to liked", () => {
    expect(normalize_content_types(undefined)).toEqual(["liked"]);
  });

  it("accepts liked", () => {
    expect(normalize_content_types(["liked"])).toEqual(["liked"]);
  });

  it("splits comma-separated values", () => {
    expect(normalize_content_types("posts,reels")).toEqual(["posts", "reels"]);
  });

  it("splits comma-separated values inside arrays", () => {
    expect(normalize_content_types(["posts,reels"])).toEqual(["posts", "reels"]);
  });

  it("deduplicates repeat values", () => {
    expect(normalize_content_types(["posts", "posts"])).toEqual(["posts"]);
  });

  it("rejects unknown values", () => {
    expect(() => normalize_content_types(["nope"])).toThrow(/content/i);
  });
});

describe("instagram_likes_export mode normalization", () => {
  it("defaults to per_post", () => {
    expect(normalize_modes(undefined)).toEqual(["per_post"]);
  });

  it("splits comma-separated values", () => {
    expect(normalize_modes("per_post,unique")).toEqual(["per_post", "unique"]);
  });

  it("splits comma-separated values inside arrays", () => {
    expect(normalize_modes(["per_post,unique"])).toEqual(["per_post", "unique"]);
  });

  it("deduplicates repeat values", () => {
    expect(normalize_modes(["per_post", "per_post"])).toEqual(["per_post"]);
  });

  it("rejects unknown values", () => {
    expect(() => normalize_modes(["nope"])).toThrow(/mode/i);
  });
});

describe("instagram_likes_export download filename format normalization", () => {
  it("defaults to timestamp,id,safe_title_or_desc,safe_author,index_or_empty", () => {
    expect(normalize_download_file_name_format(undefined)).toEqual([
      "timestamp",
      "id",
      "safe_title_or_desc",
      "safe_author",
      "index_or_empty",
    ]);
  });

  it("accepts comma-separated values", () => {
    expect(
      normalize_download_file_name_format("timestamp,id,index_or_empty"),
    ).toEqual(["timestamp", "id", "index_or_empty"]);
  });

  it("accepts space/plus separated values", () => {
    expect(
      normalize_download_file_name_format("timestamp + id + index_or_empty"),
    ).toEqual(["timestamp", "id", "index_or_empty"]);
  });

  it("deduplicates repeat tokens", () => {
    expect(
      normalize_download_file_name_format(
        "timestamp,id,id,safe_author,safe_author,index_or_empty",
      ),
    ).toEqual(["timestamp", "id", "safe_author", "index_or_empty"]);
  });

  it("rejects unknown tokens", () => {
    expect(() => normalize_download_file_name_format("nope")).toThrow(/format/i);
  });
});

describe("instagram_likes_export download filename delimiter normalization", () => {
  it("defaults to __", () => {
    expect(normalize_download_file_name_delimiter(undefined)).toBe("__");
  });

  it("rejects path separators", () => {
    expect(() => normalize_download_file_name_delimiter("a/b")).toThrow(
      /delimiter/i,
    );
  });

  it("accepts a custom delimiter", () => {
    expect(normalize_download_file_name_delimiter("--")).toBe("--");
  });
});

describe("instagram_likes_export output strategy", () => {
  it("continues when no outputs exist", () => {
    const result = compute_output_strategy({
      modes: ["per_post"],
      refresh: false,
      dry_run: false,
      existing_outputs: { per_post: false, unique: false, ghost: false },
      checkpoint_exists: false,
    });
    expect(result.action).toBe("continue");
  });

  it("appends when per_post exists and checkpoint exists", () => {
    const result = compute_output_strategy({
      modes: ["per_post"],
      refresh: false,
      dry_run: false,
      existing_outputs: { per_post: true, unique: false, ghost: false },
      checkpoint_exists: true,
    });
    expect(result.action).toBe("append");
    expect(result.append_outputs.per_post).toBe(true);
  });

  it("aborts when per_post exists but checkpoint missing", () => {
    const result = compute_output_strategy({
      modes: ["per_post"],
      refresh: false,
      dry_run: false,
      existing_outputs: { per_post: true, unique: false, ghost: false },
      checkpoint_exists: false,
    });
    expect(result.action).toBe("abort");
  });

  it("aborts when non-per_post modes requested and outputs exist", () => {
    const result = compute_output_strategy({
      modes: ["unique"],
      refresh: false,
      dry_run: false,
      existing_outputs: { per_post: false, unique: true, ghost: false },
      checkpoint_exists: true,
    });
    expect(result.action).toBe("abort");
  });
});
