#!/usr/bin/env bash
# CutMuck — one-command Linux install
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/tab2can/CutMuck/main/scripts/install.sh | sudo bash
# Or with env:
#   CUTMUCK_DOMAIN=cut.example.com CUTMUCK_EMAIL=you@example.com curl -fsSL ... | sudo bash

set -euo pipefail

REPO_URL="${CUTMUCK_REPO:-https://github.com/tab2can/CutMuck.git}"
BRANCH="${CUTMUCK_BRANCH:-main}"
INSTALL_DIR="${CUTMUCK_HOME:-/opt/cutmuck}"
COMPOSE_FILE="docker-compose.yml"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

need_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    red "Bu kurulum root ile çalışmalı (sudo)."
    exit 1
  fi
}

detect_os() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    echo "${ID:-linux}"
  else
    echo "linux"
  fi
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    info "Docker zaten kurulu"
    return
  fi
  info "Docker kuruluyor…"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  if ! docker compose version >/dev/null 2>&1; then
    red "docker compose bulunamadı. Docker Compose v2 gerekli."
    exit 1
  fi
}

ask() {
  local prompt="$1"
  local default="${2:-}"
  local var
  if [[ -n "$default" ]]; then
    read -r -p "$prompt [$default]: " var || true
    echo "${var:-$default}"
  else
    read -r -p "$prompt: " var
    echo "$var"
  fi
}

prompt_config() {
  # curl | bash leaves stdin as the script — read from the real terminal
  if [[ ! -t 0 ]] && [[ -r /dev/tty ]]; then
    exec </dev/tty
  fi

  if [[ -z "${CUTMUCK_DOMAIN:-}" ]]; then
    yellow "Alan adı (A kaydı bu sunucuya işaret etmeli, 80/443 açık olmalı)"
    CUTMUCK_DOMAIN="$(ask "CUTMUCK_DOMAIN (örn. cutmuck.example.com)")"
  fi
  if [[ -z "${CUTMUCK_EMAIL:-}" ]]; then
    CUTMUCK_EMAIL="$(ask "Let's Encrypt e-posta" "admin@${CUTMUCK_DOMAIN}")"
  fi
  if [[ -z "${CUTMUCK_DOMAIN}" ]]; then
    red "CUTMUCK_DOMAIN zorunlu. Örnek:"
    red "  CUTMUCK_DOMAIN=cut.example.com CUTMUCK_EMAIL=you@example.com curl -fsSL ... | sudo bash"
    exit 1
  fi
  # strip scheme / trailing slash
  CUTMUCK_DOMAIN="${CUTMUCK_DOMAIN#https://}"
  CUTMUCK_DOMAIN="${CUTMUCK_DOMAIN#http://}"
  CUTMUCK_DOMAIN="${CUTMUCK_DOMAIN%%/*}"

  ADMIN_EMAIL="${ADMIN_EMAIL:-can@pekgezer.com}"

  # Preserve Google/session secrets on re-install (do not clobber domain just asked)
  if [[ -f "${INSTALL_DIR}/.env" ]]; then
    local _line _k _v
    while IFS= read -r _line || [[ -n "${_line}" ]]; do
      [[ "${_line}" =~ ^(GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|SESSION_SECRET|ADMIN_EMAIL)=(.*)$ ]] || continue
      _k="${BASH_REMATCH[1]}"
      _v="${BASH_REMATCH[2]}"
      if [[ -z "${!_k:-}" ]]; then
        printf -v "${_k}" '%s' "${_v}"
      fi
    done <"${INSTALL_DIR}/.env"
  fi

  yellow "Google Cloud OAuth (Web client) — site girişi için zorunlu"
  yellow "Redirect URI ekleyin: https://${CUTMUCK_DOMAIN}/api/auth/login/callback"
  if [[ -z "${GOOGLE_CLIENT_ID:-}" ]]; then
    GOOGLE_CLIENT_ID="$(ask "GOOGLE_CLIENT_ID")"
  fi
  if [[ -z "${GOOGLE_CLIENT_SECRET:-}" ]]; then
    GOOGLE_CLIENT_SECRET="$(ask "GOOGLE_CLIENT_SECRET")"
  fi
  if [[ -z "${GOOGLE_CLIENT_ID}" || -z "${GOOGLE_CLIENT_SECRET}" ]]; then
    red "GOOGLE_CLIENT_ID ve GOOGLE_CLIENT_SECRET zorunlu (Google ile giriş)."
    exit 1
  fi
  if [[ -z "${SESSION_SECRET:-}" ]]; then
    SESSION_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 32)"
  fi

  export CUTMUCK_DOMAIN CUTMUCK_EMAIL ADMIN_EMAIL GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET SESSION_SECRET
}

