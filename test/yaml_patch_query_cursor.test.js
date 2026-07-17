import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import addressable_module from "../lib/yaml_patch/addressable";
import artifact_module from "../lib/yaml_patch/artifact_version";
import node_index_module from "../lib/yaml_patch/node_index";
import parser_module from "../lib/yaml_patch/parser";
import isolated_module from "../lib/yaml_patch/isolated";
import query_cursor_module from "../lib/yaml_patch/query_cursor";
import query_v2_module from "../lib/yaml_patch/query_v2";
import source_module from "../lib/yaml_patch/source";

const { build_addressable_index } = addressable_module;
const { canonical_json, clone_json_value } = artifact_module;
const { build_node_index } = node_index_module;
const { parse_yaml_source } = parser_module;
const { run_isolated_yaml_action } = isolated_module;
const { DEFAULT_MAX_CURSOR_BYTES, create_query_cursor, decode_query_cursor } =
  query_cursor_module;
const { assert_match_expectation, normalize_expect_matches, run_query_v2 } =
  query_v2_module;
const { create_source_record, sha256_digest } = source_module;

function create_input(text, file_path) {
  const source = create_source_record(Buffer.from(text, "utf8"), {
    file_path,
  });
  const index = build_node_index(source, parse_yaml_source(source));
  return { index, addressable_index: build_addressable_index(index) };
}

function paged_query(overrides = {}) {
  return {
    version: 2,
    where: {
      all: [
        { predicate: "addressable_type", equals: "scalar" },
        { predicate: "raw_regex", pattern: "^value-", flags: "" },
      ],
    },
    projection: {
      fields: ["source_path", "raw", "locator"],
      missing: "error",
    },
    limits: { max_result: 100, max_output_bytes: 1024 * 1024 },
    ...overrides,
  };
}

