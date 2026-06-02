---
description: Ship the current uncommitted changes through full verification — test, commit, push staging, watch CI, fast-forward main, push, deploy verify, smoke
allowed-tools: Bash, Read, Edit
argument-hint: <commit message — required>
---

Ship the current uncommitted changes end-to-end. Use this argument as the commit message: $ARGUMENTS

If no argument provided, ask for one. Don't proceed without it.

## Steps (run in order, halt on failure)

### 1. Pre-flight
- `git status -sb` — confirm there are staged or modified files relevant to the change.
- `npx tsc --noEmit` in `client/` — must be clean.
- `cd server && npx jest` — must pass with zero failures.

### 2. Stage carefully
- Stage ONLY the files relevant to this commit. Do not stage pre-existing untracked junk (`.gitignore`, `package.json`, `scripts/`, etc. that were modified at session start unless they're part of THIS change).
- Show the diff stat with `git diff --cached --stat` and confirm it matches expectation.

### 3. Commit
- Use the heredoc form:
  ```
  git commit -m "$(cat <<'EOF'
  <type>(<scope>): <subject line, ≤72 chars>

  <body — paragraphs explaining what + why, file references, test counts>

  Tests: <local jest count> pass, <typecheck status>.
  EOF
  )"
  ```
- NEVER add `Co-Authored-By: Claude`, "Generated with", or 🤖. Strip if generated.

### 4. Push to staging
- `git push origin staging`
- The post-push hook will print the deploy reminder.

### 5. Watch staging CI
- `gh run list --branch staging -L 1 --json databaseId,status` to get the run id.
- `gh run watch <run-id> --exit-status` — must exit 0.
- If it fails, fix immediately and re-push. Never leave a broken build.

### 6. Fast-forward main
- `git checkout main && git merge staging --ff-only && git push origin main && git checkout staging`
- If FF fails (main has commits not on staging), STOP and ask the user.

### 7. Watch main CI
- Same pattern. Must exit 0.

### 8. Verify deploys
- Render: pull the latest deploy via API and confirm status=live and commit matches pushed HEAD.
- Vercel: `vercel ls 2>&1 | grep Production | head -1` — confirm Ready, age <2m.
- API health: `curl -s https://api.rsn.network/health` — status ok.

### 9. Smoke
- Sentry server 24h count — should be 0 unresolved.
- App: `curl -s -o /dev/null -m 10 -w "HTTP %{http_code} | %{time_total}s\n" https://app.rsn.network`.

### 10. Report
Concise table of all checks with timestamp, deployed commit SHA, and bottom line. Match the format used by /checkhole.

## Important rules
- No AI attribution in any pushed text.
- Never skip hooks (`--no-verify`) — fix root cause if a hook fails.
- Never force-push to main.
- If CI fails after push, diagnose + fix + re-push until green.
- After main is pushed, the post-push hook fires the deploy reminder; treat it as the trigger to run step 8 verification.
