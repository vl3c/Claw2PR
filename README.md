# Claw2PR

An OpenClaw plugin that enables the agent to run autonomous coding tasks. Give it a repository and a task description — it clones the repo, runs [SelfAssembler](https://github.com/vl3c/SelfAssembler) (a multi-phase coding workflow) inside a [GritGuard](https://github.com/vl3c/GritGuard) sandbox, and produces a pull request (or a local branch for local repos).

Typical use: tell the OpenClaw agent via Telegram "use claw2pr to implement feature X on repo Y" and come back to a finished PR.

## How it works

```
User → Telegram → OpenClaw agent → claw2pr_run_task tool
                                         │
                                    run-task.sh (detached)
                                         │
                          ┌──────────────────────────────────┐
                          │  git clone repo                   │
                          │  configure git identity           │
                          │  copy selfassembler.yaml          │
                          │  activate SA venv                 │
                          │  GritGuard sandbox (Docker/bwrap) │
                          │    └─ SelfAssembler               │
                          │        ├─ research (feedback)     │
                          │        ├─ planning (feedback)     │
                          │        ├─ plan review (feedback)  │
                          │        ├─ implementation          │
                          │        ├─ test writing            │
                          │        ├─ test execution          │
                          │        ├─ code review (feedback)  │
                          │        ├─ fix review issues       │
                          │        ├─ commit & push           │
                          │        └─ PR creation             │
                          └──────────────────────────────────┘
                                         │
                              notify agent via /hooks/agent
                                         │
                          Agent relays result to Telegram
```

SelfAssembler uses feedback mode by default: Claude Code (primary) does the work, Codex (secondary) reviews it, and Claude incorporates the feedback. This happens for research, planning, plan review, and code review phases. For high-stakes tasks, switch to full debate mode (`mode: debate`) where both agents generate independently and exchange critiques.

## Tools

| Tool | Description |
|------|-------------|
| `claw2pr_run_task` | Start a new task (repo + description). Returns a task ID. |
| `claw2pr_task_status` | Check progress: current phase, elapsed time, log tail, PR URL. |
| `claw2pr_list_tasks` | List all tasks with summary info. Filter by status. |
| `claw2pr_cancel_task` | Kill a running task (SIGTERM → SIGKILL). |
| `claw2pr_resume_task` | Resume a failed/cancelled task from its last SelfAssembler checkpoint. |
| `claw2pr_setup_status` | Check all dependencies and config. |

## Supported repos

- **GitHub repos** — cloned via HTTPS with a configured PAT. On completion, SelfAssembler pushes a feature branch and opens a PR.
- **Local repos** — cloned from an absolute path (e.g. `/var/lib/openclaw/code/my-project`). PR creation is skipped; the feature branch is committed locally.

## Project structure

```
claw2pr/
├── index.ts                  # Plugin entry — registers 6 tools
├── openclaw.plugin.json      # Plugin manifest with config schema
├── package.json
├── src/
│   ├── tools.ts              # Tool definitions (params, execute)
│   ├── process-manager.ts    # Spawn/track/kill background tasks
│   ├── task-store.ts         # Persistent JSON task state, auto-cleanup
│   └── notifier.ts           # POST to /hooks/agent on completion
├── scripts/
│   └── run-task.sh           # Clone → configure → GritGuard → SelfAssembler (supports resume via RESUME_CHECKPOINT)
├── templates/
│   └── selfassembler.yaml    # Default SA config (feedback mode, no approvals)
├── GritGuard/                # Submodule — bubblewrap sandbox wrapper
└── SelfAssembler/            # Submodule — multi-phase coding orchestrator
```

## Configuration

In `openclaw.json` under `plugins.entries.claw2pr.config`:

```json
{
  "ghToken": "ghp_...",
  "gitUserName": "<your-git-username>",
  "gitUserEmail": "<your-git-email>",
  "defaultBudget": 15,
  "maxConcurrentTasks": 2,
  "selfassemblerVenv": "/var/lib/openclaw/.openclaw/selfassembler-venv",
  "envFile": "/path/to/.env",
  "useSubscriptionAuth": true
}
```

| Key | Description |
|-----|-------------|
| `ghToken` | GitHub PAT for cloning private repos and creating PRs |
| `gitUserName` / `gitUserEmail` | Git identity for commits |
| `defaultBudget` | USD limit per task (default 15) |
| `maxConcurrentTasks` | Concurrent task cap (default 2) |
| `selfassemblerVenv` | Path to the Python venv with SelfAssembler installed |
| `envFile` | Optional `.env` file with API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) passed to task processes |
| `useSubscriptionAuth` | When `true`, strip `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from the task environment so Claude/Codex CLIs use their stored subscription credentials instead of API keys (default: `false`) |

## Setup

Prerequisites: the OpenClaw service must be running as the `openclaw` user.

1. **Install sandbox runtime**: `sudo npm install -g @anthropic-ai/sandbox-runtime`
2. **Ensure CLIs are globally available**: `claude`, `codex`, `srt`, `gh` in `/usr/local/bin/`
3. **Create SelfAssembler venv**:
   ```bash
   sudo -u openclaw python3 -m venv /var/lib/openclaw/.openclaw/selfassembler-venv
   sudo -u openclaw /var/lib/openclaw/.openclaw/selfassembler-venv/bin/pip install -e ./SelfAssembler
   ```
4. **Install plugin** — either symlink or copy into extensions:
   ```bash
   # Option A: symlink (for development)
   sudo -u openclaw ln -s /path/to/claw2pr /var/lib/openclaw/.openclaw/extensions/claw2pr
   # Make sure openclaw can traverse the symlink:
   chmod o+x /path/to /path/to/parent

   # Option B: copy (for production)
   sudo -u openclaw cp -r /path/to/claw2pr /var/lib/openclaw/.openclaw/extensions/claw2pr
   ```
5. **Register plugin in `openclaw.json`**:
   ```json
   {
     "plugins": {
       "allow": ["claw2pr"],
       "load": {
         "paths": ["/var/lib/openclaw/.openclaw/extensions/claw2pr"]
       },
       "entries": {
         "claw2pr": {
           "enabled": true,
           "config": {
             "ghToken": "ghp_...",
             "gitUserName": "<your-git-username>",
             "gitUserEmail": "<your-git-email>",
             "useSubscriptionAuth": true
           }
         }
       }
     }
   }
   ```
   The plugin exposes its tools automatically — the agent will see `claw2pr_run_task`, `claw2pr_task_status`, etc. once loaded.
6. **Enable hooks** (for task completion notifications):
   ```json
   {
     "hooks": {
       "enabled": true,
       "token": "<generate-a-random-token>"
     }
   }
   ```
   Without hooks, the agent won't be notified when tasks finish.
7. **Create workspace**: `sudo -u openclaw mkdir -p /var/lib/openclaw/.openclaw/workspace/claw2pr-tasks`
8. **Auth setup** — the CLIs need credentials accessible to the `openclaw` user:
   - **API key mode**: set `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the `envFile`
   - **Subscription mode**: copy your CLI OAuth credentials to the openclaw user's home and set `"useSubscriptionAuth": true`:
     ```bash
     sudo cp ~/.claude/.credentials.json /var/lib/openclaw/.claude/.credentials.json
     sudo cp ~/.codex/auth.json /var/lib/openclaw/.codex/auth.json
     sudo chown openclaw:openclaw /var/lib/openclaw/.claude/.credentials.json /var/lib/openclaw/.codex/auth.json
     sudo chmod 600 /var/lib/openclaw/.claude/.credentials.json /var/lib/openclaw/.codex/auth.json
     ```
     OAuth tokens expire (~24h), so set up a periodic sync (cron/systemd timer) from your user.