describe("YAML query v2 cursor", () => {
  it("round-trips an opaque integrity-checked cursor", () => {
    const cursor = create_query_cursor({
      input_digest: "a".repeat(64),
      query_digest: "b".repeat(64),
      offset: 2,
    });

    expect(decode_query_cursor(cursor)).toEqual({
      version: 1,
      purpose: "page",
      input_digest: "a".repeat(64),
      query_digest: "b".repeat(64),
      offset: 2,
    });
  });

  it("rejects tampering, invalid shape, and unsupported versions", () => {
    const cursor = create_query_cursor({
      input_digest: "a".repeat(64),
      query_digest: "b".repeat(64),
      offset: 2,
    });
    const document = JSON.parse(Buffer.from(cursor, "base64url").toString());
    document.offset = 3;
    const tampered = Buffer.from(JSON.stringify(document)).toString(
      "base64url",
    );
    expect(() => decode_query_cursor(tampered)).toThrowError(
      expect.objectContaining({ code: "REQUEST_ERROR" }),
    );
    document.offset = 2;
    document.version = 9;
    const version_tampered = Buffer.from(canonical_json(document)).toString(
      "base64url",
    );
    expect(() => decode_query_cursor(version_tampered)).toThrowError(
      expect.objectContaining({ code: "REQUEST_ERROR" }),
    );
    expect(() => decode_query_cursor("e30")).toThrowError(
      expect.objectContaining({ code: "REQUEST_ERROR" }),
    );

    const payload = {
      version: 9,
      purpose: "page",
      input_digest: "a".repeat(64),
      query_digest: "b".repeat(64),
      offset: 0,
    };
    const unsupported = Buffer.from(
      canonical_json({
        ...payload,
        checksum: sha256_digest(Buffer.from(canonical_json(payload))),
      }),
    ).toString("base64url");
    expect(() => decode_query_cursor(unsupported)).toThrowError(
      expect.objectContaining({ code: "PROTOCOL_VERSION_UNSUPPORTED" }),
    );
  });

  it("rejects oversized cursor text before decoding it", () => {
    const oversized = "A".repeat(
      Math.ceil((DEFAULT_MAX_CURSOR_BYTES * 4) / 3) + 1,
    );
    expect(() => decode_query_cursor(oversized)).toThrowError(
      expect.objectContaining({ code: "REQUEST_ERROR" }),
    );
  });

  it("bounds JSON cloning by nodes, depth, and array items", () => {
    expect(() =>
      clone_json_value([1, 2, 3], "bounded", { max_array_items: 2 }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
    expect(() =>
      clone_json_value({ one: 1, two: 2 }, "bounded", { max_nodes: 2 }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
    expect(() =>
      clone_json_value({ child: { child: true } }, "bounded", {
        max_depth: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
  });

  it("normalizes read, write_single, and bounded write_batch expectations", () => {
    expect(normalize_expect_matches(undefined, "read")).toBeUndefined();
    expect(normalize_expect_matches(2, "read")).toEqual({
      exact: 2,
      min: 2,
      max: 2,
    });
    expect(normalize_expect_matches({ min: 1, max: 3 }, "read")).toEqual({
      min: 1,
      max: 3,
    });
    expect(normalize_expect_matches(undefined, "write_single")).toEqual({
      exact: 1,
      min: 1,
      max: 1,
    });
    expect(() =>
      normalize_expect_matches(undefined, "write_batch", { max_result: 10 }),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_ERROR" }));
    expect(() =>
      normalize_expect_matches({ min: 1 }, "write_batch", { max_result: 10 }),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_ERROR" }));
    expect(() =>
      normalize_expect_matches({ exact: 2 }, "write_batch", {}),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_ERROR" }));
  });

  it("uses stable mismatch codes and bounded projected diagnostics", () => {
    expect(() => assert_match_expectation(0, { min: 1, max: 2 })).toThrowError(
      expect.objectContaining({ code: "NO_MATCH" }),
    );
    expect(() =>
      assert_match_expectation(2, { exact: 1, min: 1, max: 1 }),
    ).toThrowError(expect.objectContaining({ code: "AMBIGUOUS_MATCH" }));
    try {
      assert_match_expectation(
        20,
        { exact: 4, min: 4, max: 4 },
        {
          candidates: Array.from({ length: 20 }, (_, index) => ({
            source_path: `/tmp/${index}.yaml`,
            document: 0,
            line: index + 1,
            column: 1,
            path: [],
            projection: { raw_digest: String(index) },
          })),
          cursor: "next",
        },
      );
      throw new Error("expected mismatch");
    } catch (error) {
      expect(error).toMatchObject({
        code: "EXPECTATION_FAILED",
        details: {
          candidates: expect.any(Array),
          truncated: true,
          cursor: "next",
        },
      });
      expect(error.details.candidates.length).toBeLessThan(20);
    }
  });

  it("orders multiple sources deterministically and paginates without gaps", () => {
    const inputs = [
      create_input("a: value-z1\nb: value-z2\n", "/tmp/z.yaml"),
      create_input("a: value-a1\nb: value-a2\n", "/tmp/a.yaml"),
    ];
    const first = run_query_v2(inputs, paged_query({ page: { limit: 2 } }));
    expect(first).toMatchObject({
      match_count: 2,
      total_match_count: 4,
      truncated: true,
      next_cursor: expect.any(String),
    });
    expect(decode_query_cursor(first.next_cursor)).toMatchObject({
      purpose: "page",
      offset: 2,
    });
    expect(first.matches.map((match) => match.raw)).toEqual([
      "value-a1",
      "value-a2",
    ]);

    const second = run_query_v2(
      inputs,
      paged_query({ page: { limit: 2, cursor: first.next_cursor } }),
    );
    expect(second.matches.map((match) => match.raw)).toEqual([
      "value-z1",
      "value-z2",
    ]);
    expect(second.next_cursor).toBeNull();
    expect(
      new Set(
        [...first.matches, ...second.matches].map((match) => match.locator),
      ),
    ).toHaveLength(4);
  });

  it("continues mismatch candidates across multiple candidate cursor pages", () => {
    const text = Array.from(
      { length: 25 },
      (_, index) => `key_${index}: value-${String(index).padStart(2, "0")}`,
    ).join("\n");
    const input = create_input(`${text}\n`, "/tmp/candidates.yaml");
    const initial_query = paged_query({
      expect_matches: 1,
      page: { limit: 5 },
    });

    let mismatch;
    try {
      run_query_v2([input], initial_query);
    } catch (error) {
      mismatch = error;
    }
    expect(mismatch).toMatchObject({
      code: "AMBIGUOUS_MATCH",
      details: {
        candidates: expect.any(Array),
        truncated: true,
        cursor: expect.any(String),
      },
    });
    expect(mismatch.details.candidates).toHaveLength(10);
    expect(decode_query_cursor(mismatch.details.cursor)).toMatchObject({
      purpose: "candidate",
      offset: 10,
    });
    expect(() =>
      run_query_v2(
        [input],
        paged_query({
          page: { limit: 5, cursor: mismatch.details.cursor },
        }),
        { mode: "write_single" },
      ),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_ERROR" }));

    const second = run_query_v2(
      [input],
      paged_query({
        expect_matches: { exact: 999 },
        page: { limit: 5, cursor: mismatch.details.cursor },
      }),
    );
    expect(second.matches.map((match) => match.raw)).toEqual([
      "value-10",
      "value-11",
      "value-12",
      "value-13",
      "value-14",
    ]);
    expect(decode_query_cursor(second.next_cursor)).toMatchObject({
      purpose: "candidate",
      offset: 15,
    });

    const third = run_query_v2(
      [input],
      paged_query({
        expect_matches: 0,
        page: { limit: 5, cursor: second.next_cursor },
      }),
    );
    expect(third.matches.map((match) => match.raw)).toEqual([
      "value-15",
      "value-16",
      "value-17",
      "value-18",
      "value-19",
    ]);
  });

  it("uses digest as a stable tie-breaker for equal normalized paths", () => {
    const first = create_input("a: value-first\n", "/tmp/same.yaml");
    const second = create_input("a: value-second\n", "/tmp/same.yaml");
    const forward = run_query_v2([first, second], paged_query()).matches.map(
      (match) => match.raw,
    );
    const reverse = run_query_v2([second, first], paged_query()).matches.map(
      (match) => match.raw,
    );
    expect(reverse).toEqual(forward);
  });

  it("binds cursors to source and semantic query state", () => {
    const original = create_input(
      "a: value-1\nb: value-2\n",
      "/tmp/bound.yaml",
    );
    const first = run_query_v2([original], paged_query({ page: { limit: 1 } }));
    const changed = create_input(
      "# changed\na: value-1\nb: value-2\n",
      "/tmp/bound.yaml",
    );
    expect(() =>
      run_query_v2(
        [changed],
        paged_query({ page: { limit: 1, cursor: first.next_cursor } }),
      ),
    ).toThrowError(expect.objectContaining({ code: "SOURCE_CHANGED" }));
    expect(() =>
      run_query_v2(
        [original],
        paged_query({
          projection: { fields: ["raw"], missing: "error" },
          page: { limit: 1, cursor: first.next_cursor },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  });

  it("enforces result and output budgets while returning a resumable page", () => {
    const input = create_input(
      `a: value-${"x".repeat(120)}\nb: value-${"y".repeat(120)}\n`,
      "/tmp/budget.yaml",
    );
    const result_limited = run_query_v2(
      [input],
      paged_query({
        limits: { max_result: 1, max_output_bytes: 4096 },
      }),
    );
    expect(result_limited).toMatchObject({
      match_count: 1,
      total_match_count: 2,
      truncated: true,
      next_cursor: expect.any(String),
    });

    expect(() =>
      run_query_v2(
        [input],
        paged_query({
          projection: { fields: ["raw"], missing: "error" },
          limits: { max_result: 2, max_output_bytes: 80 },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_LIMIT_EXCEEDED" }));
  });

  it("rejects an addressable index from another source snapshot", () => {
    const first = create_input("a: value-1\n", "/tmp/one.yaml");
    const second = create_input("a: value-2\n", "/tmp/two.yaml");
    expect(() =>
      run_query_v2(
        [{ index: first.index, addressable_index: second.addressable_index }],
        paged_query(),
      ),
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  });

  it("runs public query v2 evaluation inside the bounded worker", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "yaml-query-v2-"),
    );
    const file_path = path.join(directory, "source.yaml");
    await fs.writeFile(file_path, "a: value-1\nb: value-2\n");
    try {
      const result = await run_isolated_yaml_action("query_v2", {
        file_path,
        query: paged_query({ page: { limit: 1 } }),
      });
      expect(result).toMatchObject({
        match_count: 1,
        total_match_count: 2,
        next_cursor: expect.any(String),
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
