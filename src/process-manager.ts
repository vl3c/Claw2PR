import { spawn } from "node:child_process";
import { TaskStore, type TaskRecord } from "./task-store.js";
import { readFileSync, existsSync } from "node:fs";

export function loadEnvFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!existsSync(path)) return vars;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    // Strip surrounding single or double quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

export interface RunTaskOpts {
  taskId: string;
  repo: string;
  task: string;
  taskName: string;
  branch: string;
  budget: number;
  scriptPath: string;
  gritguardPath: string;
  selfassemblerVenv: string;
  templatePath: string;
  workspaceDir: string;
  ghToken: string;
  gitUserName: string;
  gitUserEmail: string;
  hookToken: string;
  pluginDir: string;
  envFile?: string;
  useSubscriptionAuth?: boolean;
  dockerImage?: string;
}

export function spawnTask(
  store: TaskStore,
  opts: RunTaskOpts,
): TaskRecord {
  const taskDir = `${opts.workspaceDir}/${opts.taskId}`;
  const logFile = `${taskDir}/task.log`;

  // Load API keys from env file if configured
  const envFileVars = opts.envFile ? loadEnvFile(opts.envFile) : {};

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...envFileVars,
    TASK_ID: opts.taskId,
    REPO_URL: opts.repo,
    TASK_DESCRIPTION: opts.task,
    TASK_NAME: opts.taskName,
    BASE_BRANCH: opts.branch,
    BUDGET: String(opts.budget),
    TASK_DIR: taskDir,
    LOG_FILE: logFile,
    GRITGUARD_PATH: opts.gritguardPath,
    SA_VENV: opts.selfassemblerVenv,
    SA_TEMPLATE: opts.templatePath,
    GH_TOKEN: opts.ghToken,
    GIT_AUTHOR_NAME: opts.gitUserName,
    GIT_AUTHOR_EMAIL: opts.gitUserEmail,
    GIT_COMMITTER_NAME: opts.gitUserName,
    GIT_COMMITTER_EMAIL: opts.gitUserEmail,
    HOOK_TOKEN: opts.hookToken,
    PLUGIN_DIR: opts.pluginDir,
    ...(opts.dockerImage && { GRITGUARD_DOCKER_IMAGE: opts.dockerImage }),
  };

  // When useSubscriptionAuth is enabled, strip API keys so CLIs
  // fall back to their stored subscription credentials
  if (opts.useSubscriptionAuth) {
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
  }

  const child = spawn("bash", [opts.scriptPath], {
    env,
    detached: true,
    stdio: "ignore",
    cwd: opts.pluginDir,
  });

  child.unref();

  if (!child.pid) {
    throw new Error("Failed to spawn task process — no PID returned");
  }

  const record: TaskRecord = {
    taskId: opts.taskId,
    repo: opts.repo,
    task: opts.task,
    taskName: opts.taskName,
    branch: opts.branch,
    budget: opts.budget,
    status: "running",
    pid: child.pid,
    startedAt: new Date().toISOString(),
    workDir: taskDir,
    logFile,
  };

  store.save(record);
  console.log(`[claw2pr] Spawned task ${opts.taskId} (PID ${child.pid})`);
  return record;
}

export function cancelTask(store: TaskStore, taskId: string): boolean {
  const task = store.get(taskId);
  if (!task) return false;
  if (task.status !== "running") return false;

  try {
    // Kill the whole process group
    process.kill(-task.pid, "SIGTERM");
  } catch {
    try {
      process.kill(task.pid, "SIGTERM");
    } catch {
      // Already dead
    }
  }

  // Give it a moment, then force kill
  setTimeout(() => {
    try {
      process.kill(-task.pid, "SIGKILL");
    } catch {
      // Already dead
    }
  }, 5000);

  store.update(taskId, {
    status: "cancelled",
    finishedAt: new Date().toISOString(),
    error: "Cancelled by user",
  });

  return true;
}

export function getTaskLog(logFile: string, lines: number = 30): string {
  try {
    const content = readFileSync(logFile, "utf-8");
    const allLines = content.split("\n");
    return allLines.slice(-lines).join("\n");
  } catch {
    return "(no log available)";
  }
}

