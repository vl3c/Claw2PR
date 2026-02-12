import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";

export type TaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface TaskRecord {
  taskId: string;
  repo: string;
  task: string;
  taskName: string;
  branch: string;
  budget: number;
  status: TaskStatus;
  pid: number;
  startedAt: string;
  finishedAt?: string;
  prUrl?: string;
  error?: string;
  workDir: string;
  logFile: string;
}

const CLEANUP_DAYS = 7;

export class TaskStore {
  private filePath: string;
  private workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.filePath = join(workspaceDir, "tasks.json");
    mkdirSync(workspaceDir, { recursive: true });
  }

  private readAll(): Record<string, TaskRecord> {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      return JSON.parse(raw);
    } catch (e) {
      // Distinguish missing file (normal) from corrupt file (data loss risk)
      if (existsSync(this.filePath)) {
        console.log(`[claw2pr] Warning: tasks.json is corrupt or unreadable: ${e}`);
      }
      return {};
    }
  }

  private writeAll(tasks: Record<string, TaskRecord>): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.tasks-tmp-${Date.now()}.json`);
    writeFileSync(tmp, JSON.stringify(tasks, null, 2));
    renameSync(tmp, this.filePath);
  }

  /** Reconcile running tasks — mark failed if PID is dead */
  reconcile(): void {
    const tasks = this.readAll();
    let changed = false;
    for (const [id, task] of Object.entries(tasks)) {
      if (task.status === "running") {
        try {
          process.kill(task.pid, 0); // Check if alive
        } catch {
          task.status = "failed";
          task.finishedAt = new Date().toISOString();
          task.error = "Process died (detected on startup reconciliation)";
          changed = true;
          console.log(`[claw2pr] Task ${id} marked failed: PID ${task.pid} not found`);
        }
      }
    }
    if (changed) this.writeAll(tasks);
  }

  /** Clean up completed/failed tasks older than CLEANUP_DAYS */
  cleanup(): void {
    const tasks = this.readAll();
    const cutoff = Date.now() - CLEANUP_DAYS * 24 * 60 * 60 * 1000;
    let changed = false;

    for (const [id, task] of Object.entries(tasks)) {
      if (task.status === "running") continue;
      const fin = task.finishedAt ? new Date(task.finishedAt).getTime() : 0;
      if (fin > 0 && fin < cutoff) {
        // Remove workspace directory (may contain root-owned files from Docker)
        if (existsSync(task.workDir)) {
          try {
            rmSync(task.workDir, { recursive: true, force: true });
          } catch {
            try {
              execSync(
                `docker run --rm -v ${JSON.stringify(task.workDir)}:/cleanup alpine rm -rf /cleanup`,
                { timeout: 30_000 },
              );
              try { execSync(`rmdir ${JSON.stringify(task.workDir)}`, { timeout: 5_000 }); } catch { /* ok */ }
            } catch (e) {
              console.log(`[claw2pr] Warning: failed to clean ${task.workDir}: ${e}`);
            }
          }
        }
        delete tasks[id];
        changed = true;
        console.log(`[claw2pr] Cleaned up expired task ${id}`);
      }
    }
    if (changed) this.writeAll(tasks);
  }

  save(task: TaskRecord): void {
    const tasks = this.readAll();
    tasks[task.taskId] = task;
    this.writeAll(tasks);
  }

  get(taskId: string): TaskRecord | undefined {
    return this.readAll()[taskId];
  }

  list(statusFilter?: TaskStatus): TaskRecord[] {
    const tasks = this.readAll();
    const all = Object.values(tasks);
    if (statusFilter) return all.filter((t) => t.status === statusFilter);
    return all;
  }

  update(taskId: string, patch: Partial<TaskRecord>): void {
    const tasks = this.readAll();
    const existing = tasks[taskId];
    if (!existing) return;
    tasks[taskId] = { ...existing, ...patch };
    this.writeAll(tasks);
  }

  remove(taskId: string): boolean {
    const tasks = this.readAll();
    if (!(taskId in tasks)) return false;
    delete tasks[taskId];
    this.writeAll(tasks);
    return true;
  }

  countRunning(): number {
    return this.list("running").length;
  }

  getWorkspaceDir(): string {
    return this.workspaceDir;
  }
}