9. **Restart**: `sudo systemctl restart openclaw`
10. **Verify**: ask the agent to run `claw2pr_setup_status` — all checks should be green

## Task lifecycle

1. Agent calls `claw2pr_run_task` with repo URL and task description
2. Plugin spawns `run-task.sh` as a detached process (survives OpenClaw restarts)
3. Script clones repo, patches config, runs SelfAssembler through GritGuard
4. SelfAssembler goes through ~15 phases with feedback mode
5. On completion, script writes `status.json` and POSTs to `/hooks/agent`
6. Agent wakes up and relays the result (PR URL or error) to Telegram
7. Workspaces auto-clean after 7 days

### Resuming failed tasks

SelfAssembler saves checkpoints after each phase. When a task fails (e.g., at `test_execution` after exhausting fix iterations), the agent can resume it:

1. Agent calls `claw2pr_resume_task` with the failed task's ID
2. Plugin extracts the checkpoint ID from the task log (e.g., `checkpoint_898bf920`)
3. `run-task.sh` is spawned in resume mode (`RESUME_CHECKPOINT` env var):
   - Skips clone and config (repo and worktree already exist)
   - Appends to the existing task log
   - Passes `--resume <checkpoint>` to SelfAssembler through GritGuard
4. SelfAssembler picks up from the failed phase with a fresh budget

