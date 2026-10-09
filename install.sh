#!/bin/sh
# Perry installer for macOS and Linux (and WSL).
#
#   curl -fsSL https://raw.githubusercontent.com/TheM1N9/perry/main/install.sh | sh
#
# Uses the Node.js, pnpm and Bun you already have, wherever your shell or a
# version manager keeps them, and installs only what is missing, none of it
# needing root. A Node older than Perry needs is left alone: Perry gets its
# own copy in ~/.perry/node. It gets Perry into ~/perry, installs its
# packages, and runs `perry setup`, which sets up a Telegram bot if you want
# one, asks which engine Perry thinks with (Codex, Claude Code, Grok Build or
# Antigravity: it never picks one for you) and offers to install and sign in
# to it, keeps your data in ~/.perry, starts Perry in the background and opens
# the dashboard. Safe to run again: it updates what is there.
#
# PERRY_DIR, PERRY_REPO and PERRY_BRANCH change where it goes and what it
# fetches. --engine (or PERRY_ENGINE) chooses the default engine without
# asking: codex, claude, grok or antigravity. With it, an install with no
# terminal to ask in sets up too:
#
#   curl -fsSL https://raw.githubusercontent.com/TheM1N9/perry/main/install.sh | sh -s -- --engine claude
#
# PERRY_NO_SETUP=1 stops after installing, with the perry command linked.
#
# Just the desktop pet, on another computer, for the Perry on your main one
# (its Settings → Desktop pet → Add a computer shows this line, with its own
# address and a pairing code):
#
#   curl -fsSL https://raw.githubusercontent.com/TheM1N9/perry/main/install.sh | PERRY_PET='http://192.168.1.20:7377 ABCD-EFGH' sh
#
# That needs only Git, Node.js and pnpm, gets only the pet's folder of Perry
# into ~/perry-pet, installs Electron there, and pairs it (pet/connect.js).

set -eu

# --engine <name> is PERRY_ENGINE, which perry setup reads.
while [ $# -gt 0 ]; do
  case "$1" in
    --engine) [ $# -ge 2 ] || { printf '  --engine needs a name: codex, claude, grok or antigravity.\n'; exit 1; }; PERRY_ENGINE=$2; export PERRY_ENGINE; shift 2 ;;
    --engine=*) PERRY_ENGINE=${1#--engine=}; export PERRY_ENGINE; shift ;;
    *) printf '  Unknown option: %s\n' "$1"; exit 1 ;;
  esac
done

REPO="${PERRY_REPO:-https://github.com/TheM1N9/perry.git}"
BRANCH="${PERRY_BRANCH:-main}"
PET="${PERRY_PET:-}"
if [ -n "$PET" ]; then DIR="${PERRY_DIR:-$HOME/perry-pet}"; else DIR="${PERRY_DIR:-$HOME/perry}"; fi
PERRY_HOME="${PERRY_HOME:-$HOME/.perry}"
# Node and npm packages Perry installs itself live here, so nothing needs sudo.
LOCAL_NODE="$PERRY_HOME/node"
LOCAL_NPM="$PERRY_HOME/npm"

# One line per step that went well; a tool's own output only when it fails.
ok() { printf '  \033[32m%s\033[0m\n' "$*"; }
TOOLS=""
found() { TOOLS="${TOOLS:+$TOOLS, }$*"; }
added() { found "$* (new)"; }
note() { printf '  \033[2m%s\033[0m\n' "$*"; }
# Runs a step with its output held back, shown only if it fails.
quietly() {
  what=$1; shift
  printf '  \033[2m%s...\033[0m' "$what"
  if out=$("$@" 2>&1); then printf '\r\033[K'; else printf '\r\033[K%s\n' "$out" | tail -n 20; return 1; fi
}
fail() { printf '\n  \033[31m%s\033[0m\n  \033[2mFix that, then run the installer again; it picks up where it stopped.\033[0m\n\n' "$*"; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }
# After everything already here, so a tool you have always wins over one this script adds.
add_path() { case ":$PATH:" in *":$1:"*) ;; *) PATH="$PATH:$1" ;; esac; }

NODE_OK_JS='const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'
node_ok() { has node && node -e "$NODE_OK_JS" 2>/dev/null; }

