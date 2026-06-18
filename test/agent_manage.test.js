import { execFile } from "node:child_process";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cli_entry = path.resolve(__dirname, "../bin/agent_manage");

function run_cli(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli_entry, ...args],
      {
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          ...env,
        },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const exec_error = new Error(stderr || error.message);
          exec_error.stdout = stdout;
          exec_error.stderr = stderr;
          exec_error.exit_code = error.code ?? 1;
          reject(exec_error);
          return;
        }

        resolve({ stdout, stderr, exit_code: 0 });
      },
    );
  });
}

async function create_agent_fixture() {
  const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-manage-"));
  const profile_base = path.join(temp_root, "profile");
  const codex_profile_root = path.join(profile_base, "codex");
  const codex_target_dir = path.join(temp_root, "target", "codex");
  const current_profile_name = "work";
  const backup_profile_name = "backup";
  const secret_auth_token = "secret-auth-token";
  const secret_config_key = "secret-config-key";

  await fs.ensureDir(path.join(codex_profile_root, current_profile_name));
  await fs.ensureDir(path.join(codex_profile_root, backup_profile_name));
  await fs.ensureDir(codex_target_dir);

  await fs.writeFile(
    path.join(codex_profile_root, ".current_profile"),
    `${current_profile_name}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(codex_profile_root, current_profile_name, "auth.json"),
    JSON.stringify({ token: secret_auth_token }, null, 2),
    "utf8",
  );
  await fs.writeFile(
    path.join(codex_profile_root, current_profile_name, "config.toml"),
    `api_key = "${secret_config_key}"\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(codex_profile_root, backup_profile_name, "auth.json"),
    JSON.stringify({ token: "backup-secret-token" }, null, 2),
    "utf8",
  );
  await fs.writeFile(
    path.join(codex_profile_root, backup_profile_name, "config.toml"),
    `api_key = "backup-secret-key"\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(codex_target_dir, "auth.json"),
    JSON.stringify({ token: "live-secret-auth-token" }, null, 2),
    "utf8",
  );

  return {
    codex_target_dir,
    current_profile_name,
    profile_base,
    secret_auth_token,
    secret_config_key,
    temp_root,
  };
}

describe("agent_manage info", () => {
  it("shows all configured agent info when no agent is passed", async () => {
    const fixture = await create_agent_fixture();

    try {
      const result = await run_cli(["info"], {
        env: {
          AGENT_MANAGE_CODEX_TARGET: fixture.codex_target_dir,
          AGENT_MANAGE_PROFILE_BASE: fixture.profile_base,
        },
      });

      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain("codex:");
      expect(result.stdout).toContain(`current profile: ${fixture.current_profile_name}`);
      expect(result.stdout).toContain("available profiles: work, backup");
      expect(result.stdout).toContain("target status: present");
      expect(result.stdout).toContain("auth.json: present");
      expect(result.stdout).toContain("config.toml: missing");
      expect(result.stdout).not.toContain(fixture.secret_auth_token);
      expect(result.stdout).not.toContain(fixture.secret_config_key);
      expect(result.stdout).not.toContain("live-secret-auth-token");
    } finally {
      await fs.remove(fixture.temp_root);
    }
  });

  it("shows per-file live status for a requested agent", async () => {
    const fixture = await create_agent_fixture();

    try {
      const result = await run_cli(["info", "codex"], {
        env: {
          AGENT_MANAGE_CODEX_TARGET: fixture.codex_target_dir,
          AGENT_MANAGE_PROFILE_BASE: fixture.profile_base,
        },
      });

      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain("codex:");
      expect(result.stdout).not.toContain("codex agent info:");
      expect(result.stdout).toContain(`target dir: ${fixture.codex_target_dir}`);
      expect(result.stdout).toContain("available profiles: work, backup");
      expect(result.stdout).toContain("auth.json: present");
      expect(result.stdout).toContain("config.toml: missing");
      expect(result.stdout).not.toContain(fixture.secret_auth_token);
      expect(result.stdout).not.toContain(fixture.secret_config_key);
    } finally {
      await fs.remove(fixture.temp_root);
    }
  });
});
