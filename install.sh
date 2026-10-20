#!/usr/bin/env bash
# Docker Notes - one-command installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/CTAGRAM/docker-notes-app/main/install.sh | bash
#
# Installs Git and Docker if they are missing, starts Docker if it isn't running,
# downloads (or updates) the app and starts it. Safe to run again at any time.
#
# Optional settings (environment variables):
#   NOTES_DIR   where to put the app   (default: ~/docker-notes-app)
#   HOST_PORT   port to use            (default: 3000, or the next free port)

set -euo pipefail

REPO="CTAGRAM/docker-notes-app"
REPO_URL="https://github.com/$REPO.git"
TARBALL_URL="https://github.com/$REPO/archive/refs/heads/main.tar.gz"

OS="$(uname -s)"
SUDO=""
BREW=""
GIT=""
DOCKER_APP=""
DS=""          # "sudo " when docker needs root (Linux without docker group)
COMPOSE=""
PORT=""

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }
has()  { command -v "$1" >/dev/null 2>&1; }

fetch() {  # fetch <url>  -> stdout
  if has curl; then curl -fsSL "$1"
  elif has wget; then wget -qO- "$1"
  else die "curl or wget is required."; fi
}

wait_for() {  # wait_for <seconds> <command...>   polls every 3s
  local timeout=$1 waited=0
  shift
  until "$@" >/dev/null 2>&1; do
    if [ "$waited" -ge "$timeout" ]; then printf '\n'; return 1; fi
    printf '.'
    sleep 3
    waited=$((waited + 3))
  done
  printf '\n'
}

pkg_install() {  # pkg_install <package...>   (Linux)
  if   has apt-get; then $SUDO apt-get update -qq && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  elif has dnf;     then $SUDO dnf install -y -q "$@"
  elif has yum;     then $SUDO yum install -y -q "$@"
  elif has pacman;  then $SUDO pacman -Sy --noconfirm --needed "$@"
  elif has zypper;  then $SUDO zypper --non-interactive install "$@"
  elif has apk;     then $SUDO apk add --no-cache "$@"
  else return 1; fi
}

# ---------- Git ----------

find_git() {
  if [ "$OS" = Darwin ]; then
    # /usr/bin/git is only a stub until Apple's Command Line Tools are installed.
    if xcode-select -p >/dev/null 2>&1; then GIT=/usr/bin/git; return 0; fi
    local g
    for g in /opt/homebrew/bin/git /usr/local/bin/git; do
      if [ -x "$g" ]; then GIT="$g"; return 0; fi
    done
    return 1
  fi
  has git && GIT=git
}

ensure_git() {
  find_git && return 0
  say "Git is not installed - installing it..."
  if [ "$OS" = Darwin ]; then
    if [ -n "$BREW" ]; then
      "$BREW" install git || true
    else
      say "A macOS pop-up will ask to install the Command Line Tools (they include Git). Click \"Install\"."
      xcode-select --install >/dev/null 2>&1 || true
      printf 'Waiting for the Command Line Tools to finish installing'
      wait_for 1800 find_git || true
    fi
  else
    pkg_install git || true
  fi
  find_git || warn "Could not install Git automatically - downloading the app without it."
}

# ---------- Docker ----------

find_docker_app() {
  local a
  for a in /Applications/Docker.app "$HOME/Applications/Docker.app"; do
    if [ -d "$a" ]; then DOCKER_APP="$a"; return 0; fi
  done
  return 1
}

install_docker_mac() {
  if [ -n "$BREW" ]; then
    "$BREW" install --cask docker-desktop || "$BREW" install --cask docker || true
    find_docker_app && return 0
  fi
  local arch=amd64 tmp
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then arch=arm64; fi
  tmp="$(mktemp -d)"
  say "Downloading Docker Desktop for Mac (about 600 MB)..."
  curl -fL --progress-bar -o "$tmp/Docker.dmg" "https://desktop.docker.com/mac/main/$arch/Docker.dmg"
  hdiutil attach -nobrowse -quiet -mountpoint "$tmp/mnt" "$tmp/Docker.dmg"
  say "Copying Docker to /Applications (you may be asked for your Mac password)..."
  cp -R "$tmp/mnt/Docker.app" /Applications/ 2>/dev/null || sudo cp -R "$tmp/mnt/Docker.app" /Applications/
  hdiutil detach -quiet "$tmp/mnt" || true
  rm -f "$tmp/Docker.dmg"
  find_docker_app
}

