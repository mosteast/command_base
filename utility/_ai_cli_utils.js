"use strict";

const fs = require("fs/promises");
const { existsSync } = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { spawn } = require("child_process");

const project_require = (() => {
  try {
    return createRequire(path.join(process.cwd(), "package.json"));
  } catch (error) {
    return null;
  }
})();

function load_dependency(name) {
  if (project_require) {
    try {
      return project_require(name);
    } catch (error) {
      // fall back to default resolution
    }
  }
  try {
    return require(name);
  } catch (error) {
    throw new Error(`Failed to load dependency \"${name}\": ${error.message}`);
  }
}

const { globSync } = load_dependency("glob");
const YAML = load_dependency("yaml");

const {
  default_ai_platform: adapter_default_ai_platform,
  list_ai_platforms,
  get_ai_adapter,
} = require("./ai_adapter");

async function fetch_fn(...args) {
  if (typeof fetch !== "function") {
    throw new Error(
      "Global fetch is unavailable. Please run on Node.js 18+ or provide a fetch polyfill.",
    );
  }
  return fetch(...args);
}

const default_ai_platform = adapter_default_ai_platform;
const supported_ai_platforms = list_ai_platforms();

async function ensure_prompt_build(prompt_name, options) {
  const resolved_options = options || {};
  const candidate_roots = new Set();
  if (resolved_options.prompt_root) {
    candidate_roots.add(path.resolve(resolved_options.prompt_root));
  }
  if (resolved_options.repo_root) {
    candidate_roots.add(path.resolve(resolved_options.repo_root));
  }
  if (process.env.AI_PROMPT_ROOT) {
    candidate_roots.add(path.resolve(process.env.AI_PROMPT_ROOT));
  }
  candidate_roots.add(process.cwd());

  let prompt_file_path = null;
  for (const root_dir of candidate_roots) {
    const candidate = path.join(root_dir, "prompt", `${prompt_name}.prompt.md`);
    try {
      await fs.access(candidate);
      prompt_file_path = candidate;
      break;
    } catch (error) {
      // continue searching
    }
  }

  if (!prompt_file_path) {
    const searched = Array.from(candidate_roots).map((root) =>
      path.join(root, "prompt", `${prompt_name}.prompt.md`),
    );
    throw new Error(
      `Prompt template not found for \"${prompt_name}\". Checked:\n- ${searched.join(
        "\n- ",
      )}`,
    );
  }

  if (resolved_options.rebuild && resolved_options.logger) {
    resolved_options.logger.info?.(
      `Using prompt template at ${prompt_file_path}`,
    );
  }

  return prompt_file_path;
}

async function ensure_prompt_source(prompt_name, options) {
  const resolved_options = options || {};
  if (resolved_options.external_path) {
    const candidate_path = path.resolve(resolved_options.external_path);
    try {
      await fs.access(candidate_path);
      resolved_options.logger?.info?.(
        `Using external prompt template at ${candidate_path}`,
      );
      return candidate_path;
    } catch (error) {
      throw new Error(
        `Failed to access external prompt for "${prompt_name}" at "${candidate_path}": ${error.message}`,
      );
    }
  }
  return ensure_prompt_build(prompt_name, resolved_options);
}

function expand_patterns(patterns, options) {
  const resolved_options = options || {};
  const cwd = resolved_options.cwd || process.cwd();
  const normalized_patterns = (patterns || [])
    .flat()
    .filter((entry) => typeof entry === "string" && entry.trim().length > 0);

  const unique_paths = new Set();
  const matched_files = [];

  for (const pattern of normalized_patterns) {
    const glob_matches = globSync(pattern, {
      cwd,
      nodir: true,
      dot: true,
      absolute: true,
      windowsPathsNoEscape: true,
    });

    if (glob_matches.length === 0) {
      const candidate_path = path.isAbsolute(pattern)
        ? pattern
        : path.join(cwd, pattern);
      if (existsSync(candidate_path)) {
        const absolute_candidate = path.resolve(candidate_path);
        if (!unique_paths.has(absolute_candidate)) {
          unique_paths.add(absolute_candidate);
          matched_files.push(absolute_candidate);
        }
      }
      continue;
    }

    for (const match_path of glob_matches) {
      const absolute_match = path.resolve(match_path);
      if (!unique_paths.has(absolute_match)) {
        unique_paths.add(absolute_match);
        matched_files.push(absolute_match);
      }
    }
  }

  return matched_files;
}

