import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { TaskStore, type TaskStatus } from "./task-store.js";
import {
  spawnTask,
  cancelTask,
  getTaskLog,
  parseCurrentPhase,
  parsePrUrl,
  isProcessAlive,
} from "./process-manager.js";

type PluginConfig = {
  ghToken: string;
  gitUserName: string;
  gitUserEmail: string;
  defaultBudget?: number;
  maxConcurrentTasks?: number;
  selfassemblerVenv?: string;
  envFile?: string;
  useSubscriptionAuth?: boolean;
  dockerImage?: string;
};

function ok(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], details: { error: message } };
}

function generateTaskId(): string {
  return `ct-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function elapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export function createClaw2prTools(
  config: PluginConfig,
  store: TaskStore,
  pluginDir: string,
  hookToken: string,
) {
  const maxConcurrent = config.maxConcurrentTasks ?? 2;
  const defaultBudget = config.defaultBudget ?? 15;
  const gritguardPath = config.dockerImage
    ? `${pluginDir}/GritGuard/bin/gritguard-docker`
    : `${pluginDir}/GritGuard/bin/gritguard`;
  const scriptPath = `${pluginDir}/scripts/run-task.sh`;
  const templatePath = `${pluginDir}/templates/selfassembler.yaml`;
  const saVenv = config.selfassemblerVenv ?? "/var/lib/openclaw/.openclaw/selfassembler-venv";

  return [
    // ─── Run Task ──────────────────────────────────────────────
    {
      label: "Run Claw2PR Task",
      name: "claw2pr_run_task",
      description:
        "Start a new autonomous Claw2PR task. Clones a GitHub repository, runs the SelfAssembler " +
        "multi-phase workflow (research → plan → implement → test → PR) through a GritGuard sandbox. " +
        "The task runs in the background and produces a pull request when complete. " +
        "You will be notified via Telegram when the task finishes or fails. " +
        "Use claw2pr_task_status to check progress.",
      parameters: {
        type: "object" as const,
        properties: {
          repo: {
            type: "string",
            description: "GitHub repository URL (e.g. https://github.com/owner/repo) or absolute path to a local git repo (e.g. /var/lib/openclaw/code/my-project)",
          },
          task: {
            type: "string",
            description: "Description of the coding task to perform",
          },
          taskName: {
            type: "string",
            description: "Short slug for branch naming (auto-generated from task if omitted)",
          },
          branch: {
            type: "string",
            description: "Base branch to clone and work from (default: main)",
          },
          budget: {
            type: "number",
            description: `Budget limit in USD for the task (default: ${defaultBudget})`,
          },
        },
        required: ["repo", "task"],
      },
      execute: async (_toolCallId: string, args: unknown) => {
        const params = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;

        const repo = typeof params.repo === "string" ? params.repo.trim() : "";
        const task = typeof params.task === "string" ? params.task.trim() : "";
        const taskName = typeof params.taskName === "string" ? params.taskName.trim() : "";
        let branch = typeof params.branch === "string" ? params.branch.trim() : "";
        const budget = typeof params.budget === "number" ? params.budget : defaultBudget;

        if (!repo) return err("Missing 'repo' — provide a GitHub URL or local path to a git repo");
        if (!task) return err("Missing 'task' — describe what the coding task should do");

        // Determine if local path or GitHub URL
        const isLocal = repo.startsWith("/");
        if (!isLocal && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(repo)) {
          return err("Invalid repo — must be a GitHub HTTPS URL (e.g. https://github.com/owner/repo) or an absolute local path");
        }

        if (isLocal) {
          try {
            const { statSync } = await import("node:fs");
            const stat = statSync(repo);
            if (!stat.isDirectory()) return err(`Not a directory: ${repo}`);
            const { execSync } = await import("node:child_process");
            execSync("git rev-parse --git-dir", { cwd: repo, encoding: "utf-8" });
          } catch (e) {
            return err(`Local repo not valid: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // Auto-detect branch if not specified
        if (!branch) {
          if (isLocal) {
            try {
              const { execSync } = await import("node:child_process");
              branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repo, encoding: "utf-8" }).trim();
            } catch {
              branch = "main";
            }
          } else {
            branch = "main";
          }
        }

        // Validate config (ghToken only required for remote repos)
        if (!isLocal && !config.ghToken) return err("GitHub token not configured. Use claw2pr_setup_status to check.");

        // Check concurrent limit
        store.cleanup();
        const running = store.countRunning();
        if (running >= maxConcurrent) {
          return err(
            `Concurrent task limit reached (${running}/${maxConcurrent} running). ` +
            `Wait for a task to finish or cancel one with claw2pr_cancel_task.`,
          );
        }

        const taskId = generateTaskId();
        const name = taskName || slugify(task);

        try {
          const record = spawnTask(store, {
            taskId,
            repo,
            task,
            taskName: name,
            branch,
            budget,
            scriptPath,
            gritguardPath,
            selfassemblerVenv: saVenv,
            templatePath,
            workspaceDir: store.getWorkspaceDir(),
            ghToken: config.ghToken,
            gitUserName: config.gitUserName || "OpenClaw Bot",
            gitUserEmail: config.gitUserEmail || "bot@openclaw.dev",
            hookToken,
            pluginDir,
            envFile: config.envFile,
            useSubscriptionAuth: config.useSubscriptionAuth,
            dockerImage: config.dockerImage,
          });

          return ok(
            `Claw2PR task started!\n` +
            `  Task ID: ${record.taskId}\n` +
            `  Name: ${name}\n` +
            `  Repo: ${repo}\n` +
            `  Branch: ${branch}\n` +
            `  Budget: $${budget}\n` +
            `  PID: ${record.pid}\n\n` +
            `The task is running in the background. You'll be notified when it completes.\n` +
            `Use claw2pr_task_status with taskId "${record.taskId}" to check progress.`,
            { taskId: record.taskId, pid: record.pid, name },
          );
        } catch (e) {
          return err(`Failed to start task: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },

    // ─── Task Status ───────────────────────────────────────────
    {
      label: "Check Task Status",
      name: "claw2pr_task_status",
      description:
        "Check the status of a coding task. Returns current status, phase, elapsed time, " +
        "PR URL (if complete), and the last 30 lines of the task log.",
      parameters: {
        type: "object" as const,
        properties: {
          taskId: {
            type: "string",
            description: "The task ID returned by claw2pr_run_task",
          },
        },
        required: ["taskId"],
      },
      execute: async (_toolCallId: string, args: unknown) => {
        const params = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
        const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
        if (!taskId) return err("Missing 'taskId'");

        const task = store.get(taskId);
        if (!task) return err(`Task '${taskId}' not found`);

        // Check if running task's process is still alive
        if (task.status === "running" && !isProcessAlive(task.pid)) {
          // Check for status file written by run-task.sh
          const statusFile = `${task.workDir}/status.json`;
          try {
            const { readFileSync } = await import("node:fs");
            const statusData = JSON.parse(readFileSync(statusFile, "utf-8")) as Record<string, unknown>;
            const prUrl = typeof statusData.prUrl === "string" && statusData.prUrl ? statusData.prUrl : undefined;
            const status = statusData.status === "completed" ? "completed" as const : "failed" as const;
            const message = typeof statusData.message === "string" ? statusData.message : "";

            store.update(taskId, {
              status,
              finishedAt: typeof statusData.finishedAt === "string" ? statusData.finishedAt : new Date().toISOString(),
              prUrl,
              error: status === "failed" ? message : undefined,
            });
          } catch {
            // No status file — check log for PR URL
            const prUrl = parsePrUrl(task.logFile);
            if (prUrl) {
              store.update(taskId, {
                status: "completed",
                finishedAt: new Date().toISOString(),
                prUrl,
              });
            } else {
              store.update(taskId, {
                status: "failed",
                finishedAt: new Date().toISOString(),
                error: "Process exited without writing status",
              });
            }
          }
        }

        // Re-read after potential update
        const current = store.get(taskId)!;
        const phase = current.status === "running" ? parseCurrentPhase(current.logFile) : "-";
        const elapsedStr = elapsed(current.startedAt);
        const prUrl = current.prUrl || parsePrUrl(current.logFile);
        const log = getTaskLog(current.logFile, 30);

        const lines = [
          `Task: ${current.taskId}`,
          `Name: ${current.taskName}`,
          `Repo: ${current.repo}`,
          `Status: ${current.status.toUpperCase()}`,
          `Phase: ${phase}`,
          `Elapsed: ${elapsedStr}`,
          `Branch: ${current.branch}`,
          `Budget: $${current.budget}`,
        ];

        if (prUrl) lines.push(`PR: ${prUrl}`);
        if (current.error) lines.push(`Error: ${current.error}`);

        lines.push("", "─── Last 30 log lines ───", log);

        return ok(lines.join("\n"), {
          taskId: current.taskId,
          status: current.status,
          phase,
          elapsed: elapsedStr,
          prUrl,
        });
      },
    },

    // ─── List Tasks ────────────────────────────────────────────
    {
      label: "List Claw2PR Tasks",
      name: "claw2pr_list_tasks",
      description:
        "List all Claw2PR tasks with summary info. Optionally filter by status.",
      parameters: {
        type: "object" as const,
        properties: {
          status: {
            type: "string",
            description: "Filter by status: running, completed, failed, cancelled (omit for all)",
          },
        },
        required: [],
      },
      execute: async (_toolCallId: string, args: unknown) => {
        const params = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
        const statusFilter = typeof params.status === "string"
          ? (params.status.trim() as TaskStatus)
          : undefined;

        store.cleanup();
        const tasks = store.list(statusFilter);

        if (tasks.length === 0) {
          return ok(
            statusFilter
              ? `No ${statusFilter} tasks found.`
              : "No Claw2PR tasks found.",
            { count: 0 },
          );
        }

        const lines = tasks.map((t) => {
          const el = elapsed(t.startedAt);
          const prStr = t.prUrl ? ` | PR: ${t.prUrl}` : "";
          const errStr = t.error ? ` | Error: ${t.error.slice(0, 80)}` : "";
          return `• ${t.taskId} [${t.status.toUpperCase()}] ${t.taskName} — ${t.repo} (${el})${prStr}${errStr}`;
        });

        return ok(
          `${tasks.length} task(s):\n${lines.join("\n")}`,
          { count: tasks.length, tasks: tasks.map((t) => ({ taskId: t.taskId, status: t.status, taskName: t.taskName })) },
        );
      },
    },

    // ─── Cancel Task ───────────────────────────────────────────
    {
      label: "Cancel Claw2PR Task",
      name: "claw2pr_cancel_task",
      description:
        "Cancel a running Claw2PR task. Sends SIGTERM to the process group, " +
        "then SIGKILL after 5 seconds if still alive.",
      parameters: {
        type: "object" as const,
        properties: {
          taskId: {
            type: "string",
            description: "The task ID to cancel",
          },
        },
        required: ["taskId"],
      },
      execute: async (_toolCallId: string, args: unknown) => {
        const params = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
        const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
        if (!taskId) return err("Missing 'taskId'");

        const task = store.get(taskId);
        if (!task) return err(`Task '${taskId}' not found`);
        if (task.status !== "running") return err(`Task '${taskId}' is not running (status: ${task.status})`);

        const killed = cancelTask(store, taskId);
        if (killed) {
          return ok(`Task ${taskId} cancelled (PID ${task.pid} terminated).`, { taskId, cancelled: true });
        }
        return err(`Failed to cancel task ${taskId}`);
      },
    },

    // ─── Setup Status ──────────────────────────────────────────
    {
      label: "Claw2PR Setup Status",
      name: "claw2pr_setup_status",
      description:
        "Check the Claw2PR plugin dependencies and configuration. " +
        "Reports whether gritguard, srt, python3, selfassembler, claude CLI, gh CLI, " +
        "and API keys are available and properly configured.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [],
      },
      execute: async (_toolCallId: string, _args: unknown) => {
        const { execSync } = await import("node:child_process");

        const check = (label: string, fn: () => string): string => {
          try {
            const result = fn();
            return `  ✓ ${label}: ${result}`;
          } catch (e) {
            return `  ✗ ${label}: ${e instanceof Error ? e.message : "not found"}`;
          }
        };

        const checks = [
          check("GritGuard", () => {
            if (!existsSync(gritguardPath)) throw new Error(`not found at ${gritguardPath}`);
            return gritguardPath;
          }),
          check("srt (sandbox-runtime)", () => {
            return execSync("which srt 2>/dev/null || echo 'not in PATH'", { encoding: "utf-8" }).trim();
          }),
          check("Python 3", () => {
            return execSync("python3 --version 2>&1", { encoding: "utf-8" }).trim();
          }),
          check("SelfAssembler venv", () => {
            if (!existsSync(`${saVenv}/bin/selfassembler`)) throw new Error(`not found at ${saVenv}`);
            return saVenv;
          }),
          check("SelfAssembler", () => {
            return execSync(`${saVenv}/bin/selfassembler --version 2>&1`, { encoding: "utf-8" }).trim();
          }),
          check("Claude CLI", () => {
            return execSync("which claude 2>/dev/null && claude --version 2>&1 | head -1 || echo 'not found'", {
              encoding: "utf-8",
            }).trim();
          }),
          check("gh CLI", () => {
            return execSync("gh --version 2>&1 | head -1", { encoding: "utf-8" }).trim();
          }),
          check("GH_TOKEN (config)", () => {
            if (!config.ghToken) throw new Error("not configured");
            return `configured (${config.ghToken.slice(0, 6)}...)`;
          }),
          check("Claude Code auth", () => {
            const home = process.env.HOME || "/var/lib/openclaw";
            if (!existsSync(`${home}/.claude/.credentials.json`)) throw new Error("not found (~/.claude/.credentials.json)");
            return "logged in (subscription auth)";
          }),
          check("Codex auth", () => {
            const home = process.env.HOME || "/var/lib/openclaw";
            if (!existsSync(`${home}/.codex/auth.json`)) throw new Error("not found (~/.codex/auth.json)");
            return "logged in (subscription auth)";
          }),
          check("Auth mode", () => {
            return config.useSubscriptionAuth
              ? "subscription (API keys stripped)"
              : "API keys (from env/envFile)";
          }),
          check("Git identity", () => {
            if (!config.gitUserName || !config.gitUserEmail) throw new Error("not configured");
            return `${config.gitUserName} <${config.gitUserEmail}>`;
          }),
          check("Workspace", () => {
            const dir = store.getWorkspaceDir();
            if (!existsSync(dir)) throw new Error(`${dir} does not exist`);
            return dir;
          }),
          check("SA template", () => {
            if (!existsSync(templatePath)) throw new Error(`not found at ${templatePath}`);
            return templatePath;
          }),
          check("run-task.sh", () => {
            if (!existsSync(scriptPath)) throw new Error(`not found at ${scriptPath}`);
            return scriptPath;
          }),
        ];

        const running = store.countRunning();
        const total = store.list().length;

        return ok(
          `Claw2PR Plugin Status:\n${checks.join("\n")}\n\n` +
          `Tasks: ${running} running, ${total} total (max concurrent: ${maxConcurrent})`,
          { maxConcurrent, running, total },
        );
      },
    },
  ];
}
