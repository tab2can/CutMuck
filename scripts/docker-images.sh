#!/usr/bin/env bash
# Pull/tag CutMuck base images without touching Docker Hub.
# Sourced by update.sh and install.sh (not executed directly).
#
# Why: BuildKit/Compose Bake always HEADs the registry named in FROM,
# even when layers are already cached. This VPS times out on
# registry-1.docker.io (~30s DeadlineExceeded). public.ecr.aws hosts the
# same official library images; mirror.gcr.io is the fallback.
#
# Compose v2 treats `--pull` as a boolean flag. `--pull never` is parsed
# as "pull, then build service named never" → "no such service: never".

CUTMUCK_NODE_IMAGE="${CUTMUCK_NODE_IMAGE:-public.ecr.aws/docker/library/node:20-bookworm-slim}"
CUTMUCK_PYTHON_IMAGE="${CUTMUCK_PYTHON_IMAGE:-public.ecr.aws/docker/library/python:3.11-slim-bookworm}"
CUTMUCK_CADDY_IMAGE="${CUTMUCK_CADDY_IMAGE:-public.ecr.aws/docker/library/caddy:2.8-alpine}"

_cutmuck_log() {
  if declare -F log >/dev/null 2>&1; then
    log "$@"
  elif declare -F info >/dev/null 2>&1; then
    info "$@"
  else
    printf '[cutmuck] %s\n' "$*"
  fi
}

_cutmuck_image_ok() {
  docker image inspect "$1" >/dev/null 2>&1
}

_cutmuck_tag_all() {
  local src="$1"
  shift
  local dest
  for dest in "$@"; do
    if [[ "${dest}" == "${src}" ]]; then
      continue
    fi
    docker tag "${src}" "${dest}" 2>/dev/null || true
  done
}

_cutmuck_pull() {
  local ref="$1"
  local attempt
  local pull_cmd=(docker pull "${ref}")
  if command -v timeout >/dev/null 2>&1; then
    pull_cmd=(timeout 120 docker pull "${ref}")
  fi
  for attempt in 1 2 3; do
    _cutmuck_log "docker pull ${ref} (${attempt}/3)"
    if "${pull_cmd[@]}"; then
      return 0
    fi
    sleep $((attempt * 4))
  done
  return 1
}

# Ensure local tags exist for every name Bake/FROM might resolve.
cutmuck_ensure_image() {
  local canonical="$1"
  shift
  local aliases=("$@")
  local all=("${canonical}" "${aliases[@]}")
  local found="" cand src

  for cand in "${all[@]}"; do
    if _cutmuck_image_ok "${cand}"; then
      found="${cand}"
      break
    fi
  done

  if [[ -n "${found}" ]]; then
    _cutmuck_log "Yerel imaj var: ${found} → ${canonical}"
    _cutmuck_tag_all "${found}" "${all[@]}"
    return 0
  fi

  for src in "${canonical}" "${aliases[@]}"; do
    case "${src}" in
      public.ecr.aws/*|mirror.gcr.io/*)
        if _cutmuck_pull "${src}"; then
          _cutmuck_tag_all "${src}" "${all[@]}"
          return 0
        fi
        ;;
    esac
  done

  _cutmuck_log "Uyarı: ${canonical} çekilemedi (Docker Hub denenmeyecek)"
  return 1
}

cutmuck_ensure_node() {
  cutmuck_ensure_image \
    "${CUTMUCK_NODE_IMAGE}" \
    "mirror.gcr.io/library/node:20-bookworm-slim" \
    "node:20-bookworm-slim"
}

cutmuck_ensure_python() {
  cutmuck_ensure_image \
    "${CUTMUCK_PYTHON_IMAGE}" \
    "mirror.gcr.io/library/python:3.11-slim-bookworm" \
    "python:3.11-slim-bookworm"
}

cutmuck_ensure_caddy() {
  cutmuck_ensure_image \
    "${CUTMUCK_CADDY_IMAGE}" \
    "mirror.gcr.io/library/caddy:2.8-alpine" \
    "caddy:2.8-alpine" \
    || true
}

cutmuck_compose_rebuild() {
  local compose_file="${COMPOSE_FILE:-docker-compose.yml}"
  local env_file=".env"
  local attempt
  local services=()
  local compose=(docker compose -f "${compose_file}")
  if [[ -f "${env_file}" ]]; then
    compose+=(--env-file "${env_file}")
  fi

  cutmuck_ensure_node || return 1
  cutmuck_ensure_caddy

  services+=(web)
  if cutmuck_ensure_python; then
    services+=(worker)
  elif docker image inspect cutmuck-worker:latest >/dev/null 2>&1 \
    || docker image inspect cutmuck-worker >/dev/null 2>&1; then
    _cutmuck_log "Python tabanı yok; mevcut worker imajı kullanılacak"
  else
    _cutmuck_log "Python tabanı ve worker imajı yok; worker build zorunlu"
    return 1
  fi

  for attempt in 1 2 3; do
    _cutmuck_log "compose build ${services[*]} (${attempt}/3)"
    if "${compose[@]}" build "${services[@]}"; then
      "${compose[@]}" up -d --no-build --remove-orphans
      return 0
    fi
    _cutmuck_log "Build başarısız, 8s sonra tekrar"
    sleep 8
  done
  return 1
}
