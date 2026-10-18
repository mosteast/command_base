"use strict";

const fs = require("fs");
const path = require("path");

const YAML = require("yaml");

const TIER_TOKENS = new Set([
  "minimal",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function default_ai_commit_config_path() {
  return path.join(__dirname, "..", "config", "ai_commit", "models.yaml");
}

function load_ai_commit_attempts(
  config_path = default_ai_commit_config_path(),
) {
  const text = fs.readFileSync(config_path, "utf8");
  const parsed = YAML.parse(text);
  if (!parsed || parsed.version !== 1) {
    throw new Error(`Unsupported AI commit model config: ${config_path}`);
  }
  if (!Array.isArray(parsed.attempt) || parsed.attempt.length === 0) {
    throw new Error(`AI commit model config has no attempts: ${config_path}`);
  }

  return parsed.attempt.map((attempt) => {
    if (!attempt?.id || !attempt.label || !attempt.platform || !attempt.model) {
      throw new Error(`Incomplete AI commit attempt in ${config_path}`);
    }
    const loaded = {
      id: String(attempt.id),
      label: String(attempt.label),
      platform: String(attempt.platform),
      model: String(attempt.model),
    };
    if (attempt.reasoning) {
      loaded.reasoning = String(attempt.reasoning);
    }
    return loaded;
  });
}

function resolve_ai_commit_attempts(options) {
  const resolved = options || {};
  if (resolved.attempts) {
    return {
      attempts: resolved.attempts,
      config_path: resolved.config_path || "",
    };
  }

  const config_path = resolved.config_path || default_ai_commit_config_path();
  resolved.logger?.debug?.(`Reading AI commit model config: ${config_path}.`);
  return {
    attempts: load_ai_commit_attempts(config_path),
    config_path,
  };
}

function update_attempt_model(config_path, attempt_id, model) {
  const text = fs.readFileSync(config_path, "utf8");
  const document = YAML.parseDocument(text);
  const attempts = document.get("attempt");
  if (!attempts || !Array.isArray(attempts.items)) {
    throw new Error(`AI commit model config has no attempts: ${config_path}`);
  }

  const target = attempts.items.find((item) => item.get("id") === attempt_id);
  if (!target) {
    throw new Error(`AI commit attempt not found: ${attempt_id}`);
  }

  target.set("model", model);
  const temporary_path = `${config_path}.${process.pid}.tmp`;
  fs.writeFileSync(temporary_path, document.toString());
  fs.renameSync(temporary_path, config_path);
}

function shorten_provider_error(error_message) {
  const text = String(error_message || "");
  const marker = "Available models:";
  const index = text.indexOf(marker);
  if (index === -1) {
    return text;
  }
  return text.slice(0, index).trim();
}

function parse_unavailable_model_error(error_message) {
  const match = String(error_message || "").match(
    /Cannot use this model:\s*(\S+?)\.\s*Available models:\s*([\s\S]+)/i,
  );
  if (!match) {
    return null;
  }

  const available_models = match[2]
    .replace(/\s+/g, " ")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^[A-Za-z0-9._:-]+$/.test(item));
  if (available_models.length === 0) {
    return null;
  }

  return {
    rejected_model: match[1],
    available_models,
  };
}

function parse_model_name(model) {
  const normalized = String(model).replace(/^cursor-/, "");
  const tokens = normalized.split("-").filter(Boolean);
  const family_tokens = [];
  const version_parts = [];
  const rest = [];
  let tier = "";
  let fast = false;
  let thinking = false;
  let seen_version = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "fast") {
      fast = true;
      continue;
    }
    if (token === "thinking") {
      thinking = true;
      continue;
    }
    if (token === "extra" && tokens[index + 1] === "high") {
      tier = "extra-high";
      index += 1;
      continue;
    }
    if (TIER_TOKENS.has(token)) {
      tier = token;
      continue;
    }
    if (/^\d+(?:\.\d+)*$/.test(token)) {
      seen_version = true;
      for (const part of token.split(".")) {
        version_parts.push(Number(part));
      }
      continue;
    }
    if (!seen_version && family_tokens.length < 2) {
      family_tokens.push(token);
      continue;
    }
    rest.push(token);
  }

  return {
    family: family_tokens.join("-"),
    version_parts,
    tier,
    fast,
    thinking,
    rest: rest.join("-"),
  };
}

