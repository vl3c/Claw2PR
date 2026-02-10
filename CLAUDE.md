# Claw2PR — Project Rules & Integration Knowledge

## Rules

- Do not add Co-Authored-By, signature lines, or AI attribution to commits, PRs, or code comments

## Architecture Overview

OpenClaw plugin that spawns autonomous coding tasks. The pipeline:
1. Plugin TypeScript code registers 5 tools with OpenClaw
2. `claw2pr_run_task` spawns `scripts/run-task.sh` as a detached process
3. run-task.sh: clone repo → configure SA → GritGuard sandbox → SelfAssembler
4. On completion, POST to `/hooks/agent` with `sessionKey: "main"` (unsandboxed)

Two sandbox modes:
- **srt/bwrap** (default): Host venv activated, GritGuard wraps `srt` — fast, works for local repos
- **Docker** (`dockerImage` config): GritGuard runs `gritguard-docker` — portable, needs wrapper script

## Key Paths (Production)

| What | Path |
|------|------|
| Plugin source (dev) | `/home/<user>/agent/claw2pr/` |
| Extensions symlink | `/var/lib/openclaw/.openclaw/extensions/claw2pr` → source |
| SA venv | `/var/lib/openclaw/.openclaw/selfassembler-venv` |
| Workspace | `/var/lib/openclaw/.openclaw/workspace/claw2pr-tasks/` |
| Task store | `.../claw2pr-tasks/tasks.json` |
| OpenClaw config | `/var/lib/openclaw/.openclaw/openclaw.json` |
| Claude auth | `/var/lib/openclaw/.claude/.credentials.json` |
| Codex auth | `/var/lib/openclaw/.codex/auth.json` |
| Claude CLI | `/usr/local/bin/claude` (copied binary, not symlink) |
| Codex CLI | `/usr/local/bin/codex` (symlink to nvm) |
| srt CLI | `/usr/local/bin/srt` (symlink to npm global) |

## Lessons Learned — Sandbox Issues

### 1. Read-only filesystem: SA state directory
**Error**: `[Errno 30] Read-only file system: '/var/lib/openclaw/.local/state/selfassembler'`
**Root cause**: SelfAssembler writes checkpoints to `~/.local/state/selfassembler/`, which srt/bwrap blocks by default.
**Fix**: Add `$HOME/.local/state` to GritGuard `base.json` → `filesystem.allowWrite`.

### 2. Read-only filesystem: worktree directory outside sandbox
**Error**: `Read-only file system: '.../.worktrees'`
**Root cause**: SA's default worktree path was outside the sandbox writable area (in the task dir, not the repo dir). The sandbox only allows writes inside `--repo` path.
**Fix**: Set `worktree_dir: "./.worktrees"` in selfassembler.yaml — puts worktrees inside the repo (writable).

### 3. Git dirty worktree fails preflight
**Root cause**: Copying `selfassembler.yaml` into the repo before running makes the tree dirty. SA's preflight rejects dirty repos.
**Fix**: Add SA artifacts to `.gitignore` and commit before running SA. See the `.gitignore` block in `run-task.sh` Step 2.

### 4. Local repo push fails in bwrap sandbox
**Error**: `error: remote unpack failed: unable to create temporary object directory`
**Root cause**: `git push` to a local origin (path-based remote) fails because the origin path isn't writable inside the bwrap sandbox.
**Fix**: Disable `pr_creation` and `pr_self_review` phases for local repos (sed in run-task.sh).

### 5. Subscription auth vs API keys
**Context**: Claude Code and Codex use OAuth subscription credentials, NOT API keys.
**Fix**: Auth files (`~/.claude/.credentials.json`, `~/.codex/auth.json`) must be accessible inside the sandbox. GritGuard's `base.json` allowWrite includes `$HOME/.claude` and `$HOME/.codex`. When `useSubscriptionAuth: true`, process-manager strips `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from env so CLIs use stored OAuth.

## Lessons Learned — Docker Mode Issues

### 6. selfassembler not in PATH inside Docker container
**Error**: `exec: "selfassembler": executable file not found in $PATH`
**Root cause**: Docker entry point didn't have the host venv on PATH. The SA venv is bind-mounted from host but PATH wasn't set.
**Fix**: Created `.sa-wrapper.sh` that prepends `$SA_VENV/bin` to PATH before exec'ing selfassembler. gritguard-docker runs `bash .sa-wrapper.sh` instead of `selfassembler` directly.

