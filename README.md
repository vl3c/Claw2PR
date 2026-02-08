# coding-tool

An OpenClaw plugin that enables the agent to run autonomous coding tasks. Give it a repository and a task description — it clones the repo, runs [SelfAssembler](https://github.com/vl3c/SelfAssembler) (a multi-phase coding workflow) inside a [GritGuard](https://github.com/vl3c/GritGuard) sandbox, and produces a pull request (or a local branch for local repos).

Typical use: tell the OpenClaw agent via Telegram "use the coding tool to implement feature X on repo Y" and come back to a finished PR.

## How it works

```
User → Telegram → OpenClaw agent → coding_run_task tool
                                         │
                                    run-task.sh (detached)
                                         │
                          ┌──────────────────────────────┐
                          │  git clone repo               │
                          │  configure git identity       │
                          │  copy selfassembler.yaml      │
                          │  activate SA venv             │
                          │  GritGuard sandbox (bwrap)    │
                          │    └─ SelfAssembler           │
                          │        ├─ research (debate)   │
                          │        ├─ planning (debate)   │
                          │        ├─ implementation      │
                          │        ├─ test writing        │
                          │        ├─ test execution      │
                          │        ├─ code review (debate)│
                          │        ├─ fix review issues   │
                          │        ├─ commit & push       │
                          │        └─ PR creation         │
                          └──────────────────────────────┘
                                         │
                              notify agent via /hooks/agent
                                         │
                          Agent relays result to Telegram
```

SelfAssembler uses debate mode by default: Claude Code (primary) and Codex (secondary) independently analyze the task, debate their findings, then synthesize a consensus before acting. This happens for research, planning, plan review, and code review phases.

## Tools

| Tool | Description |
|------|-------------|
| `coding_run_task` | Start a new task (repo + description). Returns a task ID. |
| `coding_task_status` | Check progress: current phase, elapsed time, log tail, PR URL. |
| `coding_list_tasks` | List all tasks with summary info. Filter by status. |
| `coding_cancel_task` | Kill a running task (SIGTERM → SIGKILL). |
| `coding_setup_status` | Check all dependencies and config. |

## Supported repos

- **GitHub repos** — cloned via HTTPS with a configured PAT. On completion, SelfAssembler pushes a feature branch and opens a PR.
- **Local repos** — cloned from an absolute path (e.g. `/var/lib/openclaw/code/my-project`). PR creation is skipped; the feature branch is committed locally.

## Project structure

```
coding-tool/
├── index.ts                  # Plugin entry — registers 5 tools
├── openclaw.plugin.json      # Plugin manifest with config schema
├── package.json
├── src/
│   ├── tools.ts              # Tool definitions (params, execute)
│   ├── process-manager.ts    # Spawn/track/kill background tasks
│   ├── task-store.ts         # Persistent JSON task state, auto-cleanup
│   └── notifier.ts           # POST to /hooks/agent on completion
├── scripts/
│   └── run-task.sh           # Clone → configure → GritGuard → SelfAssembler
├── templates/
│   └── selfassembler.yaml    # Default SA config (debate mode, no approvals)
├── GritGuard/                # Submodule — bubblewrap sandbox wrapper
└── SelfAssembler/            # Submodule — multi-phase coding orchestrator
```

## Configuration

In `openclaw.json` under `plugins.entries.coding-tool.config`:

```json
{
  "ghToken": "ghp_...",
  "gitUserName": "vl3c",
  "gitUserEmail": "vlad3ciobanu@gmail.com",
  "defaultBudget": 15,
  "maxConcurrentTasks": 2,
  "selfassemblerVenv": "/var/lib/openclaw/.openclaw/selfassembler-venv",
  "envFile": "/home/<user>/.env"
}
```

- `ghToken` — GitHub PAT for cloning private repos and creating PRs
- `gitUserName` / `gitUserEmail` — git identity for commits
- `defaultBudget` — USD limit per task (default 15)
- `maxConcurrentTasks` — concurrent task cap (default 2)
- `selfassemblerVenv` — path to the Python venv with SelfAssembler installed
- `envFile` — optional `.env` file with API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) passed to task processes

## Setup

Prerequisites: the OpenClaw service must be running as the `openclaw` user.

1. **Install sandbox runtime**: `sudo npm install -g @anthropic-ai/sandbox-runtime`
2. **Ensure CLIs are globally available**: `claude`, `codex`, `srt`, `gh` in `/usr/local/bin/`
3. **Create SelfAssembler venv**:
   ```bash
   sudo -u openclaw python3 -m venv /var/lib/openclaw/.openclaw/selfassembler-venv
   sudo -u openclaw /var/lib/openclaw/.openclaw/selfassembler-venv/bin/pip install -e ./SelfAssembler
   ```
4. **Symlink plugin to extensions**:
   ```bash
   sudo -u openclaw ln -s /home/<user>/agent/coding-tool /var/lib/openclaw/.openclaw/extensions/coding-tool
   ```
5. **Set directory permissions** (openclaw needs to traverse the symlink):
   ```bash
   chmod o+x /home/<user> /home/<user>/agent
   ```
6. **Add plugin config** to `openclaw.json` (see Configuration above)
7. **Create workspace**: `sudo -u openclaw mkdir -p /var/lib/openclaw/.openclaw/workspace/coding-tasks`
8. **Restart**: `sudo systemctl restart openclaw`
9. **Verify**: ask the agent to run `coding_setup_status` — all checks should be green

## Task lifecycle

1. Agent calls `coding_run_task` with repo URL and task description
2. Plugin spawns `run-task.sh` as a detached process (survives OpenClaw restarts)
3. Script clones repo, patches config, runs SelfAssembler through GritGuard
4. SelfAssembler goes through ~15 phases with debate mode
5. On completion, script writes `status.json` and POSTs to `/hooks/agent`
6. Agent wakes up and relays the result (PR URL or error) to Telegram
7. Workspaces auto-clean after 7 days

## Lessons learned

Things that broke during development and the fixes applied:

- **SelfAssembler state directory**: SA writes checkpoints to `~/.local/state/selfassembler/` which was blocked by the sandbox. Fixed by adding `$HOME/.local/state` to GritGuard's `base.json` allowWrite.
- **Git dirty worktree**: copying `selfassembler.yaml` into the repo before running made git dirty, failing preflight. Fixed by committing a `.gitignore` for SA artifacts before running.
- **Worktree path outside sandbox**: SA's `.worktrees` directory defaulted to a path outside the sandbox's writable area. Fixed by setting `worktree_dir: "./.worktrees"` (inside repo, which is writable).
- **Local repo push fails in sandbox**: `git push` to a local origin fails because the origin path isn't writable inside bwrap. Fixed by disabling `pr_creation` and `pr_self_review` phases for local repos.
- **Subscription auth vs API keys**: Claude Code and Codex use OAuth credentials, not API keys. Inside the sandbox, auth files at `~/.claude/.credentials.json` and `~/.codex/auth.json` must be bind-mounted (GritGuard handles this). For testing, API keys can be injected via `envFile`.