async function file_has_content(file_path) {
  try {
    const file_stats = await fs.stat(file_path);
    if (!file_stats.isFile()) {
      return false;
    }
    if (file_stats.size === 0) {
      return false;
    }
    const file_content = await fs.readFile(file_path, "utf8");
    return file_content.trim().length > 0;
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

async function run_ai_command(options) {
  const {
    prompt_file,
    input_file,
    output_file,
    repo_root,
    platform,
    model,
    temperature,
    max_tokens,
    extra_context,
    postprocess_output,
    logger,
  } = options;

  if (!prompt_file) {
    throw new Error("run_ai_command requires a prompt_file path");
  }
  if (!input_file) {
    throw new Error("run_ai_command requires an input_file path");
  }
  if (!output_file) {
    throw new Error("run_ai_command requires an output_file path");
  }

  const resolved_repo_root = repo_root || process.cwd();
  const resolved_logger = logger || console;
  const selected_platform = (platform || default_ai_platform).toLowerCase();

  if (!supported_ai_platforms.includes(selected_platform)) {
    throw new Error(
      `Unsupported ai platform \"${selected_platform}\". Supported platforms: ${supported_ai_platforms.join(", ")}`,
    );
  }

  const prompt_definition = await parse_prompt_file(prompt_file);
  const input_content = await fs.readFile(input_file, "utf8");
  const template_context = build_template_context({
    input_file,
    repo_root: resolved_repo_root,
    input_content,
    model,
    extra_context,
  });
  const rendered_user_prompt = render_template(
    prompt_definition.template,
    template_context,
  );

  const template_contains_input_placeholder = /\{\{\s*input\s*\}\}/.test(
    prompt_definition.template,
  );
  const normalized_input_content = input_content.trim().length
    ? input_content
    : "";
  const final_user_prompt = template_contains_input_placeholder
    ? rendered_user_prompt
    : build_fallback_user_prompt(
        rendered_user_prompt,
        normalized_input_content,
        template_context,
      );

  const platform_overrides = prompt_definition.metadata.platforms || {};
  const platform_override = platform_overrides[selected_platform] || {};

  const resolved_temperature = pick_number(
    temperature,
    platform_override.temperature,
    prompt_definition.metadata.temperature,
  );
  const resolved_max_tokens = pick_number(
    max_tokens,
    platform_override.max_tokens,
    prompt_definition.metadata.max_tokens,
  );

  const adapter_request = {
    platform: selected_platform,
    model,
    system_prompt: prompt_definition.metadata.system,
    user_prompt: final_user_prompt,
    temperature: resolved_temperature,
    max_tokens: resolved_max_tokens,
    logger: resolved_logger,
  };

  const ai_result = await execute_with_adapter(
    selected_platform,
    adapter_request,
  );

  if (!ai_result || ai_result.trim().length === 0) {
    throw new Error("AI response was empty");
  }

  let final_output = ai_result.trim();
  if (typeof postprocess_output === "function") {
    final_output = postprocess_output(final_output, {
      prompt_file,
      input_file,
      output_file,
      platform: selected_platform,
      model,
    });
  }

  if (!final_output || String(final_output).trim().length === 0) {
    throw new Error("AI response was empty after postprocessing");
  }

  await fs.mkdir(path.dirname(output_file), { recursive: true });
  await fs.writeFile(output_file, `${String(final_output).trim()}\n`, "utf8");

  return { output: String(final_output).trim() };
}

function unwrap_single_markdown_fence(text) {
  if (typeof text !== "string") {
    return text;
  }

  const trimmed_text = text.trim();
  if (!trimmed_text.startsWith("```")) {
    return trimmed_text;
  }

  const normalized_text = trimmed_text.replace(/\r\n/g, "\n");
  const lines = normalized_text.split("\n");
  if (lines.length < 2) {
    return trimmed_text;
  }

  const opening_fence = lines[0].trim();
  const closing_fence = lines[lines.length - 1].trim();

  if (closing_fence !== "```") {
    return trimmed_text;
  }

  if (!/^```(?:markdown|md)?$/u.test(opening_fence)) {
    return trimmed_text;
  }

  for (let index = 1; index < lines.length - 1; index += 1) {
    if (lines[index].trim().startsWith("```")) {
      return trimmed_text;
    }
  }

  return lines.slice(1, -1).join("\n").trim();
}

function build_fallback_user_prompt(user_prompt, input_content, context) {
  const safe_user_prompt =
    typeof user_prompt === "string" ? user_prompt.trimEnd() : "";
  const input_section = build_input_section(input_content, context);
  if (!input_section) {
    return safe_user_prompt;
  }
  return `${safe_user_prompt}\n\n${input_section}`;
}

function build_input_section(raw_input_content, context) {
  if (typeof raw_input_content !== "string") {
    return "";
  }
  const has_meaningful_content = raw_input_content.trim().length > 0;
  if (!has_meaningful_content) {
    return "";
  }

  const normalized_input = raw_input_content.replace(/\r\n/g, "\n");
  const input_without_trailing_newlines = normalized_input.replace(/\s+$/u, "");
  const content_block = input_without_trailing_newlines.length
    ? input_without_trailing_newlines
    : normalized_input.trim();

  const section_lines = ["## 给定的内容", ""];

  const relative_path = context?.relative_path;
  const file_name = context?.file_name;
  if (relative_path || file_name) {
    section_lines.push("### 文件信息");
    if (file_name) {
      section_lines.push(`- 名称：${file_name}`);
    }
    if (relative_path) {
      section_lines.push(`- 相对路径：${relative_path}`);
    }
    section_lines.push("");
  }

  section_lines.push("```markdown");
  section_lines.push(content_block);
  section_lines.push("```");

  return section_lines.join("\n");
}

async function parse_prompt_file(prompt_file_path) {
  const raw_content = await fs.readFile(prompt_file_path, "utf8");
  const normalized_content = raw_content.replace(/\r\n/g, "\n");

  const front_matter_match = normalized_content.match(
    /^---\n(?<meta>[\s\S]*?)\n---\n(?<body>[\s\S]*)$/,
  );

  if (!front_matter_match) {
    return {
      metadata: {},
      template: normalized_content,
    };
  }

  const metadata_section = front_matter_match.groups.meta.trim();
  const template_body = front_matter_match.groups.body.replace(/^\n+/, "");

  let metadata = {};
  if (metadata_section.length > 0) {
    try {
      metadata = YAML.parse(metadata_section) || {};
    } catch (error) {
      throw new Error(
        `Failed to parse YAML front matter in ${prompt_file_path}: ${error.message}`,
      );
    }
  }

  return {
    metadata,
    template: template_body,
  };
}

function build_template_context(details) {
  const repo_root = details.repo_root;
  const input_path = details.input_file;
  const relative_input_path = path.relative(repo_root, input_path);

  return {
    input: details.input_content,
    file_name: path.basename(input_path),
    file_path: input_path,
    relative_path: relative_input_path,
    model: details.model || "",
    timestamp_iso: new Date().toISOString(),
    ...(details.extra_context || {}),
  };
}

function render_template(template, context) {
  const safe_context = context || {};
  return template.replace(/\{\{\s*([a-zA-Z0-9_\.]+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(safe_context, key)) {
      return `${safe_context[key]}`;
    }
    return "";
  });
}

function pick_number(...candidates) {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") {
      continue;
    }
    const numeric_value = Number(candidate);
    if (!Number.isNaN(numeric_value)) {
      return numeric_value;
    }
  }
  return undefined;
}

