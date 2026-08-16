#!/usr/bin/env bash
# CutMuck — pull latest from GitHub and rebuild if changed
# Installed as /usr/local/bin/cutmuck-update by install.sh

set -euo pipefail

INSTALL_DIR="${CUTMUCK_HOME:-/opt/cutmuck}"
BRANCH="${CUTMUCK_BRANCH:-main}"
COMPOSE_FILE="docker-compose.yml"
LOCK="/var/lock/cutmuck-update.lock"

log() { printf '[cutmuck-update] %s\n' "$*"; }

if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
  log "Kurulum bulunamadı: ${INSTALL_DIR}"
  exit 1
fi

exec 9>"${LOCK}"
if ! flock -n 9; then
  log "Başka bir güncelleme çalışıyor, çıkılıyor"
  exit 0
fi

cd "${INSTALL_DIR}"

# Keep .env
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  BRANCH="${CUTMUCK_BRANCH:-$BRANCH}"
fi

git fetch --tags origin
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/${BRANCH}" 2>/dev/null || true)"

if [[ -z "${REMOTE}" ]]; then
  log "Uzak dal yok: origin/${BRANCH}"
  exit 1
fi

if [[ "${LOCAL}" == "${REMOTE}" ]]; then
  log "Güncel (${LOCAL:0:7})"
  exit 0
fi

log "Güncelleme: ${LOCAL:0:7} → ${REMOTE:0:7}"
git checkout "${BRANCH}"
git pull --ff-only origin "${BRANCH}"

# Re-install updater script in case it changed
if [[ -f scripts/update.sh ]]; then
  install -m 755 scripts/update.sh /usr/local/bin/cutmuck-update
fi

docker compose -f "${COMPOSE_FILE}" --env-file .env up -d --build
log "Güncelleme tamam"
