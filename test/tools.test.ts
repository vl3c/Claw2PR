import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { createClaw2prTools } from "../src/tools.js";
import { TaskStore, type TaskRecord } from "../src/task-store.js";
import type { PluginConfig } from "../src/types.js";

function makeTestEnv() {
  const dir = mkdtempSync(join(tmpdir(), "claw2pr-tools-"));
  const store = new TaskStore(dir);

  // Create minimal required files so setup_status checks work
  const scriptsDir = join(dir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  const scriptPath = join(scriptsDir, "run-task.sh");
  writeFileSync(scriptPath, "#!/bin/bash\nsleep 0.1\n", { mode: 0o755 });

  const templatesDir = join(dir, "templates");
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(join(templatesDir, "selfassembler.yaml"), "budget_limit_usd: 15\n");

  const ggDir = join(dir, "GritGuard", "bin");
  mkdirSync(ggDir, { recursive: true });
  writeFileSync(join(ggDir, "gritguard"), "#!/bin/bash\n", { mode: 0o755 });

  const config: PluginConfig = {
    ghToken: "ghp_testtoken123456",
    gitUserName: "Test Bot",
    gitUserEmail: "bot@test.com",
    maxConcurrentTasks: 2,
    defaultBudget: 10,
  };

  const tools = createClaw2prTools(config, store, dir, "hook-token-123");

  const findTool = (name: string) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool ${name} not found`);
    return tool;
  };

  return { dir, store, config, tools, findTool };
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

// Helper to extract text from tool result
function getText(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text;
}

// ─── claw2pr_run_task validation tests ─────────────────────

test("run_task rejects missing repo", async () => {
  const { dir, findTool } = makeTestEnv();
  try {
    const tool = findTool("claw2pr_run_task");
    const result = await tool.execute("tc-1", { task: "do something" });
    assert.ok(getText(result).includes("Error: Missing 'repo'"));
  } finally {
    cleanup(dir);
  }
});

test("run_task rejects missing task", async () => {
  const { dir, findTool } = makeTestEnv();
  try {
    const tool = findTool("claw2pr_run_task");
    const result = await tool.execute("tc-1", { repo: "https://github.com/a/b" });
    assert.ok(getText(result).includes("Error: Missing 'task'"));
  } finally {
    cleanup(dir);
  }
});

test("run_task rejects invalid repo URL", async () => {
  const { dir, findTool } = makeTestEnv();
  try {
    const tool = findTool("claw2pr_run_task");
    const result = await tool.execute("tc-1", {
      repo: "http://gitlab.com/a/b",
      task: "something",
    });
    assert.ok(getText(result).includes("Error: Invalid repo"));
  } finally {
    cleanup(dir);
  }
});

test("run_task rejects nonexistent local repo", async () => {
  const { dir, findTool } = makeTestEnv();
  try {
    const tool = findTool("claw2pr_run_task");
    const result = await tool.execute("tc-1", {
      repo: "/nonexistent/path/to/repo",
      task: "something",
    });
    assert.ok(getText(result).includes("Error: Local repo not valid"));
  } finally {
    cleanup(dir);
  }
});

test("run_task rejects when ghToken missing for remote repo", async () => {
  const { dir, store } = makeTestEnv();
  try {
    const noTokenConfig: PluginConfig = {
      ghToken: "",
      gitUserName: "Bot",
      gitUserEmail: "bot@test.com",
    };
    const tools = createClaw2prTools(noTokenConfig, store, dir, "");
    const tool = tools.find((t) => t.name === "claw2pr_run_task")!;

    const result = await tool.execute("tc-1", {
      repo: "https://github.com/test/repo",
      task: "do a thing",
    });
    assert.ok(getText(result).includes("Error: GitHub token not configured"));
  } finally {
    cleanup(dir);
  }
});

test("run_task enforces concurrent task limit", async () => {
  const { dir, store, findTool } = makeTestEnv();
  try {
    // Manually add 2 running tasks to hit the limit
    for (let i = 0; i < 2; i++) {
      store.save({
        taskId: `running-${i}`,
        repo: "https://github.com/test/repo",
        task: "running",
        taskName: "running",
        branch: "main",
        budget: 5,
        status: "running",
        pid: process.pid, // use our own PID so isProcessAlive returns true
        startedAt: new Date().toISOString(),
        workDir: dir,
        logFile: join(dir, "task.log"),
      });
    }

    const tool = findTool("claw2pr_run_task");
    const result = await tool.execute("tc-1", {
      repo: "https://github.com/test/repo",
      task: "one more task",
    });
    assert.ok(getText(result).includes("Concurrent task limit reached"));
  } finally {
    cleanup(dir);
  }
});

test("run_task accepts valid local repo", async () => {
  const { dir, findTool } = makeTestEnv();
  try {
    // Create a real git repo
    const repoDir = join(dir, "test-repo");
    mkdirSync(repoDir);
    execSync(
      'git init && git config user.name "Test" && git config user.email "test@test.com" && git commit --allow-empty -m init',
      { cwd: repoDir },
    );

    const tool = findTool("claw2pr_run_task");
    const result = await tool.execute("tc-1", {
      repo: repoDir,
      task: "add a feature",
    });
    const text = getText(result);
    assert.ok(text.includes("Claw2PR task started"), `Expected success, got: ${text}`);
    assert.ok(result.details.taskId);
    assert.ok(result.details.pid);

    // Clean up spawned process
    try { process.kill(-(result.details.pid as number), "SIGTERM"); } catch {}
    try { process.kill(result.details.pid as number, "SIGTERM"); } catch {}
  } finally {
    cleanup(dir);
  }
});

test("run_task handles null/undefined args gracefully", async () => {
  const { dir, findTool } = makeTestEnv();
  try {
    const tool = findTool("claw2pr_run_task");
    const result = await tool.execute("tc-1", null);
    assert.ok(getText(result).includes("Error: Missing 'repo'"));
  } finally {
    cleanup(dir);
  }
});

// ─── claw2pr_task_status tests ──────────────────────────────

test("task_status returns error for missing taskId", async () => {
  const { dir, findTool } = makeTestEnv();
  try {
    const tool = findTool("claw2pr_task_status");
    const result = await tool.execute("tc-1", {});
    assert.ok(getText(result).includes("Error: Missing 'taskId'"));
  } finally {
    cleanup(dir);
  }
});

test("task_status returns error for unknown task", async () => {
  const { dir, findTool } = makeTestEnv();
  try {
    const tool = findTool("claw2pr_task_status");
    const result = await tool.execute("tc-1", { taskId: "nonexistent" });
    assert.ok(getText(result).includes("not found"));
  } finally {
    cleanup(dir);
  }
});

test("task_status reconciles dead process from status.json", async () => {
  const { dir, store, findTool } = makeTestEnv();
  try {
    const workDir = join(dir, "dead-task-work");
    mkdirSync(workDir, { recursive: true });
    const logFile = join(workDir, "task.log");
    writeFileSync(logFile, "some log output\n");

    // Write a status.json as if run-task.sh completed
    writeFileSync(
      join(workDir, "status.json"),
      JSON.stringify({
        status: "completed",
        message: "Task completed successfully",
        prUrl: "https://github.com/test/repo/pull/42",
        finishedAt: new Date().toISOString(),
      }),
    );

    store.save({
      taskId: "dead-1",
      repo: "https://github.com/test/repo",
      task: "dead task",
      taskName: "dead-task",
      branch: "main",
      budget: 5,
      status: "running",
      pid: 999999, // Dead PID
      startedAt: new Date().toISOString(),
      workDir,
      logFile,
    });

    const tool = findTool("claw2pr_task_status");
    const result = await tool.execute("tc-1", { taskId: "dead-1" });
    const text = getText(result);

    assert.ok(text.includes("COMPLETED"));
    assert.ok(text.includes("https://github.com/test/repo/pull/42"));
    assert.equal(result.details.status, "completed");
    assert.equal(result.details.prUrl, "https://github.com/test/repo/pull/42");
  } finally {
    cleanup(dir);
  }
});

test("task_status marks dead process as failed when no status.json", async () => {
  const { dir, store, findTool } = makeTestEnv();
  try {
    const workDir = join(dir, "dead-no-status");
    mkdirSync(workDir, { recursive: true });
    const logFile = join(workDir, "task.log");
    writeFileSync(logFile, "error: something went wrong\n");

    store.save({
      taskId: "dead-2",
      repo: "https://github.com/test/repo",
      task: "dead task",
      taskName: "dead-task",
      branch: "main",
      budget: 5,
      status: "running",
      pid: 999999,
      startedAt: new Date().toISOString(),
      workDir,
      logFile,
    });

    const tool = findTool("claw2pr_task_status");
    const result = await tool.execute("tc-1", { taskId: "dead-2" });
    const text = getText(result);

    assert.ok(text.includes("FAILED"));
    assert.ok(text.includes("Process exited without writing status"));
    assert.equal(result.details.status, "failed");
  } finally {
    cleanup(dir);
  }
});

test("task_status reports completed task details", async () => {
  const { dir, store, findTool } = makeTestEnv();
  try {
    const logFile = join(dir, "done-task.log");
    writeFileSync(logFile, "=== Phase: implementation ===\nAll done\n");

    store.save({
      taskId: "done-1",
      repo: "https://github.com/test/repo",
      task: "completed task",
      taskName: "done-task",
      branch: "main",
      budget: 10,
      status: "completed",
      pid: 12345,
      startedAt: new Date(Date.now() - 60000).toISOString(),
      finishedAt: new Date().toISOString(),
      prUrl: "https://github.com/test/repo/pull/99",
      workDir: dir,
      logFile,
    });

    const tool = findTool("claw2pr_task_status");
    const result = await tool.execute("tc-1", { taskId: "done-1" });
    const text = getText(result);

    assert.ok(text.includes("COMPLETED"));
    assert.ok(text.includes("done-task"));
    assert.ok(text.includes("https://github.com/test/repo/pull/99"));
    assert.ok(text.includes("Phase: -")); // Not running, so phase is -
  } finally {
    cleanup(dir);
  }
});

// ─── claw2pr_list_tasks tests ──────────────────────────────

test("list_tasks returns empty message when no tasks", async () => {
  const { dir, findTool } = makeTestEnv();
  try {
    const tool = findTool("claw2pr_list_tasks");
    const result = await tool.execute("tc-1", {});
    assert.ok(getText(result).includes("No Claw2PR tasks found"));
    assert.equal(result.details.count, 0);
  } finally {
    cleanup(dir);
  }
});

test("list_tasks filters by status", async () => {
  const { dir, store, findTool } = makeTestEnv();
  try {
    store.save({
      taskId: "r-1",
      repo: "r",
      task: "t",
      taskName: "running-task",
      branch: "main",
      budget: 5,
      status: "running",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      workDir: dir,
      logFile: join(dir, "r.log"),
    });
    store.save({
      taskId: "c-1",
      repo: "r",
      task: "t",
      taskName: "completed-task",
      branch: "main",
      budget: 5,
      status: "completed",
      pid: 1234,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      workDir: dir,
      logFile: join(dir, "c.log"),
    });

    const tool = findTool("claw2pr_list_tasks");

    const allResult = await tool.execute("tc-1", {});
    assert.equal(allResult.details.count, 2);

    const runningResult = await tool.execute("tc-2", { status: "running" });
    assert.equal(runningResult.details.count, 1);
    assert.ok(getText(runningResult).includes("running-task"));

    const completedResult = await tool.execute("tc-3", { status: "completed" });
    assert.equal(completedResult.details.count, 1);
    assert.ok(getText(completedResult).includes("completed-task"));

    const failedResult = await tool.execute("tc-4", { status: "failed" });
    assert.ok(getText(failedResult).includes("No failed tasks found"));
  } finally {
    cleanup(dir);
  }
});

// ─── claw2pr_cancel_task tests ──────────────────────────────

test("cancel_task rejects missing taskId", async () => {
  const { dir, findTool } = makeTestEnv();
  try {
    const tool = findTool("claw2pr_cancel_task");
    const result = await tool.execute("tc-1", {});
    assert.ok(getText(result).includes("Error: Missing 'taskId'"));
  } finally {
    cleanup(dir);
  }
});

test("cancel_task rejects unknown task", async () => {
  const { dir, findTool } = makeTestEnv();
  try {
    const tool = findTool("claw2pr_cancel_task");
    const result = await tool.execute("tc-1", { taskId: "nope" });
    assert.ok(getText(result).includes("not found"));
  } finally {
    cleanup(dir);
  }
});

test("cancel_task rejects non-running task", async () => {
  const { dir, store, findTool } = makeTestEnv();
  try {
    store.save({
      taskId: "done-cancel",
      repo: "r",
      task: "t",
      taskName: "done",
      branch: "main",
      budget: 5,
      status: "completed",
      pid: 99999,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      workDir: dir,
      logFile: join(dir, "t.log"),
    });

    const tool = findTool("claw2pr_cancel_task");
    const result = await tool.execute("tc-1", { taskId: "done-cancel" });
    assert.ok(getText(result).includes("is not running"));
  } finally {
    cleanup(dir);
  }
});

// ─── claw2pr_setup_status tests ──────────────────────────────

test("setup_status returns structured output", async () => {
  const { dir, findTool } = makeTestEnv();
  try {
    const tool = findTool("claw2pr_setup_status");
    const result = await tool.execute("tc-1", {});
    const text = getText(result);

    assert.ok(text.includes("Claw2PR Plugin Status"));
    assert.ok(text.includes("GritGuard"));
    assert.ok(text.includes("GH_TOKEN (config)"));
    // Token should be masked
    assert.ok(text.includes("configured (****)"), "Token prefix should be masked");
    assert.ok(!text.includes("ghp_test"), "Token value should not appear");
    assert.ok(result.details.maxConcurrent === 2);
  } finally {
    cleanup(dir);
  }
});