export function parseCurrentPhase(logFile: string): string {
  try {
    const content = readFileSync(logFile, "utf-8");
    // SelfAssembler logs phase transitions like: "=== Phase: research ==="
    // or "[phase_name] Starting..."
    const phaseMatches = content.match(/(?:=== Phase: (\w+)|▶ Phase \d+\/\d+: (\w+)|\[(\w+)\] (?:Starting|Running))/g);
    if (phaseMatches && phaseMatches.length > 0) {
      const last = phaseMatches[phaseMatches.length - 1];
      const m = last.match(/(?:Phase: (\w+)|Phase \d+\/\d+: (\w+)|\[(\w+)\])/);
      if (m) return m[1] || m[2] || m[3] || "unknown";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function parsePrUrl(logFile: string): string | undefined {
  try {
    const content = readFileSync(logFile, "utf-8");
    // Look for GitHub PR URL in output
    const m = content.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
    return m ? m[0] : undefined;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseCheckpointId(logFile: string): string | undefined {
  try {
    const content = readFileSync(logFile, "utf-8");
    // SelfAssembler logs: "Resume with: selfassembler --resume checkpoint_XXXXXXXX"
    // Use matchAll and return the last match — resume appends to the same log,
    // so a failed resume adds a newer checkpoint line below the original.
    const matches = [...content.matchAll(/Resume with: selfassembler --resume (checkpoint_[A-Za-z0-9_-]+)/g)];
    return matches.length > 0 ? matches[matches.length - 1][1] : undefined;
  } catch {
    return undefined;
  }
}

export interface ResumeTaskOpts {
  taskId: string;
  checkpointId: string;
  budget: number;
  scriptPath: string;
  gritguardPath: string;
  selfassemblerVenv: string;
  ghToken: string;
  gitUserName: string;
  gitUserEmail: string;
  hookToken: string;
  pluginDir: string;
  envFile?: string;
  useSubscriptionAuth?: boolean;
  dockerImage?: string;
  skipPhases?: string;
}

export function spawnResumeTask(
  store: TaskStore,
  opts: ResumeTaskOpts,
): TaskRecord {
  const task = store.get(opts.taskId);
  if (!task) throw new Error(`Task '${opts.taskId}' not found`);

  // Load API keys from env file if configured
  const envFileVars = opts.envFile ? loadEnvFile(opts.envFile) : {};

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...envFileVars,
    TASK_ID: opts.taskId,
    REPO_URL: task.repo,
    TASK_DESCRIPTION: task.task,
    TASK_NAME: task.taskName,
    BASE_BRANCH: task.branch,
    BUDGET: String(opts.budget),
    TASK_DIR: task.workDir,
    LOG_FILE: task.logFile,
    GRITGUARD_PATH: opts.gritguardPath,
    SA_VENV: opts.selfassemblerVenv,
    SA_TEMPLATE: "", // Not needed for resume
    GH_TOKEN: opts.ghToken,
    GIT_AUTHOR_NAME: opts.gitUserName,
    GIT_AUTHOR_EMAIL: opts.gitUserEmail,
    GIT_COMMITTER_NAME: opts.gitUserName,
    GIT_COMMITTER_EMAIL: opts.gitUserEmail,
    HOOK_TOKEN: opts.hookToken,
    PLUGIN_DIR: opts.pluginDir,
    RESUME_CHECKPOINT: opts.checkpointId,
    ...(opts.dockerImage && { GRITGUARD_DOCKER_IMAGE: opts.dockerImage }),
    ...(opts.skipPhases && { SKIP_PHASES: opts.skipPhases }),
  };

  if (opts.useSubscriptionAuth) {
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
  }

  const child = spawn("bash", [opts.scriptPath], {
    env,
    detached: true,
    stdio: "ignore",
    cwd: opts.pluginDir,
  });

  child.unref();

  if (!child.pid) {
    throw new Error("Failed to spawn resume process — no PID returned");
  }

  store.update(opts.taskId, {
    status: "running",
    pid: child.pid,
    budget: opts.budget,
    finishedAt: undefined,
    error: undefined,
  });

  console.log(`[claw2pr] Resumed task ${opts.taskId} from ${opts.checkpointId} (PID ${child.pid})`);
  return store.get(opts.taskId)!;
}
