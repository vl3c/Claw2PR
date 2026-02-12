#!/bin/bash
# run-task.sh — Clone repo, configure git, run SelfAssembler through GritGuard
#
# Environment variables (set by process-manager.ts):
#   TASK_ID, REPO_URL, TASK_DESCRIPTION, TASK_NAME, BASE_BRANCH, BUDGET
#   TASK_DIR, LOG_FILE, GRITGUARD_PATH, SA_VENV, SA_TEMPLATE
#   GH_TOKEN, GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL
#   HOOK_TOKEN, PLUGIN_DIR
#   Optional: ANTHROPIC_API_KEY, OPENAI_API_KEY (stripped when useSubscriptionAuth is enabled)
#   Optional: RESUME_CHECKPOINT — when set, resume from this checkpoint instead of starting fresh

set -euo pipefail

# Ensure task directory exists
mkdir -p "$TASK_DIR"

# Redirect all output to log file (append in resume mode to preserve history)
if [[ -n "${RESUME_CHECKPOINT:-}" ]]; then
    exec >> "$LOG_FILE" 2>&1
    echo ""
    echo "========================================"
    echo "=== RESUMING FROM CHECKPOINT ==="
    echo "========================================"
else
    exec > "$LOG_FILE" 2>&1
fi

echo "=== Claw2PR Task: $TASK_ID ==="
echo "Repo:   $REPO_URL"
echo "Task:   $TASK_DESCRIPTION"
echo "Name:   $TASK_NAME"
echo "Branch: $BASE_BRANCH"
echo "Budget: \$$BUDGET"
echo "Started: $(date -Iseconds)"
echo ""

REPO_DIR="$TASK_DIR/repo"
STATUS_FILE="$TASK_DIR/status.json"

# Write initial status
write_status() {
    local status="$1"
    local message="${2:-}"
    local pr_url="${3:-}"
    cat > "$STATUS_FILE" <<STATUSEOF
{
  "status": "$status",
  "message": "$message",
  "prUrl": "$pr_url",
  "finishedAt": "$(date -Iseconds)"
}
STATUSEOF
}

# Notify agent on completion
notify() {
    local message="$1"
    if [[ -n "${HOOK_TOKEN:-}" ]]; then
        payload=$(python3 - "$message" <<'PY'
import json
import sys

msg = sys.argv[1] if len(sys.argv) > 1 else ""
print(json.dumps({
    "message": msg,
    "name": "Claw2PR",
    "wakeMode": "now",
    "deliver": True,
    "channel": "telegram",
    "sessionKey": "main",
}))
PY
        )
        curl -s -X POST "http://127.0.0.1:18789/hooks/agent" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $HOOK_TOKEN" \
            -d "$payload" || echo "[notify] Failed to send hook notification"
    fi
}

# Cleanup on failure
on_error() {
    local exit_code=$?
    echo ""
    echo "=== TASK FAILED (exit code: $exit_code) ==="
    echo "Failed at: $(date -Iseconds)"
    write_status "failed" "Task failed with exit code $exit_code"
    notify "Claw2PR task '$TASK_NAME' FAILED (task $TASK_ID). Check logs for details."
    exit $exit_code
}
trap on_error ERR

if [[ -n "${RESUME_CHECKPOINT:-}" ]]; then
    # ─── Resume mode: skip clone and config ─────────────────────
    echo "=== RESUME MODE ==="
    echo "Checkpoint: $RESUME_CHECKPOINT"
    echo ""
    echo "Skipping steps 1-2 (repo and config already exist from original run)"
    cd "$REPO_DIR"
    export GIT_TERMINAL_PROMPT=0
