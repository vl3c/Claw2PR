import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";

import {
  parseCurrentPhase,
  parsePrUrl,
  getTaskLog,
  isProcessAlive,
} from "../src/process-manager.js";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "claw2pr-pm-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseCurrentPhase returns the last detected phase", () => {
  withTempDir((dir) => {
    const logFile = join(dir, "task.log");
    writeFileSync(
      logFile,
      [
        "=== Phase: research ===",
        "Some output",
        "▶ Phase 2/10: planning",
        "[implementation] Starting...",
      ].join("\n"),
    );

    assert.equal(parseCurrentPhase(logFile), "implementation");
  });
});

test("parsePrUrl finds a PR URL", () => {
  withTempDir((dir) => {
    const logFile = join(dir, "task.log");
    writeFileSync(logFile, "Done https://github.com/org/repo/pull/42");
    assert.equal(parsePrUrl(logFile), "https://github.com/org/repo/pull/42");
  });
});

test("getTaskLog returns the last N lines", () => {
  withTempDir((dir) => {
    const logFile = join(dir, "task.log");
    writeFileSync(logFile, ["1", "2", "3", "4", "5"].join("\n"));
    assert.equal(getTaskLog(logFile, 2), "4\n5");
  });
});

test("isProcessAlive reflects process lifecycle", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 1000)"]);
  try {
    assert.ok(isProcessAlive(child.pid));
  } finally {
    child.kill();
    await once(child, "exit");
  }

  assert.equal(isProcessAlive(child.pid), false);
});