let cached_adapter_support = null;

function get_adapter_support() {
  if (!cached_adapter_support) {
    cached_adapter_support = Object.freeze({
      fetch: fetch_fn,
      run_cli_command,
      command_exists,
      parse_cli_arg_string,
      combine_prompts,
      trim_trailing_slash,
      build_messages,
      handle_openai_like_response,
      safe_read_json,
      pick_number,
    });
  }
  return cached_adapter_support;
}

async function execute_with_adapter(platform, request, visited_stack) {
  const normalized_platform = (platform || "").toLowerCase();
  if (!normalized_platform) {
    throw new Error("Adapter platform name is required");
  }

  const visited = Array.isArray(visited_stack) ? visited_stack : [];
  if (visited.includes(normalized_platform)) {
    const loop = [...visited, normalized_platform].join(" -> ");
    throw new Error(`Detected circular adapter fallback chain: ${loop}`);
  }

  const support = get_adapter_support();
  const adapter = get_ai_adapter(normalized_platform, support);
  if (!adapter) {
    throw new Error(
      `Unsupported ai platform \"${normalized_platform}\". Supported: ${supported_ai_platforms.join(", ")}`,
    );
  }

  const runtime_context = {
    invoke_adapter: async (next_platform, next_request = request) =>
      execute_with_adapter(next_platform, next_request, [
        ...visited,
        normalized_platform,
      ]),
  };

  const execution_context = { ...support, ...runtime_context };
  return adapter.invoke(request, execution_context);
}