## Lessons learned

Things that broke during development and the fixes applied. See `CLAUDE.md` for the full annotated list with error messages.

### Sandbox (srt/bwrap) issues

- **SA state directory read-only**: SA writes checkpoints to `~/.local/state/selfassembler/`, blocked by sandbox. Fix: add `$HOME/.local/state` to GritGuard `base.json` allowWrite.
- **Worktree path outside writable area**: SA's `.worktrees` defaulted outside the sandbox writable zone. Fix: set `worktree_dir: "./.worktrees"` (inside repo).
- **Git dirty worktree fails preflight**: copying `selfassembler.yaml` makes the tree dirty. Fix: commit `.gitignore` for SA artifacts before running.
- **Local repo push fails**: `git push` to a local origin (path-based) fails — origin path not writable in bwrap. Fix: disable `pr_creation` and `pr_self_review` phases for local repos.
- **Subscription auth**: Claude Code and Codex use OAuth, not API keys. Auth files must be accessible inside the sandbox. GritGuard allowWrite includes `$HOME/.claude` and `$HOME/.codex`. Tokens expire (~24h) — set up periodic sync.

### Docker mode issues

- **selfassembler not found in container**: SA venv is bind-mounted but not on PATH. Fix: wrapper script (`.sa-wrapper.sh`) prepends venv bin to PATH.
- **GitHub CLI missing/not authenticated**: Docker image lacks `gh` or auth. SA preflight fails. Fix: install `gh` in image, or skip gh check for local repos.
- **Git dubious ownership**: Docker runs as root, repo owned by host user. Fix: `git config --global --add safe.directory '*'` in wrapper.
- **Permission denied on venv writes**: Wrapper tried pip install into read-only mounted venv. Fix: use system pip (`/usr/bin/pip3 --break-system-packages`) for project deps.
- **Root-owned files block host user**: Docker runs as root, creating `root:root` files in the bind-mounted workspace. Fix: `.sa-wrapper.sh` detects the host UID/GID and runs `chown -R` on EXIT to restore ownership.
- **Local repo origin inaccessible**: Local origins point to host paths that don't exist in container. Fix: SA preflight now detects and removes unreachable local-path origins automatically. run-task.sh also rewrites origin to a real GitHub remote URL when available as a fallback.

### OpenClaw integration

- **Symlink traversal**: openclaw needs `o+x` on parent dirs. `/home/<user>` → `0701`, `/home/<user>/agent` → `0755`.
- **Claude CLI copied, not symlinked**: nvm path unreachable by openclaw. Copy binary to `/usr/local/bin/claude`.
- **Hook sessionKey**: Use `sessionKey: "main"` for unsandboxed agent notification.
- **Plugin manifest**: Newer OpenClaw requires `openclaw.plugin.json` with config schema.
