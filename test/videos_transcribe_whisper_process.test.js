import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const child_process = require("child_process");
const module_path = require.resolve("../bin/videos_transcribe_whisper");
const original_spawn = child_process.spawn;

function load_module_with_spawn(fake_spawn) {
  delete require.cache[module_path];
  child_process.spawn = fake_spawn;
  const loaded_module = require(module_path);
  child_process.spawn = original_spawn;
  return loaded_module;
}

afterEach(() => {
  child_process.spawn = original_spawn;
  delete require.cache[module_path];
});

describe("videos_transcribe_whisper child process lifecycle", () => {
  it("waits for close before resolving spawned helpers", async () => {
    let fake_child = null;
    const videos_transcribe_whisper = load_module_with_spawn(() => {
      fake_child = new EventEmitter();
      return fake_child;
    });

    expect(typeof videos_transcribe_whisper.spawn_command).toBe("function");

    let is_resolved = false;
    const pending = videos_transcribe_whisper
      .spawn_command(process.execPath, ["fake-helper"])
      .then(() => {
        is_resolved = true;
      });

    fake_child.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    expect(is_resolved).toBe(false);

    fake_child.emit("close", 0, null);
    await pending;
    expect(is_resolved).toBe(true);
  });
});
