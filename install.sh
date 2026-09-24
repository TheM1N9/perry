#!/bin/sh
# Perry installer for macOS and Linux (and WSL).
#
#   curl -fsSL https://raw.githubusercontent.com/TheM1N9/me-bot/main/install.sh | sh
#
# Installs what Perry needs that is missing (Node.js, pnpm, Bun and the Codex
# CLI; none of it needs root), gets Perry into ~/perry, installs its packages,
# and runs `perry setup`, which sets up your own Convex deployment and Telegram
# bot, connects this computer, starts Perry in the background and opens the
# dashboard. Safe to run again: it updates what is there.
#
# PERRY_DIR, PERRY_REPO and PERRY_BRANCH change where it goes and what it
# fetches. PERRY_NO_SETUP=1 stops after installing, with the perry command linked.

set -eu

REPO="${PERRY_REPO:-https://github.com/TheM1N9/me-bot.git}"
BRANCH="${PERRY_BRANCH:-main}"
DIR="${PERRY_DIR:-$HOME/perry}"
PERRY_HOME="${PERRY_HOME:-$HOME/.perry}"
# Node and npm packages Perry installs itself live here, so nothing needs sudo.
LOCAL_NODE="$PERRY_HOME/node"
LOCAL_NPM="$PERRY_HOME/npm"

step() { printf '\n\033[36m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m%s\033[0m\n' "$*"; }
fail() { printf '\n  \033[31m%s\033[0m\n  \033[2mFix that, then run the installer again; it picks up where it stopped.\033[0m\n\n' "$*"; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

node_ok() {
  has node && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=9)?0:1)' 2>/dev/null
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

# Keep what was installed on PATH for new terminals and for the background service.
remember_path() {
  line="export PATH=\"$PERRY_HOME/bin:$LOCAL_NPM/bin:$LOCAL_NODE/bin:\$HOME/.bun/bin:\$PATH\"  # added by Perry"
  case "${SHELL:-}" in *zsh) rc="$HOME/.zshrc" ;; *bash) rc="$HOME/.bashrc" ;; *) rc="$HOME/.profile" ;; esac
  for f in "$rc" "$HOME/.profile"; do
    [ -f "$f" ] && grep -q "added by Perry" "$f" && continue
    printf '\n%s\n' "$line" >> "$f"
  done
}

printf '\n\033[1mInstalling Perry\033[0m\n'
step "Tools"
export PATH="$PERRY_HOME/bin:$LOCAL_NPM/bin:$LOCAL_NODE/bin:$HOME/.bun/bin:$PATH"
has curl || fail "curl is needed. Install it with your package manager, then run this again."
if ! has git; then
  if [ "$(uname -s)" = Darwin ]; then xcode-select --install 2>/dev/null || true; fail "Git is needed; macOS is offering to install it. Run this again once that finishes."; fi
  fail "Git is needed. Install it with your package manager (for example: sudo apt install git), then run this again."
fi
ok "git $(git --version | sed 's/git version //')"
node_ok || { printf '  installing Node.js 22\n'; install_node; }
node_ok || fail "Perry needs Node.js 20.9 or newer."
ok "node $(node --version)"
has pnpm || { printf '  installing pnpm\n'; npm install -g --prefix "$LOCAL_NPM" pnpm@10 >/dev/null || fail "Installing pnpm failed."; }
ok "pnpm $(pnpm --version)"
if ! has bun; then
  printf '  installing Bun\n'
  # Bun's own installer needs unzip, which a fresh Linux often lacks; its npm package does not.
  if has unzip; then curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || fail "Installing Bun failed."
  else npm install -g --prefix "$LOCAL_NPM" bun >/dev/null || fail "Installing Bun failed."; fi
fi
ok "bun $(bun --version)"
has codex || { printf '  installing the Codex CLI\n'; npm install -g --prefix "$LOCAL_NPM" @openai/codex >/dev/null || fail "Installing Codex failed."; }
ok "codex"
remember_path

step "Perry, in $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only || fail "Updating Perry failed."
elif [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  fail "$DIR exists and is not a Perry checkout. Move it, or set PERRY_DIR to another folder."
else
  git clone --branch "$BRANCH" "$REPO" "$DIR" || fail "Downloading Perry failed."
fi
cd "$DIR"
pnpm install --frozen-lockfile || fail "Installing packages failed."
ok "packages installed"

if [ "${PERRY_NO_SETUP:-}" = 1 ]; then
  bun --cwd "$DIR" "$DIR/scripts/perry.ts" link
  printf '\n  \033[32mInstalled.\033[0m Run \033[1mperry setup\033[0m in a new terminal to finish.\n\n'
elif [ -r /dev/tty ]; then
  # Piped into sh, this script's stdin is the script itself; setup asks questions, so it reads the terminal.
  bun --cwd "$DIR" "$DIR/scripts/perry.ts" setup </dev/tty
else
  bun --cwd "$DIR" "$DIR/scripts/perry.ts" setup
fi
