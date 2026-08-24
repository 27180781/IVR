#!/usr/bin/env bash
#
# Deploy the current branch onto this server.
#
#   cd /opt/ivr && sudo ./scripts/deploy.sh
#
# Pulls, rebuilds, and restarts. The restart is graceful: the application
# drains calls in progress before exiting, so a deploy does not cut anyone off
# mid-sentence. That does mean a deploy can take a couple of minutes if the
# line is busy - which is the correct trade.
#
# Asterisk itself is only touched when asterisk/ actually changed.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${DEPLOY_BRANCH:-$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD)}"
SERVICE="ivr-app"
SERVICE_USER="ivr"

step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
die()  { printf '\n\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo ./scripts/deploy.sh)"
cd "${REPO_ROOT}"

#-----------------------------------------------------------------------------
step "Fetching ${BRANCH}"
#-----------------------------------------------------------------------------
BEFORE="$(git rev-parse HEAD)"

# Refuse to deploy on top of uncommitted edits: they would be silently
# clobbered, and nobody would know which code is actually running.
if ! git diff --quiet || ! git diff --cached --quiet; then
  die "the working tree has uncommitted changes - commit or stash them first"
fi

for attempt in 1 2 3 4; do
  if git fetch origin "${BRANCH}"; then break; fi
  [[ ${attempt} -eq 4 ]] && die "could not fetch after 4 attempts"
  info "fetch failed, retrying in $((2 ** attempt))s"
  sleep $((2 ** attempt))
done

git checkout -q "${BRANCH}"
git merge --ff-only "origin/${BRANCH}"
AFTER="$(git rev-parse HEAD)"

if [[ "${BEFORE}" == "${AFTER}" ]]; then
  info "already at $(git rev-parse --short HEAD) - nothing to deploy"
  exit 0
fi
info "$(git rev-parse --short "${BEFORE}") -> $(git rev-parse --short "${AFTER}")"
git --no-pager log --oneline "${BEFORE}..${AFTER}" | sed 's/^/    /'

#-----------------------------------------------------------------------------
step "Building"
#-----------------------------------------------------------------------------
# Build BEFORE stopping anything. A broken build must not take the phone line
# down - if this fails, the old process is still serving calls.
npm ci --no-audit --no-fund
npm run typecheck
npm run build
info "build ok"

#-----------------------------------------------------------------------------
step "Asterisk configuration"
#-----------------------------------------------------------------------------
if git diff --name-only "${BEFORE}" "${AFTER}" -- asterisk/ | grep -q .; then
  info "asterisk/ changed, redeploying it"
  "${REPO_ROOT}/scripts/deploy-asterisk.sh"
else
  info "unchanged, leaving Asterisk alone"
fi

#-----------------------------------------------------------------------------
step "Restarting ${SERVICE}"
#-----------------------------------------------------------------------------
ARI_APP="$(grep -E '^ARI_APP=' .env 2>/dev/null | cut -d= -f2- || true)"
ARI_APP="${ARI_APP:-ivr-app}"

# "Is the process up" is not the test that matters. A process that starts but
# never registers with Asterisk answers no calls at all, and looks perfectly
# healthy to systemd. Registration is the real check.
healthy() {
  systemctl is-active --quiet "${SERVICE}" || return 1
  for _ in 1 2 3 4 5 6; do
    if asterisk -rx 'ari show apps' 2>/dev/null | grep -qx "${ARI_APP}"; then return 0; fi
    sleep 2
  done
  return 1
}

chown -R "${SERVICE_USER}:${SERVICE_USER}" "${REPO_ROOT}"
info "restarting - calls in progress are allowed to finish first, so this"
info "may take up to SHUTDOWN_DRAIN_TIMEOUT_MS if the line is busy"
systemctl restart "${SERVICE}"

if healthy; then
  echo
  echo "deployed $(git rev-parse --short HEAD) successfully - ${ARI_APP} is registered"
  exit 0
fi

#-----------------------------------------------------------------------------
step "Deploy failed - rolling back to ${BEFORE:0:7}"
#-----------------------------------------------------------------------------
# A phone line that does not answer is worse than a phone line running last
# week's code, so getting back to a known-good state comes before diagnosis.
journalctl -u "${SERVICE}" -n 40 --no-pager | sed 's/^/    /'

git reset --hard "${BEFORE}"
npm ci --no-audit --no-fund
npm run build
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${REPO_ROOT}"
systemctl restart "${SERVICE}"

if healthy; then
  echo
  die "deploy of ${AFTER:0:7} failed; rolled back to ${BEFORE:0:7}, which is serving calls"
fi

echo
die "deploy failed AND rollback failed - the line is down, intervene now"