# Tools you already have, where a version manager or your shell's startup files keep them rather than
# the PATH this script was started with: Homebrew, Bun, pnpm, Volta, asdf, mise, fnm, nvm, and npm's
# own global folder. Looked for before anything is installed, so nothing you have is installed twice.
find_existing() {
  for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/.bun/bin" "$HOME/.volta/bin" \
    "$HOME/.asdf/shims" "$HOME/.local/share/mise/shims" "$HOME/.local/share/pnpm" "$HOME/Library/pnpm" \
    "$HOME/.local/share/fnm/aliases/default/bin" "$HOME/Library/Application Support/fnm/aliases/default/bin"; do
    [ -d "$d" ] && add_path "$d"
  done
  # An nvm-installed Node new enough for Perry, if the one on PATH is not.
  if ! node_ok; then
    for d in "$HOME"/.nvm/versions/node/*/bin; do
      [ -x "$d/node" ] && "$d/node" -e "$NODE_OK_JS" 2>/dev/null && { add_path "$d"; break; }
    done
  fi
  if has npm; then prefix=$(npm prefix -g 2>/dev/null) && [ -d "$prefix/bin" ] && add_path "$prefix/bin"; fi
  export PATH
}

# Node's own build for this machine, checked against its published SHA-256, into ~/.perry/node.
install_node() {
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail "Unsupported system: $(uname -s). On Windows, use install.ps1." ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) fail "Unsupported processor: $(uname -m)." ;; esac
  base="https://nodejs.org/dist/latest-v22.x"
  line=$(curl -fsSL "$base/SHASUMS256.txt" | grep " node-v.*-$os-$arch.tar.gz\$") || fail "Could not find Node.js for $os-$arch."
  sum=${line%% *}; file=${line##* }
  tmp=$(mktemp -d)
  curl -fsSL "$base/$file" -o "$tmp/$file" || fail "Could not download Node.js."
  if has sha256sum; then got=$(sha256sum "$tmp/$file" | cut -d' ' -f1); else got=$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1); fi
  [ "$got" = "$sum" ] || fail "The Node.js download did not match its checksum."
  rm -rf "$LOCAL_NODE"; mkdir -p "$LOCAL_NODE"
  tar -xzf "$tmp/$file" -C "$LOCAL_NODE" --strip-components=1
  rm -rf "$tmp"
}

# This terminal's own device, such as /dev/ttys003 or /dev/pts/0, for setup to read from. Not /dev/tty:
# macOS cannot poll a file opened through that alias, and Bun, which runs setup, polls its stdin
# ("EINVAL: invalid argument, kqueue"). ps names the terminal this script runs in even with stdin piped.
real_tty() {
  name=$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')
  case "$name" in ""|"?"|"??") return 1 ;; esac
  case "$name" in /dev/*) ;; *) name="/dev/$name" ;; esac
  [ -r "$name" ] && [ -w "$name" ] && printf '%s' "$name"
}

# The perry command, and whatever this script or perry setup installed, on PATH for new terminals. After your own
# PATH, never before it: a Node or pnpm you already have stays the one your terminal runs. Perry's npm folder is
# there even before it exists, for an engine perry setup puts in it.
remember_path() {
  dirs="$PERRY_HOME/bin:$LOCAL_NPM/bin"
  [ -d "$LOCAL_NODE/bin" ] && dirs="$dirs:$LOCAL_NODE/bin"
  line="export PATH=\"\$PATH:$dirs\"  # added by Perry"
  case "${SHELL:-}" in *zsh) rc="$HOME/.zshrc" ;; *bash) rc="$HOME/.bashrc" ;; *) rc="$HOME/.profile" ;; esac
  for f in "$rc" "$HOME/.profile"; do
    # One Perry line per file, replaced when this run installed something an earlier one did not.
    if [ -f "$f" ] && grep -q "added by Perry" "$f"; then
      grep -qxF "$line" "$f" && continue
      grep -v "added by Perry" "$f" > "$f.perry" && mv "$f.perry" "$f"
      printf '%s\n' "$line" >> "$f"
    else
      printf '\n%s\n' "$line" >> "$f"
    fi
  done
}

if [ -n "$PET" ]; then
  printf "\n\033[1mInstalling Perry's desktop pet\033[0m\n"
  # Perry's address and the pairing code, split on spaces.
  set -- $PET
  [ $# -eq 2 ] || fail "PERRY_PET is Perry's address and a pairing code, as its Settings → Desktop pet → Add a computer shows them."
  PET_SERVER=$1; PET_CODE=$2
else
  printf '\n\033[1mInstalling Perry\033[0m\n'
fi
find_existing
# What an earlier run installed for Perry, again after everything you have.
add_path "$LOCAL_NPM/bin"; add_path "$HOME/.bun/bin"; export PATH
has curl || fail "curl is needed. Install it with your package manager, then run this again."
if ! has git; then
  if [ "$(uname -s)" = Darwin ]; then xcode-select --install 2>/dev/null || true; fail "Git is needed; macOS is offering to install it. Run this again once that finishes."; fi
  fail "Git is needed. Install it with your package manager (for example: sudo apt install git), then run this again."
fi
found "git $(git --version | sed 's/git version //')"

if node_ok; then
  found "node $(node --version)"
elif [ -x "$LOCAL_NODE/bin/node" ] && "$LOCAL_NODE/bin/node" -e "$NODE_OK_JS" 2>/dev/null; then
  export PATH="$LOCAL_NODE/bin:$PATH"
  found "node $(node --version), Perry's own"
else
  # Perry's copy is Perry's alone: the Node you have, if any, stays the one your terminal runs.
  has node && note "Your node $(node --version) is older than Perry needs (22.13, for its built-in SQLite); Perry gets its own copy and yours is left as it is."
  printf '  installing Node.js 22\n'; install_node
  export PATH="$LOCAL_NODE/bin:$PATH"
  node_ok || fail "Perry needs Node.js 22.13 or newer."
  added "node $(node --version)"
fi

if has pnpm; then found "pnpm $(pnpm --version)"
else
  printf '  installing pnpm\n'; npm install -g --prefix "$LOCAL_NPM" pnpm@10 >/dev/null || fail "Installing pnpm failed."
  added "pnpm $(pnpm --version)"
fi
if [ -n "$PET" ]; then
  # The pet alone needs neither Bun nor an engine: Perry thinks and works on its own computer.
  remember_path
  ok "$TOOLS"
  # Only pet/ of Perry's files (and the few at the top), and only their latest version: the pet is all this computer runs.
  if [ -d "$DIR/.git" ]; then
    quietly "updating the pet" git -C "$DIR" pull --ff-only || fail "Updating the pet failed."
  elif [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    fail "$DIR exists and is not the pet's folder. Move it, or set PERRY_DIR to another folder."
  else
    quietly "downloading the pet" git clone --depth 1 --filter=blob:none --sparse --branch "$BRANCH" "$REPO" "$DIR" || fail "Downloading the pet failed."
    quietly "picking out his folder" git -C "$DIR" sparse-checkout set pet || fail "Downloading the pet failed."
  fi
  quietly "installing his window and his ears (Electron and ONNX Runtime, under 1 GB)" pnpm install --dir "$DIR/pet" --frozen-lockfile || fail "Installing the pet failed."
  ok "the pet in $DIR"
  node "$DIR/pet/connect.js" "$PET_SERVER" "$PET_CODE" || fail "Pairing failed."
  exit 0
fi
if has bun; then found "bun $(bun --version)"
else
  printf '  installing Bun\n'
  # Bun's own installer needs unzip, which a fresh Linux often lacks; its npm package does not.
  if has unzip; then curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || fail "Installing Bun failed."
  else npm install -g --prefix "$LOCAL_NPM" bun >/dev/null || fail "Installing Bun failed."; fi
  added "bun $(bun --version)"
fi
# No engine here: perry setup asks which one Perry should think with, and installs that one.
remember_path
ok "$TOOLS"

if [ -d "$DIR/.git" ]; then
  quietly "updating Perry" git -C "$DIR" pull --ff-only || fail "Updating Perry failed."
elif [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  fail "$DIR exists and is not a Perry checkout. Move it, or set PERRY_DIR to another folder."
else
  quietly "downloading Perry" git clone --branch "$BRANCH" "$REPO" "$DIR" || fail "Downloading Perry failed."
fi
cd "$DIR"
quietly "installing packages" pnpm install --frozen-lockfile || fail "Installing packages failed."
ok "Perry in $DIR"

if [ "${PERRY_NO_SETUP:-}" = 1 ]; then
  bun --cwd "$DIR" "$DIR/scripts/perry.ts" link
  printf '\n  \033[32mInstalled.\033[0m Run \033[1mperry setup\033[0m in a new terminal to finish.\n\n'
elif [ -t 0 ]; then
  bun --cwd "$DIR" "$DIR/scripts/perry.ts" setup
elif terminal=$(real_tty); then
  # Piped into sh, this script's stdin is the script itself; setup asks questions, so it reads the terminal.
  bun --cwd "$DIR" "$DIR/scripts/perry.ts" setup <"$terminal"
elif [ -n "${PERRY_ENGINE:-}" ]; then
  # No one to ask, and the engine named: setup goes on without questions, skipping what only a person could answer.
  bun --cwd "$DIR" "$DIR/scripts/perry.ts" setup </dev/null
else
  printf '\n  \033[32mInstalled.\033[0m There is no terminal to ask questions in; run \033[1mperry setup\033[0m in one,\n'
  printf '  or this again with \033[1m--engine\033[0m codex, claude, grok or antigravity to set up without questions.\n\n'
  bun --cwd "$DIR" "$DIR/scripts/perry.ts" link
fi
