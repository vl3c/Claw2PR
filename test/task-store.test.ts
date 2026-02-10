import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TaskStore, type TaskRecord } from "../src/task-store.js";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "claw2pr-store-"));
  const store = new TaskStore(dir);
  return { dir, store };
}

function cleanupDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

test("TaskStore save/get/update/list", () => {
  const { dir, store } = makeStore();
  try {
    const record: TaskRecord = {
      taskId: "t-1",
      repo: "https://github.com/example/repo",
      task: "do thing",
      taskName: "do-thing",
      branch: "main",
      budget: 5,
      status: "running",
      pid: 1234,
      startedAt: new Date().toISOString(),
      workDir: join(dir, "work"),
      logFile: join(dir, "task.log"),
    };

    store.save(record);
    assert.equal(store.get("t-1")?.taskName, "do-thing");

    store.update("t-1", { status: "completed", prUrl: "https://github.com/a/b/pull/1" });
    const updated = store.get("t-1");
    assert.equal(updated?.status, "completed");
    assert.equal(updated?.prUrl, "https://github.com/a/b/pull/1");

    assert.equal(store.list().length, 1);
    assert.equal(store.list("completed").length, 1);
    assert.equal(store.list("running").length, 0);
  } finally {
    cleanupDir(dir);
  }
});

test("TaskStore cleanup removes expired tasks and workdir", () => {
  const { dir, store } = makeStore();
  try {
    const workDir = join(dir, "work-old");
    mkdirSync(workDir, { recursive: true });

    const record: TaskRecord = {
      taskId: "t-old",
      repo: "https://github.com/example/repo",
      task: "old",
      taskName: "old",
      branch: "main",
      budget: 5,
      status: "completed",
      pid: 1234,
      startedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      finishedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      workDir,
      logFile: join(dir, "task.log"),
    };

    store.save(record);
    store.cleanup();

    assert.equal(store.get("t-old"), undefined);
    assert.equal(store.list().length, 0);
    assert.doesNotThrow(() => mkdirSync(workDir, { recursive: false }));
  } finally {
    cleanupDir(dir);
  }
});

test("TaskStore reconcile marks dead pids as failed", () => {
  const { dir, store } = makeStore();
  try {
    const record: TaskRecord = {
      taskId: "t-dead",
      repo: "https://github.com/example/repo",
      task: "dead",
      taskName: "dead",
      branch: "main",
      budget: 5,
      status: "running",
      pid: 999999,
      startedAt: new Date().toISOString(),
      workDir: join(dir, "work"),
      logFile: join(dir, "task.log"),
    };

    store.save(record);
    store.reconcile();

    const updated = store.get("t-dead");
    assert.equal(updated?.status, "failed");
    assert.ok(updated?.finishedAt);
    assert.equal(updated?.error, "Process died (detected on startup reconciliation)");
  } finally {
    cleanupDir(dir);
  }
});
