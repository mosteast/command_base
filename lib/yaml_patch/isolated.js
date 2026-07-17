"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");

const { Yaml_patch_error } = require("./error");

const DEFAULT_WORKER_TIMEOUT_MS = 10_000;
const DEFAULT_WORKER_MEMORY_MB = 256;

function error_from_worker(error_data) {
  return new Yaml_patch_error(
    error_data.code || "VALIDATION_FAILED",
    error_data.message || "Isolated YAML action failed",
    {
      recoverable: Boolean(error_data.recoverable),
      next_action: error_data.next_action,
      details: error_data.details || {},
    },
  );
}

function run_isolated_yaml_action(action, payload, options = {}) {
  const timeout_ms =
    options.timeout_ms === undefined
      ? DEFAULT_WORKER_TIMEOUT_MS
      : Number(options.timeout_ms);
  const memory_mb =
    options.memory_mb === undefined
      ? DEFAULT_WORKER_MEMORY_MB
      : Number(options.memory_mb);
  if (!Number.isInteger(timeout_ms) || timeout_ms <= 0) {
    return Promise.reject(
      new Yaml_patch_error(
        "VALIDATION_FAILED",
        "Worker timeout must be a positive integer",
      ),
    );
  }
  if (!Number.isInteger(memory_mb) || memory_mb < 32) {
    return Promise.reject(
      new Yaml_patch_error(
        "VALIDATION_FAILED",
        "Worker memory limit must be an integer of at least 32 MB",
      ),
    );
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "isolated_worker.js"), {
      workerData: { action, payload },
      resourceLimits: {
        maxOldGenerationSizeMb: memory_mb,
        maxYoungGenerationSizeMb: Math.max(16, Math.floor(memory_mb / 8)),
        stackSizeMb: 8,
      },
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(
        reject,
        new Yaml_patch_error(
          "VALIDATION_FAILED",
          `Isolated YAML action exceeded ${timeout_ms} ms`,
          {
            recoverable: true,
            next_action:
              "increase the parser timeout after reviewing the input",
            details: { action, timeout_ms },
          },
        ),
      );
    }, timeout_ms);

    worker.once("message", (message) => {
      if (message && message.ok) finish(resolve, message.result);
      else finish(reject, error_from_worker((message && message.error) || {}));
    });
    worker.once("error", (error) => {
      finish(
        reject,
        new Yaml_patch_error(
          "VALIDATION_FAILED",
          `Isolated YAML worker failed: ${error.message}`,
          { cause: error, details: { action } },
        ),
      );
    });
    worker.once("exit", (exit_code) => {
      if (!settled && exit_code !== 0) {
        finish(
          reject,
          new Yaml_patch_error(
            "VALIDATION_FAILED",
            `Isolated YAML worker exited with code ${exit_code}`,
            { details: { action, exit_code } },
          ),
        );
      }
    });
  });
}

module.exports = {
  DEFAULT_WORKER_MEMORY_MB,
  DEFAULT_WORKER_TIMEOUT_MS,
  error_from_worker,
  run_isolated_yaml_action,
};
