#!/usr/bin/env bash
# clean-state-check.sh — the five dimensions, run at clock-out. Idempotent:
# safe to run repeatedly, changes nothing, exits 0 only when every check that
# can run here holds.
#
# The harness directory is the one this script sits in, and the repository is
# the directory above it: nothing here writes either name down. Paths come from
# the CLI beside it; the manifest's other values from the manifest beside it.
set -uo pipefail
HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(dirname "$HARNESS")"; cd "$ROOT" || exit 2
CLI="$HARNESS/bin/infrared-harness.mjs"
# The harness directory, by the name it was found under, is left out of the
# debug check: its notes are the record, not this work's debris.
EXCLUDE=":(exclude)$(basename "$HARNESS")"

# One manifest value. A missing or empty key prints nothing and fails.
m() { node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,x)=>o?.[x],m);if(v==null||v==="")process.exit(1);process.stdout.write(String(v))' "$HARNESS/harness.json" "$1" 2>/dev/null; }
# shellcheck disable=SC2034  # read inside the verify step's eval string
VERIFY="$(m verify.all)"
# A path, from the CLI. Exit 3 is an answer: this repository keeps no progress log.
progress=0; PROGRESS="$(node "$CLI" path progress 2>/dev/null)" || progress=$?

# A tarball, an export, or a runner that unpacks one, has no git: no history to
# compare this work against, and no index to be clean against. The two checks
# that need it are skipped there, and say so; the others still decide.
nogit=""
if ! command -v git >/dev/null 2>&1; then nogit="git is not installed"
elif [ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" != "true" ]; then nogit="not a git work tree"; fi

# Debug artifacts are what THIS work leaves behind: lines added since the branch
# left the remote's default branch, committed or not, and files git does not
# track yet. A whole-tree grep failed every repository whose code logs on
# purpose (a server's startup line), so a session there was never closable.
# With no base to compare against, the whole tree is searched, as it was.
DEBUG='console\.log\(|TODO: remove|XXX'
debug_artifacts() {
  local base
  base="$(git merge-base HEAD "$(git symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/main)" 2>/dev/null)" \
    || { git grep -nE "$DEBUG" -- . "$EXCLUDE"; return; }
  {
    git diff --no-color --no-ext-diff --no-textconv -U0 "$base" -- . "$EXCLUDE" \
      | awk '/^diff --git /{h=1; next} /^@@/{h=0; next} !h && /^\+/{print substr($0, 2)}'
    git ls-files -z --others --exclude-standard -- . "$EXCLUDE" \
      | while IFS= read -r -d '' f; do cat -- "$f"; done
  } | grep -E "$DEBUG"
}

bad=0
step() { printf '  %-30s' "$1"; if eval "$2" >/dev/null 2>&1; then echo "ok"; else echo "FAIL"; bad=1; fi; }
skip() { printf '  %-30s%s\n' "$1" "skipped: $2"; }

echo "clean state:"
# The verify line fails CLOSED on a missing key: `eval ""` succeeds. It is the
# gate, so a manifest with no verify.all is a FAIL here, never a skip.
step "verify passes"            '[ -n "$VERIFY" ] && eval "$VERIFY"'
# Captured, not piped into `grep -q`: that exits at the first match, the writer
# dies of SIGPIPE, and under pipefail the negated pipeline read as clean.
if [ -z "$nogit" ]; then step "no debug artifacts" '[ -z "$(debug_artifacts 2>/dev/null)" ]'
else skip "no debug artifacts" "$nogit"; fi
# The repo's own copy, beside this script: nothing puts `infrared-harness` on
# PATH in a scaffolded repo. If it is not there, node fails and so does this
# line.
step "harness validates"        'node "$CLI" validate'
case "$progress" in
  0) step "progress appended today" "grep -q \"$(date +%Y-%m-%d)\" \"$PROGRESS\"" ;;
  3) skip "progress appended today" "no progress log is kept here (paths.progress)" ;;
  *) step "progress appended today" 'false' ;;  # the CLI could not answer: fail closed
esac
if [ -z "$nogit" ]; then step "worktree clean" '[ -z "$(git status --porcelain)" ]'
else skip "worktree clean" "$nogit"; fi

[ -z "$nogit" ] || echo "  the two git checks were skipped ($nogit); the others decide"
if [ "$bad" -eq 0 ]; then echo "  session is closable"; else echo "  NOT closable — fix the FAILs above"; fi
exit "$bad"