function compare_version(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const left_part = left[index] || 0;
    const right_part = right[index] || 0;
    if (left_part !== right_part) {
      return left_part - right_part;
    }
  }
  return 0;
}

function prefix_alias(current_model, available_models) {
  const available = new Set(available_models);
  if (current_model.startsWith("cursor-")) {
    const unprefixed = current_model.slice("cursor-".length);
    return available.has(unprefixed) ? unprefixed : null;
  }
  const prefixed = `cursor-${current_model}`;
  return available.has(prefixed) ? prefixed : null;
}

function select_replacement_model(current_model, available_models) {
  if (
    !current_model ||
    !Array.isArray(available_models) ||
    available_models.length === 0 ||
    available_models.includes(current_model)
  ) {
    return null;
  }

  const alias = prefix_alias(current_model, available_models);
  if (alias) {
    return alias;
  }

  const current = parse_model_name(current_model);
  if (!current.family) {
    return null;
  }

  let candidates = available_models.filter((model) => {
    const parsed = parse_model_name(model);
    return parsed.family === current.family && parsed.rest === current.rest;
  });
  if (candidates.length === 0) {
    return null;
  }

  if (current.tier) {
    const tier_matches = candidates.filter(
      (model) => parse_model_name(model).tier === current.tier,
    );
    if (tier_matches.length === 0) {
      return null;
    }
    candidates = tier_matches;
  }

  const fast_matches = candidates.filter(
    (model) => parse_model_name(model).fast === current.fast,
  );
  if (fast_matches.length > 0) {
    candidates = fast_matches;
  }

  const thinking_matches = candidates.filter(
    (model) => parse_model_name(model).thinking === current.thinking,
  );
  if (thinking_matches.length > 0) {
    candidates = thinking_matches;
  }

  candidates.sort((left, right) => {
    const version_diff = compare_version(
      parse_model_name(right).version_parts,
      parse_model_name(left).version_parts,
    );
    if (version_diff !== 0) {
      return version_diff;
    }
    const left_cursor = left.startsWith("cursor-") ? 1 : 0;
    const right_cursor = right.startsWith("cursor-") ? 1 : 0;
    if (left_cursor !== right_cursor) {
      return left_cursor - right_cursor;
    }
    return left.length - right.length;
  });

  return candidates[0] || null;
}

async function invoke_ai_attempt(attempt, invoke, options) {
  const resolved = options || {};
  const logger = resolved.logger || {};

  try {
    const output = await invoke(attempt);
    return { output, attempt };
  } catch (error) {
    const error_message =
      error instanceof Error ? error.message : String(error);
    const parsed = parse_unavailable_model_error(error_message);
    const replacement = parsed
      ? select_replacement_model(attempt.model, parsed.available_models)
      : null;
    if (!replacement) {
      throw new Error(shorten_provider_error(error_message));
    }

    let output;
    try {
      output = await invoke({ ...attempt, model: replacement });
    } catch (retry_error) {
      const retry_message =
        retry_error instanceof Error
          ? retry_error.message
          : String(retry_error);
      throw new Error(shorten_provider_error(retry_message));
    }

    const config_path = resolved.config_path;
    if (config_path && attempt.id) {
      try {
        logger.debug?.(
          `Writing updated model for ${attempt.id} to ${config_path}.`,
        );
        update_attempt_model(config_path, attempt.id, replacement);
        logger.warn?.(
          `${attempt.label} model ${attempt.model} expired. Updated ${config_path} to ${replacement}.`,
        );
      } catch (write_error) {
        const write_message =
          write_error instanceof Error
            ? write_error.message
            : String(write_error);
        logger.warn?.(
          `${attempt.label} model ${attempt.model} expired. Using ${replacement} for this run. Could not update ${config_path}: ${write_message}`,
        );
      }
    } else {
      logger.warn?.(
        `${attempt.label} model ${attempt.model} expired. Using ${replacement} for this run.`,
      );
    }

    return {
      output,
      attempt: { ...attempt, model: replacement },
    };
  }
}

module.exports = {
  default_ai_commit_config_path,
  invoke_ai_attempt,
  load_ai_commit_attempts,
  parse_unavailable_model_error,
  resolve_ai_commit_attempts,
  select_replacement_model,
  shorten_provider_error,
  update_attempt_model,
};