### 7. GitHub CLI not installed / not authenticated inside Docker
**Error**: `GitHub CLI not installed` or `GitHub CLI not authenticated`
**Root cause**: The Docker image may not have `gh` installed, or it's not authenticated. SA preflight checks for `gh auth status`.
**Fix**: Either install `gh` in the Docker image and mount auth, or configure SA to skip the gh preflight check for local repos.

### 8. Git dubious ownership in Docker container
**Error**: `fatal: detected dubious ownership in repository at '/var/lib/openclaw/.openclaw/workspace/claw2pr-tasks/.../repo'`
**Root cause**: Docker runs as root but the repo was cloned by the host `openclaw` user. Git rejects operations on repos owned by different users.
**Fix**: The wrapper script runs `git config --global --add safe.directory '*'` inside the container.

### 9. Permission denied on venv inside Docker
**Error**: `Permission denied: '/var/lib/openclaw/.openclaw/selfassembler-venv/lib/python3.11/site-packages/...'`
**Root cause**: Wrapper tried to `pip install` into the read-only mounted venv.
**Fix**: Use system pip (`/usr/bin/pip3 install --break-system-packages`) for project deps, NOT the venv pip. The venv is mounted read-only.

### 10. Permission denied on repo logs directory inside Docker
**Error**: `Permission denied: '/.../repo/logs'`
**Root cause**: Docker writable mode wasn't properly configured, or the log directory ownership didn't match.
**Fix**: Set `GRITGUARD_DOCKER_WRITABLE=1` env var before calling gritguard-docker.

### 11. Local repo origin inaccessible from Docker container
**Root cause**: Local repo clones have origin pointing to a host filesystem path (e.g., `/var/lib/openclaw/code/MatHud`). This path doesn't exist inside the Docker container.
**Fix**: In run-task.sh, detect Docker mode + local repo and rewrite origin to the real GitHub remote URL: `git remote set-url origin $REMOTE_URL`.

## Lessons Learned — OpenClaw Integration

### 12. Symlink traversal permissions
**Problem**: openclaw user can't follow symlinks through `/home/<user>/agent/claw2pr`.
**Fix**: Both `/home/<user>` and `/home/<user>/agent` need `o+x` (execute for others). `/home/<user>` has `0701`, `/home/<user>/agent` has `0755`.

### 13. Claude CLI must be copied, not symlinked
**Problem**: nvm-installed Claude CLI lives under `/home/<user>/.nvm/...` — openclaw can't traverse.
**Fix**: Copy the actual binary: `sudo cp $(which claude) /usr/local/bin/claude`. Codex works as a symlink because its nvm path is under the traversable `/home/<user>/agent/.nvm/`.

### 14. Hook notification needs sessionKey: "main"
**Problem**: Default hook sessions are sandboxed — agent can't use skills or full capabilities.
**Fix**: POST to `/hooks/agent` with `sessionKey: "main"` runs on the main unsandboxed session.

### 15. OAuth tokens expire
**Context**: Subscription auth tokens expire (~24h).
**Mitigation**: Set up periodic cron/systemd timer to sync auth from your user to openclaw user.

### 16. Plugin manifest required for newer OpenClaw
**Context**: OpenClaw now requires `openclaw.plugin.json` manifest with config schema.
**File**: `openclaw.plugin.json` defines required/optional config fields with types and defaults.

## Task Statistics (as of Feb 10, 2026)

- 1 successful end-to-end task (toy-calc, local repo, srt/bwrap mode)
- 15 failed tasks (progression of sandbox/Docker fixes)
- Docker mode: reached test_execution phase but tests failed after 5 iterations
- srt/bwrap mode: fully working for local repos

## Development Tips

- Plugin is TypeScript loaded directly (no build step)
- Test changes by restarting openclaw: `sudo systemctl restart openclaw`
- Check plugin load: `sudo journalctl -u openclaw -n 50 | grep claw2pr`
- Task store uses atomic writes (tmp + rename) — same pattern as other plugins
- Files in extensions dir written as openclaw user: `sudo -u openclaw tee`
- `console.log()` in plugin code shows in journalctl
