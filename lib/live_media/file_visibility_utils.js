const path = require("path");

const { runCommand, resolveExecutable } = require("./process_utils");

let hidden_flag_command_promise = null;

async function resolve_hidden_flag_command() {
  if (process.platform !== "darwin") return "";

  if (!hidden_flag_command_promise) {
    hidden_flag_command_promise = resolveExecutable("chflags").catch(() => "");
  }

  return await hidden_flag_command_promise;
}

async function clear_hidden_flag_if_needed(target_path, options = {}) {
  if (!target_path || process.platform !== "darwin") return false;

  const { logger = console, debug = false } = options;
  const resolved_path = path.resolve(target_path);
  const hidden_flag_command = await resolve_hidden_flag_command();
  if (!hidden_flag_command) return false;

  try {
    await runCommand(hidden_flag_command, ["nohidden", resolved_path], {
      label: "chflags (clear hidden flag)",
      silent: true,
      logger,
      debug,
    });
    return true;
  } catch (error) {
    if (debug && logger && typeof logger.debug === "function") {
      logger.debug(
        `Unable to clear hidden flag for ${resolved_path}: ${error.message}`,
      );
    }
    return false;
  }
}

module.exports = {
  clear_hidden_flag_if_needed,
};
