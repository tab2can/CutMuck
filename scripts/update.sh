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

ensure_base_image() {
  local name="$1"
  local mirror="mirror.gcr.io/library/${name}"
  if docker image inspect "${name}" >/dev/null 2>&1; then
    log "Yerel imaj var: ${name}"
    return 0
  fi
  if docker image inspect "${mirror}" >/dev/null 2>&1; then
    docker tag "${mirror}" "${name}"
    log "Ayna imajı etiketlendi: ${name}"
    return 0
  fi
  # Docker Hub often times out from this VPS; try Google's Hub mirror first.
  local src
  for src in "${mirror}" "${name}"; do
    log "docker pull ${src}"
    if docker pull "${src}"; then
      docker tag "${src}" "${name}" 2>/dev/null || true
      return 0
    fi
  done
  log "İmaj çekilemedi: ${name}"
  return 1
}

compose_rebuild() {
  ensure_base_image "node:20-bookworm-slim"
  ensure_base_image "python:3.11-slim-bookworm" || true
  local attempt pull_flag=()
  if docker compose build --help 2>/dev/null | grep -q -- '--pull'; then
    pull_flag=(--pull never)
  fi
  for attempt in 1 2 3; do
    log "compose build (${attempt}/3)"
    if docker compose -f "${COMPOSE_FILE}" --env-file .env build "${pull_flag[@]}"; then
      docker compose -f "${COMPOSE_FILE}" --env-file .env up -d
      return 0
    fi
    log "Build başarısız, 8s sonra tekrar"
    sleep 8
  done
  log "compose build --pull never olmadı, Hub ile son deneme"
  docker compose -f "${COMPOSE_FILE}" --env-file .env up -d --build
}

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

# Re-install updater script in case it changed, then re-exec so this
# run uses the new compose/retry logic (not the copy that started).
if [[ -f scripts/update.sh ]]; then
  install -m 755 scripts/update.sh /usr/local/bin/cutmuck-update
fi

if [[ "${CUTMUCK_UPDATE_REEXEC:-}" != 1 ]]; then
  export CUTMUCK_UPDATE_REEXEC=1
  exec /usr/local/bin/cutmuck-update --force
fi

compose_rebuild
log "Güncelleme tamam"