async function run_cli_command(command, args, prompt_text, options) {
  const resolved_options = options || {};
  const command_args = Array.isArray(args) ? args : [];

  const spawn_options = {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  };

  if (
    resolved_options.system_prompt &&
    resolved_options.system_prompt.length > 0
  ) {
    spawn_options.env = {
      ...process.env,
      AI_SYSTEM_PROMPT: resolved_options.system_prompt,
    };
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, command_args, spawn_options);
    let stdout_buffer = "";
    let stderr_buffer = "";

    child.stdout.on("data", (chunk) => {
      stdout_buffer += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr_buffer += chunk.toString();
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout_buffer.trim());
      } else {
        const error_message =
          stderr_buffer.trim() || `CLI exited with code ${code}`;
        reject(new Error(error_message));
      }
    });

    child.stdin.write(prompt_text);
    child.stdin.end();
  });
}

function parse_cli_arg_string(raw_value) {
  if (!raw_value || raw_value.trim().length === 0) {
    return [];
  }
  const tokens = raw_value.match(/(?:[^\s\"']+|\"[^\"]*\"|'[^']*')+/g) || [];
  return tokens.map((token) => {
    const trimmed = token.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  });
}

async function command_exists(command) {
  return new Promise((resolve) => {
    const checker = spawn("which", [command]);
    checker.on("close", (code) => {
      resolve(code === 0);
    });
    checker.on("error", () => {
      resolve(false);
    });
  });
}

function trim_trailing_slash(url) {
  return url.replace(/\/$/, "");
}

function build_messages(system_prompt, user_prompt) {
  const messages = [];
  if (system_prompt && system_prompt.trim().length > 0) {
    messages.push({ role: "system", content: system_prompt });
  }
  messages.push({ role: "user", content: user_prompt });
  return messages;
}

function combine_prompts(system_prompt, user_prompt) {
  if (system_prompt && system_prompt.trim().length > 0) {
    return `${system_prompt.trim()}\n\n${user_prompt}`;
  }
  return user_prompt;
}

async function handle_openai_like_response(response) {
  if (!response.ok) {
    const error_payload = await safe_read_json(response);
    throw new Error(
      `API error ${response.status}: ${JSON.stringify(error_payload)}`,
    );
  }
  const data = await response.json();
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const parts = choices
    .map((choice) => {
      const message = choice.message || {};
      if (typeof message.content === "string") {
        return message.content;
      }
      if (Array.isArray(message.content)) {
        return message.content
          .map((segment) =>
            segment && typeof segment.text === "string" ? segment.text : "",
          )
          .join("");
      }
      return "";
    })
    .filter((segment) => segment.length > 0);
  if (parts.length === 0) {
    throw new Error("API returned an empty response");
  }
  return parts.join("\n").trim();
}

async function safe_read_json(response) {
  try {
    return await response.json();
  } catch (error) {
    return {
      error: {
        message: `Failed to parse error payload: ${error.message}`,
      },
    };
  }
}

module.exports = {
  default_ai_platform,
  supported_ai_platforms,
  ensure_prompt_build,
  ensure_prompt_source,
  expand_patterns,
  file_has_content,
  run_ai_command,
  build_fallback_user_prompt,
  build_input_section,
  unwrap_single_markdown_fence,
  // compatibility aliases
  DEFAULT_AI_PLATFORM: default_ai_platform,
  SUPPORTED_AI_PLATFORMS: supported_ai_platforms,
};
