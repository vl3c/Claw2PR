---
name: coding
description: "Autonomous coding tasks. Delegate feature work, bug fixes, or refactors to a sandboxed agent pipeline that produces PRs or local branches."
---

# Coding Tool

Delegate coding work to an autonomous pipeline: clone repo, research, plan, implement, test, review, and produce a PR or local branch. Uses SelfAssembler with debate mode (Claude + Codex) inside a GritGuard sandbox.

## When to Use

- User asks to implement a feature, fix a bug, or refactor code in a repository
- Task is well-scoped and can be described in a single paragraph
- Work should happen in the background without blocking conversation

Do NOT use for quick edits, questions about code, or tasks that need interactive back-and-forth.

## Workflow

1. Run `coding_setup_status` first if unsure whether dependencies are configured
2. Start a task with `coding_run_task`
3. Inform the user that the task is running (typical runtime: 20-40 minutes)
4. When notified of completion, relay the result (PR URL or branch name)

The user can ask for status updates at any time — use `coding_task_status`.

## Starting a Task

### GitHub repository

```json
{
  "repo": "https://github.com/owner/repo",
  "task": "Add input validation to the /api/users endpoint. Reject emails without @ and passwords shorter than 8 characters. Return 400 with a JSON error body. Add unit tests.",
  "taskName": "input-validation",
  "budget": 15
}
```

A feature branch is created and a PR is opened automatically.

### Local repository

```json
{
  "repo": "/var/lib/openclaw/code/my-project",
  "task": "Refactor the database module to use connection pooling. Add tests.",
  "taskName": "db-pooling"
}
```

No PR is created. The result is a local `feature/*` branch in the cloned workspace.

## Writing Good Task Descriptions

Be specific. Include:
- What to change and where (files, modules, endpoints)
- Acceptance criteria (tests must pass, specific behavior expected)
- Constraints (don't break existing API, keep backwards compatibility)

Bad: "Fix the bug"
Good: "Fix the race condition in src/worker.ts where concurrent requests can double-increment the counter. Add a mutex or atomic operation. Add a test that spawns 100 concurrent increments and asserts the final count."

## Checking Status

```json
{ "taskId": "ct-abc123-def456" }
```

Returns: current phase, elapsed time, last 30 log lines, PR URL (if available).

Phases run in order: preflight, setup, research, planning, implementation, test_writing, test_execution, code_review, fix_review_issues, lint_check, documentation, final_verification, commit_prep, conflict_check, pr_creation.

## Budget

Default: $15 USD per task. For large repos or complex features, increase to $25-30. For small targeted fixes, $5-10 is sufficient. The pipeline stops if the budget is exhausted mid-phase.

## Listing and Cancelling

List all tasks:
```json
{ "status": "running" }
```

Cancel a stuck or unwanted task:
```json
{ "taskId": "ct-abc123-def456" }
```

## Notifications

On completion or failure, a notification is delivered automatically. Relay the result to the user:
- Success: include the PR URL or branch name
- Failure: summarize the error and suggest the user check logs or retry with a revised task description

## Limitations

- Maximum 2 concurrent tasks (configurable)
- OAuth tokens for Claude/Codex expire ~24h — tasks may fail if tokens are stale
- Local repos skip PR creation (no remote to push to)
- Sandbox restricts network access to known domains (GitHub, npm, PyPI, AI APIs)
- Debate mode adds ~10 minutes but improves quality for research/planning/review phases
