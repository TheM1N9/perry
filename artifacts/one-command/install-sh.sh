#!/bin/sh
# sh artifacts/one-command/install-sh.sh <install.sh> <repo> <branch> <outDir>
# <repo> is a clone that has <branch>; a git worktree will not do, since its
# .git points at a path Linux may not be able to follow.
# Linux (WSL is fine). Runs install.sh twice with an empty HOME and a bare
# PATH, as on a fresh machine with only git and curl, and PERRY_NO_SETUP=1,
# since setup needs a browser and a person. Everything it writes stays under
# that HOME, which is deleted at the end.
#
# Ways install.sh could fail on Linux, and what catches each:
#   1. No Node, or Node it cannot verify: it must install Node 20.9+ into
#      ~/.perry/node from Node's own build, checked against its SHA-256.
#   2. A tool that needs sudo, or Bun's installer failing without unzip:
#      pnpm and Codex must end up in ~/.perry/npm, and Bun in ~/.bun (its
#      own installer) or ~/.perry/npm (without unzip), with no root.
#   3. Perry not fetched or not installed: this branch cloned into ~/perry,
#      with its packages.
#   4. No perry command, or one that only works in the checkout:
#      ~/.perry/bin/perry help must work from another folder.
#   5. New terminals lose the tools: one "added by Perry" PATH line in the
#      shell's startup file, not two after a second run.
#   6. A second run fails.
set -u
INSTALLER=$1; REPO=$2; BRANCH=$3; OUT=$4
T=$(mktemp -d)
H="$T/home"; mkdir -p "$H"
run() {
  env -i HOME="$H" PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin TERM=dumb \
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' \
    PERRY_REPO="$REPO" PERRY_BRANCH="$BRANCH" PERRY_NO_SETUP=1 sh "$INSTALLER" </dev/null
}
run > "$T/first.log" 2>&1; first=$?
run > "$T/second.log" 2>&1; second=$?
P="$H/.perry"
node_v=$("$P/node/bin/node" --version 2>/dev/null || echo none)
node_ok=$([ -x "$P/node/bin/node" ] && "$P/node/bin/node" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=9)?0:1)' && echo true || echo false)
tools_ok=$([ -x "$P/npm/bin/pnpm" ] && { [ -x "$P/npm/bin/bun" ] || [ -x "$H/.bun/bin/bun" ]; } && [ -x "$P/npm/bin/codex" ] && echo true || echo false)
bun_from=$([ -x "$H/.bun/bin/bun" ] && echo "bun.sh installer" || echo "npm package")
cloned=$([ "$(git -C "$H/perry" rev-parse --abbrev-ref HEAD 2>/dev/null)" = "$BRANCH" ] && [ -f "$H/perry/node_modules/next/package.json" ] && echo true || echo false)
help=$(cd /tmp && env -i HOME="$H" PATH="$P/node/bin:/usr/bin:/bin" "$P/bin/perry" help 2>&1)
help_ok=$(printf '%s' "$help" | grep -q uninstall && echo true || echo false)
lines=$(cat "$H/.profile" "$H/.bashrc" "$H/.zshrc" 2>/dev/null | grep -c "added by Perry")
checksum=$(grep -c "checksum" "$T/first.log")
passed=$([ $first = 0 ] && [ $second = 0 ] && [ "$node_ok" = true ] && [ "$tools_ok" = true ] && [ "$cloned" = true ] && [ "$help_ok" = true ] && [ "$lines" = 1 ] && echo true || echo false)
mkdir -p "$OUT"
cat > "$OUT/install-sh-result.json" <<EOF
{
  "ranAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "system": "$(uname -sm)",
  "checks": {
    "firstRunSucceeds": $([ $first = 0 ] && echo true || echo false),
    "secondRunSucceeds": $([ $second = 0 ] && echo true || echo false),
    "installsVerifiedNode": $node_ok,
    "toolsWithoutRoot": $tools_ok,
    "clonesAndInstalls": $cloned,
    "perryCommandWorksAnywhere": $help_ok,
    "onePathLine": $([ "$lines" = 1 ] && echo true || echo false)
  },
  "notes": { "node": "$node_v", "bunFrom": "$bun_from", "pathLines": $lines, "checksumFailures": $checksum },
  "passed": $passed
}
EOF
sed "s#$T#<scratch>#g" "$T/first.log" > "$OUT/install-sh-first-run.log"
cat "$OUT/install-sh-result.json"
rm -rf "$T"
[ "$passed" = true ]
