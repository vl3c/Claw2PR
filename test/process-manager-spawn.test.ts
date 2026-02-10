import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { spawnTask, cancelTask, loadEnvFile } from "../src/process-manager.js";
import { TaskStore } from "../src/task-store.js";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "claw2pr-spawn-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── loadEnvFile tests ─────────────────────────────────────

test("loadEnvFile parses KEY=value pairs", () => {
  withTempDir((dir) => {
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "FOO=bar\nBAZ=qux\n");
    const vars = loadEnvFile(envFile);
    assert.equal(vars.FOO, "bar");
    assert.equal(vars.BAZ, "qux");
  });
});

test("loadEnvFile strips surrounding double quotes", () => {
  withTempDir((dir) => {
    const envFile = join(dir, ".env");
    writeFileSync(envFile, 'API_KEY="my-secret-key"\n');
    const vars = loadEnvFile(envFile);
    assert.equal(vars.API_KEY, "my-secret-key");
  });
});

test("loadEnvFile strips surrounding single quotes", () => {
  withTempDir((dir) => {
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "TOKEN='abc123'\n");
    const vars = loadEnvFile(envFile);
    assert.equal(vars.TOKEN, "abc123");
  });
});

test("loadEnvFile skips comments and empty lines", () => {
  withTempDir((dir) => {
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "# comment\n\nKEY=val\n  # another comment\n");
    const vars = loadEnvFile(envFile);
    assert.equal(Object.keys(vars).length, 1);
    assert.equal(vars.KEY, "val");
  });
});

test("loadEnvFile handles value with equals sign", () => {
  withTempDir((dir) => {
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "URL=https://example.com?a=1&b=2\n");
    const vars = loadEnvFile(envFile);
    assert.equal(vars.URL, "https://example.com?a=1&b=2");
  });
});

test("loadEnvFile returns empty object for missing file", () => {
  const vars = loadEnvFile("/nonexistent/path/.env");
  assert.deepEqual(vars, {});
});

test("loadEnvFile does not strip mismatched quotes", () => {
  withTempDir((dir) => {
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "VAL=\"mixed'\n");
    const vars = loadEnvFile(envFile);
    assert.equal(vars.VAL, "\"mixed'");
  });
});

// ─── spawnTask tests ─────────────────────────────────────

test("spawnTask spawns a process and saves task record", () => {
  withTempDir((dir) => {
    const store = new TaskStore(dir);

    // Create a simple script that sleeps briefly
    const scriptPath = join(dir, "test-script.sh");
    writeFileSync(scriptPath, "#!/bin/bash\nsleep 0.1\n", { mode: 0o755 });

    const record = spawnTask(store, {
      taskId: "test-spawn-1",
      repo: "https://github.com/test/repo",
      task: "test task",
      taskName: "test-task",
      branch: "main",
      budget: 5,
      scriptPath,
      gritguardPath: "/nonexistent",
      selfassemblerVenv: "/nonexistent",
      templatePath: "/nonexistent",
      workspaceDir: dir,
      ghToken: "ghp_test",
      gitUserName: "Test",
      gitUserEmail: "test@test.com",
      hookToken: "",
      pluginDir: dir,
    });

    assert.equal(record.taskId, "test-spawn-1");
    assert.equal(record.status, "running");
    assert.ok(record.pid > 0);

    // Verify it was persisted
    const saved = store.get("test-spawn-1");
    assert.ok(saved);
    assert.equal(saved.pid, record.pid);

    // Clean up the spawned process
    try { process.kill(-record.pid, "SIGTERM"); } catch {}
    try { process.kill(record.pid, "SIGTERM"); } catch {}
  });
});

