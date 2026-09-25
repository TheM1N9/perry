#!/bin/sh
# sh artifacts/one-command/reuse-tools.sh <install.sh> <repo> <branch> <outDir>
# Linux (WSL is fine). Runs install.sh with PERRY_NO_SETUP=1, each time with
# an empty HOME and a bare PATH, three ways: nothing installed; everything
# installed but only where nvm and Bun keep it, not on PATH; and an old Node
# on PATH. Every HOME is deleted at the end.
#
# Ways the installer could install what is already there, or disturb it:
#   1. Tools kept by a version manager, not on PATH, are missed and installed
#      again: with Node, pnpm and Codex in an nvm folder and Bun in ~/.bun,
#      every tool must say "already installed", and neither ~/.perry/node nor
#      ~/.perry/npm may appear.
#   2. An old Node is replaced, or shadowed in the owner's terminal: Perry
#      gets its own Node in ~/.perry/node, a new login shell must still run the
#      owner's Node, and the perry launcher must put Perry's first.
#   3. The PATH line puts Perry's folders before the owner's, or is written
#      twice when the installer runs again: one line, appending.
#   4. The fresh case breaks: with nothing installed, everything is installed
#      and says so.
set -u
INSTALLER=$1; REPO=$2; BRANCH=$3; OUT=$4
T=$(mktemp -d)
BARE=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
install_with() { # <home> <path>
  env -i HOME="$1" PATH="$2" TERM=dumb \
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' \
    PERRY_REPO="$REPO" PERRY_BRANCH="$BRANCH" PERRY_NO_SETUP=1 sh "$INSTALLER" </dev/null 2>&1 | sed 's/\x1b\[[0-9;]*m//g'
}
says() { printf '%s' "$1" | grep -q "$2"; }

# 4. Fresh, which also gives the tools the next scenario hides.
H1="$T/fresh"; mkdir -p "$H1"
fresh=$(install_with "$H1" "$BARE")
fresh_ok=$(says "$fresh" "node .*(installed for Perry)" && says "$fresh" "pnpm .*(installed for Perry)" && says "$fresh" "codex (installed for Perry)" && says "$fresh" "Installed." && echo true || echo false)

# 1. Everything present, only where nvm and Bun keep it.
H2="$T/managed"; mkdir -p "$H2/.nvm/versions/node"
NODE_V=$("$H1/.perry/node/bin/node" --version)
cp -R "$H1/.perry/node" "$H2/.nvm/versions/node/$NODE_V"
NVM_BIN="$H2/.nvm/versions/node/$NODE_V/bin"
env -i HOME="$H2" PATH="$NVM_BIN:$BARE" npm install -g pnpm@10 @openai/codex >/dev/null 2>&1
if [ -d "$H1/.bun" ]; then cp -R "$H1/.bun" "$H2/.bun"; else mkdir -p "$H2/.bun/bin" && cp -L "$H1/.perry/npm/bin/bun" "$H2/.bun/bin/bun"; fi
managed=$(install_with "$H2" "$BARE")
managed_ok=$(for tool in "node $NODE_V" "pnpm" "bun" "codex"; do says "$managed" "$tool.*(already installed)" || { echo false; exit; }; done; echo true)
managed_nothing_added=$([ ! -e "$H2/.perry/node" ] && [ ! -e "$H2/.perry/npm" ] && ! says "$managed" "installing" && echo true || echo false)

# 2 and 3. An old Node on PATH, the owner's.
H3="$T/old-node"; mkdir -p "$H3/old/bin"
cat > "$H3/old/bin/node" <<'EOF'
#!/bin/sh
case "$1" in --version|-v) echo v18.20.0 ;; -p) echo 18.20.0 ;; *) exit 1 ;; esac
EOF
chmod +x "$H3/old/bin/node"
old=$(install_with "$H3" "$H3/old/bin:$BARE")
again=$(install_with "$H3" "$H3/old/bin:$BARE")
own_node_kept=$(env -i HOME="$H3" PATH="$H3/old/bin:$BARE" sh -c '. "$HOME/.profile" 2>/dev/null; node --version')
old_ok=$(says "$old" "older than Perry needs" && says "$old" "node v2.*(installed for Perry)" && [ -x "$H3/.perry/node/bin/node" ] && echo true || echo false)
launcher_ok=$(grep -q "$H3/.perry/node/bin" "$H3/.perry/bin/perry" && env -i HOME="$H3" PATH="$H3/old/bin:$BARE" "$H3/.perry/bin/perry" help 2>&1 | grep -q uninstall && echo true || echo false)
lines=$(cat "$H3/.profile" "$H3/.bashrc" "$H3/.zshrc" 2>/dev/null | grep -c "added by Perry")
appends=$(grep "added by Perry" "$H3/.profile" | grep -q 'PATH="$PATH:' && echo true || echo false)
again_ok=$(says "$again" "node v2.*Perry's own" && echo true || echo false)

passed=true
for v in "$fresh_ok" "$managed_ok" "$managed_nothing_added" "$old_ok" "$launcher_ok" "$appends" "$again_ok"; do [ "$v" = true ] || passed=false; done
[ "$own_node_kept" = v18.20.0 ] && [ "$lines" = 1 ] || passed=false
mkdir -p "$OUT"
cat > "$OUT/reuse-tools-result.json" <<EOF
{
  "ranAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "system": "$(uname -sm)",
  "checks": {
    "freshInstallsEverything": $fresh_ok,
    "managedToolsFound": $managed_ok,
    "managedNothingInstalled": $managed_nothing_added,
    "oldNodeGetsPrivateCopy": $old_ok,
    "ownerStillRunsOwnNode": $([ "$own_node_kept" = v18.20.0 ] && echo true || echo false),
    "launcherUsesPerrysNode": $launcher_ok,
    "pathLineAppendsOnce": $([ "$appends" = true ] && [ "$lines" = 1 ] && echo true || echo false),
    "secondRunReusesPerrysNode": $again_ok
  },
  "notes": { "nvmNode": "$NODE_V", "ownerNodeInNewShell": "$own_node_kept", "pathLines": $lines },
  "passed": $passed
}
EOF
printf '%s\n' "$managed" | grep -E "already installed|installed for Perry|installing" > "$OUT/reuse-tools-managed.log"
printf '%s\n' "$old" | grep -E "already installed|installed for Perry|installing|older" > "$OUT/reuse-tools-old-node.log"
cat "$OUT/reuse-tools-result.json"
rm -rf "$T"
[ "$passed" = true ]
