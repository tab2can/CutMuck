#!/usr/bin/env bash
# CutMuck — pull latest from GitHub and rebuild if changed
# Installed as /usr/local/bin/cutmuck-update by install.sh
#
#   sudo cutmuck-update           # git değiştiyse rebuild
#   sudo cutmuck-update --force   # git aynı olsa da rebuild (yarım kalan deploy)

set -euo pipefail

INSTALL_DIR="${CUTMUCK_HOME:-/opt/cutmuck}"
BRANCH="${CUTMUCK_BRANCH:-main}"
COMPOSE_FILE="docker-compose.yml"
LOCK="/var/lock/cutmuck-update.lock"
export COMPOSE_HTTP_TIMEOUT="${COMPOSE_HTTP_TIMEOUT:-180}"
export DOCKER_CLIENT_TIMEOUT="${DOCKER_CLIENT_TIMEOUT:-180}"
export COMPOSE_FILE

log() { printf '[cutmuck-update] %s\n' "$*"; }

FORCE=0
if [[ "${1:-}" == "--force" || "${1:-}" == "--rebuild" ]]; then
  FORCE=1
fi

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

if [[ "${LOCAL}" == "${REMOTE}" && "${FORCE}" != 1 ]]; then
  log "Güncel (${LOCAL:0:7})"
  exit 0
fi

if [[ "${LOCAL}" != "${REMOTE}" ]]; then
  log "Güncelleme: ${LOCAL:0:7} → ${REMOTE:0:7}"
  git checkout "${BRANCH}"
  git pull --ff-only origin "${BRANCH}"
else
  log "Kod güncel (${LOCAL:0:7}) — zorunlu rebuild"
fi

# Re-install updater, then re-exec so this run uses the new files
# (not the copy that started before git pull).
if [[ -f scripts/update.sh ]]; then
  install -m 755 scripts/update.sh /usr/local/bin/cutmuck-update
fi

if [[ "${CUTMUCK_UPDATE_REEXEC:-}" != 1 ]]; then
  export CUTMUCK_UPDATE_REEXEC=1
  exec /usr/local/bin/cutmuck-update --force
fi

# shellcheck disable=SC1091
source "${INSTALL_DIR}/scripts/docker-images.sh"
cutmuck_compose_rebuild
log "Güncelleme tamam"