install_docker_linux() {
  say "Docker is not installed - installing it (you may be asked for your password)..."
  if has pacman; then pkg_install docker docker-compose
  elif has apk;  then pkg_install docker docker-cli-compose
  else
    # Docker's official install script (Ubuntu, Debian, Fedora, CentOS, RHEL, Raspberry Pi OS, ...)
    fetch https://get.docker.com | $SUDO sh || pkg_install docker.io || pkg_install docker || true
  fi
}

docker_up() {  # true when the Docker engine answers; picks sudo if needed
  if docker info >/dev/null 2>&1; then DS=""; return 0; fi
  if [ "$OS" != Darwin ] && [ -n "$SUDO" ] && $SUDO -n true 2>/dev/null && $SUDO docker info >/dev/null 2>&1; then
    DS="$SUDO "; return 0
  fi
  return 1
}

start_docker() {
  if [ "$OS" = Darwin ]; then
    say "Docker is not running - opening Docker Desktop..."
    open "$DOCKER_APP"
  else
    say "Docker is not running - starting it..."
    if systemctl --user cat docker-desktop >/dev/null 2>&1; then
      systemctl --user start docker-desktop || true
    elif [ -d /run/systemd/system ]; then
      $SUDO systemctl enable --now docker >/dev/null 2>&1 || $SUDO systemctl start docker || true
    elif [ -x /etc/init.d/docker ]; then
      $SUDO /etc/init.d/docker start >/dev/null 2>&1 || true
    elif has rc-service; then
      $SUDO rc-service docker start || true
    else
      $SUDO sh -c 'nohup dockerd >/var/log/dockerd.log 2>&1 &'
    fi
  fi
}

ensure_docker() {
  if [ "$OS" = Darwin ]; then
    find_docker_app || install_docker_mac || die "Could not install Docker Desktop. Install it from https://www.docker.com/products/docker-desktop/ and run this again."
    # Use Docker Desktop's own tools, even if /usr/local/bin/docker is missing or broken.
    export PATH="$DOCKER_APP/Contents/Resources/bin:$PATH"
  else
    has docker || install_docker_linux
    has docker || die "Could not install Docker. Install it from https://docs.docker.com/engine/install/ and run this again."
  fi

  if ! docker_up; then
    start_docker
    if [ "$OS" = Darwin ]; then
      printf 'Waiting for Docker to start (if Docker Desktop shows a welcome screen or its terms, finish that first)'
    else
      printf 'Waiting for Docker to start'
    fi
    wait_for 300 docker_up || die "Docker did not start. Open Docker Desktop (or start the Docker service), wait until it's running, then run this again."
  fi

  if ${DS}docker compose version >/dev/null 2>&1; then
    COMPOSE="${DS}docker compose"
  else
    if [ "$OS" != Darwin ]; then
      pkg_install docker-compose-plugin >/dev/null 2>&1 || pkg_install docker-compose-v2 >/dev/null 2>&1 || pkg_install docker-compose >/dev/null 2>&1 || true
    fi
    if ${DS}docker compose version >/dev/null 2>&1; then COMPOSE="${DS}docker compose"
    elif has docker-compose; then COMPOSE="${DS}docker-compose"
    else die "Docker Compose is missing. Install it from https://docs.docker.com/compose/install/ and run this again."; fi
  fi
}

# ---------- App ----------

