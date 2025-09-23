const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

function hasPathSeparator(candidate) {
  return (
    candidate.includes(path.sep) ||
    candidate.includes("/") ||
    candidate.includes("\\")
  );
}

async function resolveExecutable(candidate) {
  if (!candidate || typeof candidate !== "string") return "";

  if (hasPathSeparator(candidate)) {
    const resolved = path.resolve(candidate);
    try {
      await fs.promises.access(resolved, fs.constants.X_OK);
      return resolved;
    } catch (err) {
      return "";
    }
  }

  try {
    const { stdout } = await execFileAsync("which", [candidate]);
    const resolved = stdout.trim();
    return resolved ? resolved : "";
  } catch (err) {
    return "";
  }
}

async function ensureExecutable(candidate, friendlyName) {
  const resolved = await resolveExecutable(candidate);
  if (!resolved) {
    const label = friendlyName || candidate;
    throw new Error(
      `${label} executable not found. Install it or provide an absolute path via the corresponding option.`,
    );
  }
  return resolved;
}

async function runCommand(command, args, options = {}) {
  const {
    capture = false,
    cwd,
    env,
    stdio = "inherit",
    label = command,
    allowNonZeroExit = false,
    silent = false,
    onStdout,
    onStderr,
    forwardStdout = true,
    forwardStderr = true,
  } = options;

  if (capture) {
    try {
      const result = await execFileAsync(command, args, {
        cwd,
        env,
        maxBuffer: options.maxBuffer || 50 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (err) {
      if (allowNonZeroExit) {
        return {
          stdout: err.stdout || "",
          stderr: err.stderr || "",
          code: err.code ?? 1,
        };
      }
      const error = new Error(
        `${label} failed with exit code ${err.code ?? "unknown"}`,
      );
      error.stdout = err.stdout;
      error.stderr = err.stderr;
      error.code = err.code;
      error.originalError = err;
      throw error;
    }
  }

  const usePipe =
    silent || typeof onStdout === "function" || typeof onStderr === "function";

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: usePipe ? ["ignore", "pipe", "pipe"] : stdio,
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";

    if (usePipe) {
      if (child.stdout) {
        child.stdout.on("data", (chunk) => {
          const data = chunk.toString();
          stdoutBuffer += data;
          if (typeof onStdout === "function") {
            onStdout(data);
          }
          if (!silent && forwardStdout && stdio === "inherit") {
            process.stdout.write(chunk);
          }
        });
      }
      if (child.stderr) {
        child.stderr.on("data", (chunk) => {
          const data = chunk.toString();
          stderrBuffer += data;
          if (typeof onStderr === "function") {
            onStderr(data);
          }
          if (!silent && forwardStderr && stdio === "inherit") {
            process.stderr.write(chunk);
          }
        });
      }
    }

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0 || allowNonZeroExit) {
        resolve({ code, stdout: stdoutBuffer, stderr: stderrBuffer });
      } else {
        const error = new Error(`${label} failed with exit code ${code}`);
        if (stdoutBuffer) error.stdout = stdoutBuffer;
        if (stderrBuffer) error.stderr = stderrBuffer;
        error.code = code;
        reject(error);
      }
    });
  });
}

module.exports = {
  runCommand,
  ensureExecutable,
  resolveExecutable,
};
