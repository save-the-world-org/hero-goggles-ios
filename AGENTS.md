# AGENTS.md: spike-rayban

This file stays at the repo root and stays short. Every agent reads it: Claude
Code through `CLAUDE.md`, which imports it, Codex directly, and Infrared's runner
because its prompt says to. The rules for working here are in `CLAUDE.md` and in
the workspace's `CLAUDE.md` one directory up; this file is the map.

## Where things are

Paths are declared once, in `.infrared/harness.json`. Resolve one rather than
typing it: `node .infrared/bin/bb-harness.mjs path <key>`.

| Key | What it holds | When you read it |
|-----|---------------|------------------|
| `mission` | what this repo is, what is next, how you would know it worked | first, every session |
| `progress` | done, learned, next: append-only and dated | every session; append before you finish |
| `decisions` | where decisions live (ADRs in infrared-docs-internal), and the few too small for one | before proposing something they settle |
| `goldenRules` | the rules a reviewer checks first, each with its source | before the first commit |

`README.md` says what the spike is and how to run it; `docs/findings.md` holds
what was learned about Meta's toolkit, and `docs/screens/` what the simulated
glasses drew. The app is `App/`, its Xcode project `project.yml` (XcodeGen).

## The gate

`make verify` is free and needs no glasses: the harness, shellcheck, the Xcode
project from `project.yml`, and the app built for the iOS Simulator and for a
generic iPhone, unsigned. `make sim` runs it on a simulator with Meta's
simulated glasses and saves screenshots. `make device` signs it with the
person's own team and installs it on their iPhone: theirs to run. There is no
CI.

## How a change lands

Straight to `main` (the manifest's `delivery.mode` is `trunk`, ADR 0019): run the
gate and read its output, `git status`, stage by path, one conventional commit
per change, rebase on `origin/main`, push. Nothing is built or deployed from a
commit. Commit as the allowlisted account this clone is set up for (ADR 0015),
with no AI attribution of any kind.

Inside an Infrared run there is no git: the workspace is a plain copy and the runner commits for you. Skip the git steps. A run has no Xcode: say in your report that the gate could not run; this repo has no CI, so a person runs it.

## Never

| Never | Why |
|-------|-----|
| commit `Config/Signing.local.xcconfig`, or a team ID, `MetaAppID` or client token in a committed file | they are a person's own, and Meta's are an account's |
| register an app in Meta's Wearables Developer Center | it is an account: the owner's decision, with an `accounts/` entry first |
| turn the toolkit's analytics or crash reports on | nothing goes to Meta that need not |
| `git push --force`, delete `main`, `--no-verify`, `git reset --hard`, `git clean -f`, `rm -rf` | it destroys work nobody can get back; `.claude/hooks/guard.mjs` refuses these and says what to do instead |
| `git add -A`, `git add .`, `git commit -a` | the checkouts are shared, and another session's change is not yours to commit |
| edit a file under `.infrared/bin/`, `.infrared/scripts/` or `.claude/` | they are vendored from the harness template at the version in the manifest, and `make verify` fails on a hand edit |