get_code() {
  if [ -n "$GIT" ] && [ -d "$DIR/.git" ]; then
    say "Updating the app in $DIR ..."
    "$GIT" -C "$DIR" pull --ff-only --quiet || warn "Could not update (local changes?) - using the existing copy."
  elif [ -n "$GIT" ] && [ ! -e "$DIR" ]; then
    say "Downloading the app to $DIR ..."
    "$GIT" clone --quiet "$REPO_URL" "$DIR"
  else
    say "Downloading the app to $DIR ..."
    mkdir -p "$DIR"
    fetch "$TARBALL_URL" | tar -xz --strip-components=1 -C "$DIR"
  fi
}

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

choose_port() {
  local port="${HOST_PORT:-}" start
  if [ -z "$port" ] && [ -f .env ]; then
    port="$(sed -n 's/^HOST_PORT=\([0-9][0-9]*\).*/\1/p' .env | tail -n 1)"
  fi
  port="${port:-3000}"
  start=$port
  while port_busy "$port"; do
    port=$((port + 1))
    [ "$port" -le $((start + 50)) ] || die "No free port found near $start. Run again with HOST_PORT=<port>."
  done
  [ "$port" = "$start" ] || warn "Port $start is already in use - using port $port instead."
  { [ -f .env ] && grep -v '^HOST_PORT=' .env || true; echo "HOST_PORT=$port"; } > .env.tmp
  mv .env.tmp .env
  PORT=$port
}

app_ready() { fetch "http://localhost:$PORT/health"; }

main() {
  local had_docker=1
  has docker || had_docker=0
  [ "$OS" = Darwin ] || [ "$OS" = Linux ] || die "This installer supports macOS and Linux. On Windows, use install.ps1 (see the README)."
  if [ "$(id -u)" -ne 0 ] && has sudo; then SUDO="sudo"; fi
  if [ "$OS" = Darwin ]; then
    if has brew; then BREW="brew"
    elif [ -x /opt/homebrew/bin/brew ]; then BREW=/opt/homebrew/bin/brew
    elif [ -x /usr/local/bin/brew ]; then BREW=/usr/local/bin/brew; fi
  fi

  # When run as ./install.sh from inside a downloaded copy, use that copy.
  local self="${BASH_SOURCE[0]:-}" local_dir=""
  if [ -n "$self" ] && [ -f "$self" ] && [ -f "$(dirname "$self")/docker-compose.yml" ]; then
    local_dir="$(cd "$(dirname "$self")" && pwd)"
  fi
  DIR="${NOTES_DIR:-${local_dir:-$HOME/docker-notes-app}}"

  say "Installing Docker Notes"
  if [ -z "$local_dir" ] || [ -n "${NOTES_DIR:-}" ]; then
    ensure_git
  fi
  ensure_docker
  if [ -z "$local_dir" ] || [ -n "${NOTES_DIR:-}" ]; then
    get_code
  fi

  cd "$DIR"
  $COMPOSE down --remove-orphans >/dev/null 2>&1 || true
  choose_port
  say "Building and starting Docker Notes (the first run takes a minute)..."
  $COMPOSE up -d --build

  printf 'Waiting for the app to be ready'
  wait_for 120 app_ready || die "The app did not start. See the logs with:  cd \"$DIR\" && $COMPOSE logs"

  local url="http://localhost:$PORT"
  if [ "$OS" = Darwin ]; then
    open "$url" || true
  elif has xdg-open && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    xdg-open "$url" >/dev/null 2>&1 || true
  fi

  printf '\n\033[1;32mDocker Notes is running at %s\033[0m\n\n' "$url"
  printf '  App folder:  %s\n' "$DIR"
  printf '  Stop it:     cd "%s" && %s down\n' "$DIR" "$COMPOSE"
  printf '  Start again: run this installer again (it also updates the app)\n\n'
  if [ "$OS" = Darwin ] && [ "$had_docker" = 0 ]; then
    printf '  Tip: the "docker" command is not on your PATH. To use it in your terminal, open\n'
    printf '       Docker Desktop > Settings > Advanced and install the CLI tools.\n\n'
  fi
}

main "$@"
