#!/usr/bin/env bash
# verify-feature.sh — the gate. The ONLY thing that may write `passing`.
#
# Runs a feature's layers in order, stops at the first failure and prints that
# layer's `repair` rather than the raw error, and on a full pass records what it
# actually read as evidence. An agent setting `passing` by hand is the failure
# mode this exists to remove.
#
#   bash <harness directory>/scripts/verify-feature.sh F-001
#
# The harness directory is the one this script sits in, and the repository is
# the directory above it: nothing here writes either name down. Paths come from
# the CLI beside it; the manifest's other values from the manifest beside it.
set -euo pipefail

FEATURE="${1:-}"
[ -n "$FEATURE" ] || { echo "usage: verify-feature.sh <feature-id>" >&2; exit 2; }

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$(dirname "$HARNESS")"
CLI="$HARNESS/bin/bb-harness.mjs"
MANIFEST="$HARNESS/harness.json"

# Exit 3 from `path` is an answer, not an error: the manifest keeps no feature
# list. Then there is nothing for a feature to pass in, and this says so.
code=0
FEATURES="$(node "$CLI" path features 2>/dev/null)" || code=$?
if [ "$code" = 3 ]; then
  echo "no feature list is kept here (paths.features is not in the manifest), so there is nothing to mark passing"
  exit 0
elif [ "$code" != 0 ]; then
  echo "verify-feature: the harness CLI could not say where the feature list is (exit $code):" >&2
  node "$CLI" path features >&2 || true
  exit 2
fi

layers_json="$(node -e '
  const fs=require("fs");
  const raw=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const list=Array.isArray(raw)?raw:(raw.features??[]);
  const f=list.find(x=>x.id===process.argv[2]);
  if(!f){console.error("no feature "+process.argv[2]);process.exit(3)}
  const m=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));
  process.stdout.write(JSON.stringify(f.layers??m.verify?.layers??[]));
' "$FEATURES" "$FEATURE" "$MANIFEST")"

count="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).length))' "$layers_json")"
[ "$count" -gt 0 ] || { echo "$FEATURE has no layers[] — verification would prove nothing" >&2; exit 4; }

LOG="$(mktemp)"; trap 'rm -f "$LOG"' EXIT
echo "verifying $FEATURE — $count layer(s)"

i=0
while [ "$i" -lt "$count" ]; do
  label="$(node -e 'const l=JSON.parse(process.argv[1])[+process.argv[2]];process.stdout.write(l.label??"layer")' "$layers_json" "$i")"
  cmd="$(  node -e 'const l=JSON.parse(process.argv[1])[+process.argv[2]];process.stdout.write(l.cmd??"")'      "$layers_json" "$i")"
  repair="$(node -e 'const l=JSON.parse(process.argv[1])[+process.argv[2]];process.stdout.write(l.repair??"(no repair recorded)")' "$layers_json" "$i")"

  case "$cmd" in
    ""|*CHANGE-ME*)
      echo "  [SKIP] $label — command not filled in"
      echo "         a layer nobody wrote is not a layer that passed" >&2
      exit 5 ;;
  esac

  echo "  [....] $label: $cmd"
  if ! bash -c "$cmd" >>"$LOG" 2>&1; then
    echo "  [FAIL] $label"
    echo
    echo "  repair: $repair"
    echo
    tail -20 "$LOG"
    exit 1
  fi
  echo "  [PASS] $label"
  i=$((i + 1))
done

# Evidence is the point. Record what ran, when, and the tail of what it said —
# so a later reader can tell a verified feature from a remembered one.
#
# The state goes under the name the list already uses. A list that says
# `status` (backlog-burner's does) used to get `state` written beside it, so a
# verified feature carried both keys and the stale one stayed in the file.
node -e '
  const fs=require("fs");
  const [file,id,log]=process.argv.slice(1);
  const raw=JSON.parse(fs.readFileSync(file,"utf8"));
  const list=Array.isArray(raw)?raw:raw.features;
  const f=list.find(x=>x.id===id);
  const tail=fs.readFileSync(log,"utf8").trim().split("\n").slice(-6).join(" | ");
  const keys=["state","status"].filter(k=>k in f);
  if(keys.length===0) keys.push(list.some(x=>"status" in x&&!("state" in x))?"status":"state");
  for(const k of keys) f[k]="passing";
  f.evidence=`verified ${new Date().toISOString().slice(0,10)} at ${(process.env.GIT_COMMIT||"local").slice(0,7)}: all layers passed. tail: ${tail.slice(0,400)}`;
  fs.writeFileSync(file, JSON.stringify(raw,null,2)+"\n");
' "$FEATURES" "$FEATURE" "$LOG"

echo "  $FEATURE -> passing, evidence recorded in $FEATURES"
