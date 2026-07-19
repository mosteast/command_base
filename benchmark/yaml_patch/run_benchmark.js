"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const package_json = require("../../package.json");
const { create_source_record } = require("../../lib/yaml_patch/source");
const { parse_yaml_source } = require("../../lib/yaml_patch/parser");
const { build_node_index } = require("../../lib/yaml_patch/node_index");
const { get_yaml_parser_version } = require("../../lib/yaml_patch/parser");
const { main: generate_fixtures, ROOT } = require("./generate_fixture");

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
}

function sample_parse(file_path, samples) {
  const buffer = fs.readFileSync(file_path);
  const timings = [];
  let nodes = 0;
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const source = create_source_record(buffer, { file_path });
    const parsed = parse_yaml_source(source);
    const index_result = build_node_index(source, parsed);
    const elapsed = performance.now() - started;
    timings.push(elapsed);
    nodes = index_result.entries.length;
  }
  const ordered = [...timings].sort((left, right) => left - right);
  return {
    file_path,
    bytes: buffer.length,
    nodes,
    samples,
    p50_ms: percentile(ordered, 0.5),
    p95_ms: percentile(ordered, 0.95),
    max_ms: ordered[ordered.length - 1],
  };
}

function compare_reference(current, reference_path) {
  if (!fs.existsSync(reference_path)) return { comparable: false };
  const reference = JSON.parse(fs.readFileSync(reference_path, "utf8"));
  if (
    reference.environment?.node !== current.environment.node ||
    reference.environment?.platform !== current.environment.platform
  ) {
    return { comparable: false, reason: "environment_mismatch" };
  }
  const regressions = [];
  for (const [name, metric] of Object.entries(current.metrics)) {
    const previous = reference.metrics?.[name];
    if (!previous) continue;
    if (metric.nodes !== previous.nodes || metric.bytes !== previous.bytes) {
      regressions.push({ name, reason: "incorrect_result_shape" });
      continue;
    }
    if (previous.p95_ms > 0 && metric.p95_ms > previous.p95_ms * 1.2) {
      regressions.push({
        name,
        reason: "p95_regression",
        previous_p95_ms: previous.p95_ms,
        current_p95_ms: metric.p95_ms,
      });
    }
  }
  return { comparable: true, regressions };
}

async function run(options = {}) {
  if (!fs.existsSync(path.join(ROOT, "baseline/01_plain.yaml"))) {
    await generate_fixtures();
  }
  const samples = options.samples || 3;
  const metrics = {
    cold_nodes_64k: sample_parse(
      path.join(ROOT, "scale/nodes_64k.yaml"),
      samples,
    ),
    warm_large_2mib: sample_parse(
      path.join(ROOT, "scale/large_2mib.yaml"),
      samples,
    ),
  };
  const result = {
    tool_version: package_json.version,
    parser_version: get_yaml_parser_version(),
    environment: {
      os: `${os.type()} ${os.release()}`,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpus: os.cpus().length,
      memory_bytes: os.totalmem(),
      storage: "local-filesystem",
    },
    mode: { cold: true, warm: true, samples },
    metrics,
    generated_at: new Date().toISOString(),
  };
  const output =
    options.output || path.join(__dirname, "reference_result.json");
  const comparison = compare_reference(result, output);
  result.comparison = comparison;
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  if (comparison.comparable && comparison.regressions.length > 0) {
    console.error(JSON.stringify(comparison.regressions, null, 2));
    process.exitCode = 1;
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const output_index = args.indexOf("--output");
  run({
    output: output_index >= 0 ? args[output_index + 1] : undefined,
    samples: 3,
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { run };