test("spawnTask sets env vars from envFile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claw2pr-envfile-"));
  try {
    const store = new TaskStore(dir);
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "CUSTOM_VAR=hello\n");

    // Script that echoes the custom var to a file
    const outFile = join(dir, "output.txt");
    const scriptPath = join(dir, "env-script.sh");
    writeFileSync(scriptPath, `#!/bin/bash\necho "$CUSTOM_VAR" > "${outFile}"\n`, { mode: 0o755 });

    spawnTask(store, {
      taskId: "test-env-1",
      repo: "https://github.com/test/repo",
      task: "test env",
      taskName: "test-env",
      branch: "main",
      budget: 5,
      scriptPath,
      gritguardPath: "/nonexistent",
      selfassemblerVenv: "/nonexistent",
      templatePath: "/nonexistent",
      workspaceDir: dir,
      ghToken: "ghp_test",
      gitUserName: "Test",
      gitUserEmail: "test@test.com",
      hookToken: "",
      pluginDir: dir,
      envFile,
    });

    await new Promise<void>((resolve) => {
      const check = () => {
        if (existsSync(outFile)) {
          const content = readFileSync(outFile, "utf-8").trim();
          assert.equal(content, "hello");
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      setTimeout(check, 50);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnTask strips API keys when useSubscriptionAuth is true", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claw2pr-subauth-"));
  const origAnthropic = process.env.ANTHROPIC_API_KEY;
  const origOpenai = process.env.OPENAI_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test-anthropic";
  process.env.OPENAI_API_KEY = "sk-test-openai";

  try {
    const store = new TaskStore(dir);
    const outFile = join(dir, "auth-check.txt");
    const scriptPath = join(dir, "auth-script.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash\necho "ANTHRO=\${ANTHROPIC_API_KEY:-unset}" > "${outFile}"\necho "OPENAI=\${OPENAI_API_KEY:-unset}" >> "${outFile}"\n`,
      { mode: 0o755 },
    );

    spawnTask(store, {
      taskId: "test-auth-1",
      repo: "https://github.com/test/repo",
      task: "test auth",
      taskName: "test-auth",
      branch: "main",
      budget: 5,
      scriptPath,
      gritguardPath: "/nonexistent",
      selfassemblerVenv: "/nonexistent",
      templatePath: "/nonexistent",
      workspaceDir: dir,
      ghToken: "ghp_test",
      gitUserName: "Test",
      gitUserEmail: "test@test.com",
      hookToken: "",
      pluginDir: dir,
      useSubscriptionAuth: true,
    });

    await new Promise<void>((resolve) => {
      const check = () => {
        if (existsSync(outFile)) {
          const content = readFileSync(outFile, "utf-8");
          assert.ok(content.includes("ANTHRO=unset"), "ANTHROPIC_API_KEY should be stripped");
          assert.ok(content.includes("OPENAI=unset"), "OPENAI_API_KEY should be stripped");
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      setTimeout(check, 50);
    });
  } finally {
    if (origAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = origAnthropic;
    else delete process.env.ANTHROPIC_API_KEY;
    if (origOpenai !== undefined) process.env.OPENAI_API_KEY = origOpenai;
    else delete process.env.OPENAI_API_KEY;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── cancelTask tests ─────────────────────────────────────

test("cancelTask terminates a running process and updates store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claw2pr-cancel-"));
  try {
    const store = new TaskStore(dir);

    // Create a long-running script
    const scriptPath = join(dir, "long-script.sh");
    writeFileSync(scriptPath, "#!/bin/bash\nsleep 60\n", { mode: 0o755 });

    const record = spawnTask(store, {
      taskId: "test-cancel-1",
      repo: "https://github.com/test/repo",
      task: "cancelable task",
      taskName: "cancel-test",
      branch: "main",
      budget: 5,
      scriptPath,
      gritguardPath: "/nonexistent",
      selfassemblerVenv: "/nonexistent",
      templatePath: "/nonexistent",
      workspaceDir: dir,
      ghToken: "ghp_test",
      gitUserName: "Test",
      gitUserEmail: "test@test.com",
      hookToken: "",
      pluginDir: dir,
    });

    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 100));

    const result = cancelTask(store, "test-cancel-1");
    assert.ok(result, "cancelTask should return true");

    const updated = store.get("test-cancel-1");
    assert.equal(updated?.status, "cancelled");
    assert.equal(updated?.error, "Cancelled by user");
    assert.ok(updated?.finishedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelTask returns false for nonexistent task", () => {
  withTempDir((dir) => {
    const store = new TaskStore(dir);
    assert.equal(cancelTask(store, "nonexistent"), false);
  });
});

test("cancelTask returns false for non-running task", () => {
  withTempDir((dir) => {
    const store = new TaskStore(dir);
    store.save({
      taskId: "completed-1",
      repo: "https://github.com/test/repo",
      task: "done",
      taskName: "done",
      branch: "main",
      budget: 5,
      status: "completed",
      pid: 99999,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      workDir: dir,
      logFile: join(dir, "task.log"),
    });
    assert.equal(cancelTask(store, "completed-1"), false);
  });
});