clone_or_update() {
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    info "Mevcut kurulum güncelleniyor: ${INSTALL_DIR}"
    git -C "${INSTALL_DIR}" fetch --tags origin
    git -C "${INSTALL_DIR}" checkout "${BRANCH}"
    git -C "${INSTALL_DIR}" pull --ff-only origin "${BRANCH}"
  else
    info "Repo klonlanıyor → ${INSTALL_DIR}"
    mkdir -p "$(dirname "${INSTALL_DIR}")"
    git clone --branch "${BRANCH}" --depth 1 "${REPO_URL}" "${INSTALL_DIR}"
  fi
}

write_env() {
  local env_file="${INSTALL_DIR}/.env"
  cat >"${env_file}" <<EOF
CUTMUCK_DOMAIN=${CUTMUCK_DOMAIN}
CUTMUCK_EMAIL=${CUTMUCK_EMAIL}
CUTMUCK_BRANCH=${BRANCH}
ADMIN_EMAIL=${ADMIN_EMAIL:-can@pekgezer.com}
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
SESSION_SECRET=${SESSION_SECRET}
EOF
  chmod 600 "${env_file}"
  info ".env yazıldı (${env_file})"
}

compose_up() {
  info "Image'lar build edilip başlatılıyor (ilk sefer uzun sürebilir)…"
  cd "${INSTALL_DIR}"
  docker compose -f "${COMPOSE_FILE}" --env-file .env up -d --build
}

install_updater() {
  info "Otomatik güncelleme (systemd timer) kuruluyor…"
  install -m 755 "${INSTALL_DIR}/scripts/update.sh" /usr/local/bin/cutmuck-update

  cat >/etc/systemd/system/cutmuck-update.service <<EOF
[Unit]
Description=CutMuck auto-update from GitHub
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
Environment=CUTMUCK_HOME=${INSTALL_DIR}
Environment=CUTMUCK_BRANCH=${BRANCH}
ExecStart=/usr/local/bin/cutmuck-update
EOF

  cat >/etc/systemd/system/cutmuck-update.timer <<EOF
[Unit]
Description=CutMuck daily update check

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=1h

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now cutmuck-update.timer
}

print_done() {
  green ""
  green "CutMuck kuruldu"
  green "URL:  https://${CUTMUCK_DOMAIN}"
  yellow "DNS A kaydı → bu sunucu IP | firewall: 80/tcp, 443/tcp"
  yellow "Yönetici: ${ADMIN_EMAIL:-can@pekgezer.com} (Google ile giriş)"
  yellow "Google OAuth redirect URI:"
  printf '  https://%s/api/auth/login/callback\n' "${CUTMUCK_DOMAIN}"
  yellow "YouTube OAuth redirect URI:"
  printf '  https://%s/api/auth/youtube/callback\n' "${CUTMUCK_DOMAIN}"
  info "Güncelleme: cutmuck-update  (timer: cutmuck-update.timer)"
  info "Loglar:     docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} logs -f"
}

main() {
  need_root
  info "OS: $(detect_os)"
  command -v curl >/dev/null || { apt-get update -y && apt-get install -y curl ca-certificates git; }
  command -v git >/dev/null || { apt-get update -y && apt-get install -y git; }
  install_docker
  prompt_config
  clone_or_update
  write_env
  compose_up
  install_updater
  print_done
}

main "$@"