else
    # ─── Step 1: Clone / copy repository ─────────────────────────
    echo "=== Step 1: Preparing repository ==="

    export GIT_TERMINAL_PROMPT=0

    if [[ "$REPO_URL" == /* ]]; then
        # Local repo — clone from local path
        echo "Local repo detected: $REPO_URL"
        git clone --branch "$BASE_BRANCH" "$REPO_URL" "$REPO_DIR" 2>&1 || {
            # If branch doesn't exist, clone default branch
            echo "Branch '$BASE_BRANCH' not found, cloning default branch..."
            git clone "$REPO_URL" "$REPO_DIR" 2>&1
        }
        echo "Cloned local repo to $REPO_DIR"
    else
        # Remote repo — clone from GitHub with credentials
        # Keep secrets out of .git/config by deferring $GH_TOKEN expansion to helper runtime.
        git_cred_helper='!f() { echo "protocol=https"; echo "host=github.com"; echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f'
        git -c "credential.helper=$git_cred_helper" clone --branch "$BASE_BRANCH" "$REPO_URL" "$REPO_DIR"
        echo "Cloned remote repo to $REPO_DIR"
    fi

    # Configure git identity in the cloned repo
    cd "$REPO_DIR"
    git config user.name "$GIT_AUTHOR_NAME"
    git config user.email "$GIT_AUTHOR_EMAIL"

    # Set up credential helper for pushes (remote repos)
    if [[ "$REPO_URL" != /* ]]; then
        # Store helper with literal $GH_TOKEN so the token itself is not persisted in .git/config.
        git config credential.helper '!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f'
    fi

    # Docker mode: local repo origins point to host paths that won't exist in the
    # container. Rewrite origin to the real GitHub remote URL if available,
    # otherwise remove origin entirely so preflight doesn't fail on fetch.
    if [[ "$REPO_URL" == /* ]] && [[ -n "${GRITGUARD_DOCKER_IMAGE:-}" ]]; then
        REMOTE_URL=$(git -C "$REPO_URL" remote get-url origin 2>/dev/null || true)
        if [[ -n "$REMOTE_URL" ]] && [[ "$REMOTE_URL" == https://* || "$REMOTE_URL" == git@* ]]; then
            git remote set-url origin "$REMOTE_URL"
            git config credential.helper '!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f'
            echo "Docker mode: rewrote origin to $REMOTE_URL"
        else
            git remote remove origin 2>/dev/null || true
            echo "Docker mode: removed local origin (no reachable remote URL)"
        fi
    fi

    echo ""

    # ─── Step 2: Copy SelfAssembler config ─────────────────────
    echo "=== Step 2: Configuring SelfAssembler ==="

    cp "$SA_TEMPLATE" "$REPO_DIR/selfassembler.yaml"

    # Override base_branch in the config (use | delimiter to avoid issues with / in branch names)
    sed -i "s|base_branch: \"main\"|base_branch: \"$BASE_BRANCH\"|" "$REPO_DIR/selfassembler.yaml"

    # For local repos, disable PR creation phases (no GitHub remote to push to)
    if [[ "$REPO_URL" == /* ]]; then
        sed -i '/^  pr_creation:/,/^  [a-z]/{s/enabled: true/enabled: false/}' "$REPO_DIR/selfassembler.yaml"
        sed -i '/^  pr_self_review:/,/^[a-z]/{s/enabled: true/enabled: false/}' "$REPO_DIR/selfassembler.yaml"
        echo "Disabled pr_creation and pr_self_review for local repo"
    fi

    # Ensure SelfAssembler artifacts are gitignored so preflight passes
    if ! grep -qxF 'selfassembler.yaml' "$REPO_DIR/.gitignore" 2>/dev/null; then
        printf '\n# SelfAssembler artifacts\nselfassembler.yaml\nlogs/\nplans/\n.worktrees/\n.sa-wrapper.sh\n*.egg-info/\n' >> "$REPO_DIR/.gitignore"
        git add .gitignore && git commit -m "chore: gitignore selfassembler artifacts"
        echo "Added selfassembler artifacts to .gitignore"
    fi

    echo "Config copied and patched (base_branch=$BASE_BRANCH)"
    echo ""
fi

# ─── Step 3: Activate SelfAssembler venv ───────────────────
echo "=== Step 3: Activating SelfAssembler venv ==="

if [[ -f "$SA_VENV/bin/activate" ]]; then
    source "$SA_VENV/bin/activate"
    echo "Activated venv: $SA_VENV"
else
    echo "ERROR: SelfAssembler venv not found at $SA_VENV"
    exit 1
fi

# Verify selfassembler is available
if ! command -v selfassembler &>/dev/null; then
    echo "ERROR: selfassembler command not found after venv activation"
    exit 1
fi
echo "selfassembler version: $(selfassembler --version 2>&1 || echo 'unknown')"
echo ""

# ─── Step 4: Run SelfAssembler through GritGuard ──────────
echo "=== Step 4: Running SelfAssembler through GritGuard ==="

if [[ -n "${GRITGUARD_DOCKER_IMAGE:-}" ]]; then
    # Docker mode: selfassembler lives in the host venv, which is mounted
    # into the container. We need to prepend the venv bin to PATH inside
    # the container so the selfassembler binary is found.
    # Enable writable mode so the AI agent can pip install project deps.
    export GRITGUARD_DOCKER_WRITABLE=1
    echo "Docker mode: image=$GRITGUARD_DOCKER_IMAGE, venv=$SA_VENV"

    # Write a wrapper script to avoid shell escaping issues with task descriptions.
    # gritguard-docker passes argv safely to the container; the wrapper sets up
    # PATH and env vars, then execs selfassembler with the original arguments.
    # Note: gritguard-docker strips --repo from args, so we pass repo path
    # as a positional arg to the wrapper and add --repo inside it.
    WRAPPER="$REPO_DIR/.sa-wrapper.sh"
    cat > "$WRAPPER" << 'WRAPPER_EOF'
#!/bin/bash
SA_VENV_BIN="$1"; shift
REPO_PATH="$1"; shift
export PATH="$SA_VENV_BIN:$PATH"
export GH_TOKEN="$1"; shift
export GIT_AUTHOR_NAME="$1"; shift
export GIT_AUTHOR_EMAIL="$1"; shift
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
# Set HOME to match host user so Claude/Codex find their credentials
export HOME="/var/lib/openclaw"
# Docker runs as root — restore file ownership to the host user on exit.
# Detect the original owner from the repo dir (created by host user before Docker).
TASK_BASE="$(dirname "$REPO_PATH")"
OWNER_UID=$(stat -c %u "$TASK_BASE")
OWNER_GID=$(stat -c %g "$TASK_BASE")
restore_ownership() {
    chown -R "$OWNER_UID:$OWNER_GID" "$TASK_BASE" 2>/dev/null || true
}
trap restore_ownership EXIT
# Docker runs as root but repo is owned by host user — tell git it's safe
git config --global --add safe.directory "$REPO_PATH"
# Also mark worktree subdirectory as safe
git config --global --add safe.directory "$REPO_PATH/.worktrees"
# Auto-install project dependencies using system pip (not venv pip).
# The SA venv is mounted read-only from host; use /usr/bin/pip3 instead.
cd "$REPO_PATH"
if [ -f requirements.txt ]; then
    /usr/bin/pip3 install --break-system-packages -q -r requirements.txt 2>&1 | tail -3
fi
if [ -f pyproject.toml ]; then
    /usr/bin/pip3 install --break-system-packages -q -e ".[dev]" 2>/dev/null || \
    /usr/bin/pip3 install --break-system-packages -q -e . 2>/dev/null || true
fi
selfassembler "$@" --repo "$REPO_PATH"
WRAPPER_EOF
    chmod +x "$WRAPPER"

    if [[ -n "${RESUME_CHECKPOINT:-}" ]]; then
        echo "RESUME mode: checkpoint=$RESUME_CHECKPOINT"
        echo "Command: $GRITGUARD_PATH bash .sa-wrapper.sh ... --resume $RESUME_CHECKPOINT --repo $REPO_DIR"
        [[ -n "${SKIP_PHASES:-}" ]] && echo "Skip phases: $SKIP_PHASES"
        echo ""

        "$GRITGUARD_PATH" \
            bash "$WRAPPER" \
            "$SA_VENV/bin" \
            "$REPO_DIR" \
            "$GH_TOKEN" \
            "$GIT_AUTHOR_NAME" \
            "$GIT_AUTHOR_EMAIL" \
            --resume "$RESUME_CHECKPOINT" \
            --no-approvals \
            --budget "$BUDGET" \
            ${SKIP_PHASES:+--skip-phases "$SKIP_PHASES"} \
            --repo "$REPO_DIR"
    else
        echo "Command: $GRITGUARD_PATH bash -c 'export PATH=$SA_VENV/bin:\$PATH && selfassembler ...' --repo $REPO_DIR"
        echo ""

        "$GRITGUARD_PATH" \
            bash "$WRAPPER" \
            "$SA_VENV/bin" \
            "$REPO_DIR" \
            "$GH_TOKEN" \
            "$GIT_AUTHOR_NAME" \
            "$GIT_AUTHOR_EMAIL" \
            "$TASK_DESCRIPTION" \
            --name "$TASK_NAME" \
            --no-approvals \
            --budget "$BUDGET" \
            --repo "$REPO_DIR"
    fi
else
    # srt/bwrap mode: venv was activated on the host, selfassembler is in PATH
    if [[ -n "${RESUME_CHECKPOINT:-}" ]]; then
        echo "RESUME mode: checkpoint=$RESUME_CHECKPOINT"
        echo "Command: $GRITGUARD_PATH selfassembler --resume $RESUME_CHECKPOINT --repo $REPO_DIR --no-approvals --budget $BUDGET"
        [[ -n "${SKIP_PHASES:-}" ]] && echo "Skip phases: $SKIP_PHASES"
        echo ""

        "$GRITGUARD_PATH" \
            selfassembler \
            --resume "$RESUME_CHECKPOINT" \
            --repo "$REPO_DIR" \
            --no-approvals \
            --budget "$BUDGET" \
            ${SKIP_PHASES:+--skip-phases "$SKIP_PHASES"}
    else
        echo "Command: $GRITGUARD_PATH selfassembler \"$TASK_DESCRIPTION\" --name $TASK_NAME --repo $REPO_DIR --no-approvals --budget $BUDGET"
        echo ""

        "$GRITGUARD_PATH" \
            selfassembler "$TASK_DESCRIPTION" \
            --name "$TASK_NAME" \
            --repo "$REPO_DIR" \
            --no-approvals \
            --budget "$BUDGET"
    fi
fi

echo ""
echo "=== SelfAssembler completed ==="

# ─── Step 5: Extract results ─────────────────────────────
echo "=== Step 5: Extracting results ==="

PR_URL=""
BRANCH_NAME=""

if [[ "$REPO_URL" == /* ]]; then
    # Local repo — extract branch name from worktree
    BRANCH_NAME=$(cd "$REPO_DIR" && git branch --list 'feature/*' | head -1 | sed 's/^[* ]*//')
    echo "Local repo — branch: $BRANCH_NAME"
else
    # Remote repo — extract PR URL from log
    if PR_URL=$(grep -oE 'https://github\.com/[^[:space:]]+/pull/[0-9]+' "$LOG_FILE" | tail -1) && [[ -n "$PR_URL" ]]; then
        echo "PR URL: $PR_URL"
    else
        echo "No PR URL found in output (task may not have created a PR)"
    fi
fi

# ─── Step 6: Write final status and notify ─────────────────
echo ""
echo "=== Task completed successfully ==="
echo "Finished at: $(date -Iseconds)"

write_status "completed" "Task completed successfully" "$PR_URL"

if [[ -n "$PR_URL" ]]; then
    notify "Claw2PR task '$TASK_NAME' completed! PR: $PR_URL (task $TASK_ID)"
elif [[ -n "$BRANCH_NAME" ]]; then
    notify "Claw2PR task '$TASK_NAME' completed on local repo. Branch: $BRANCH_NAME (task $TASK_ID)"
else
    notify "Claw2PR task '$TASK_NAME' completed (no PR created). Task $TASK_ID"
fi
