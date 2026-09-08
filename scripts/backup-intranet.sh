#!/usr/bin/env bash
set -euo pipefail
umask 077

if (( $# > 1 )); then
  printf 'Usage: %s [deployment-directory]\n' "$0" >&2
  exit 2
fi

deployment=$(realpath -e -- "${1:-/home/yzq/apps/lab-planning}")
test -f "$deployment/.env.intranet"
test -f "$deployment/current/compose.intranet.yaml"
backups="$deployment/backups"
mkdir -p -- "$backups"

# All invocations for this deployment share one lock, including manual backups.
exec 9>> "$backups/.backup.lock"
if ! flock -n 9; then
  printf 'Another backup is running for %s\n' "$deployment" >&2
  exit 1
fi

compose=(docker compose --env-file "$deployment/.env.intranet" -f "$deployment/current/compose.intranet.yaml")
name="lab-planning-$(date -u +%Y%m%dT%H%M%S.%NZ)-$$.sqlite"
volume_backup="/app/data/backups/$name"

# The application performs SQLite online backup and verifies integrity before returning.
"${compose[@]}" exec -T app sh -c 'umask 077; exec npm run backup -- "$1"' backup "$volume_backup"

# Reserve our staging file exclusively; never overwrite a previous backup or partial file.
set -o noclobber
partial="$backups/$name.partial"
: > "$partial"
trap 'rm -f -- "$partial"' EXIT
"${compose[@]}" exec -T app cat -- "$volume_backup" >| "$partial"
test -s "$partial"

# A same-directory hard link publishes the complete copy atomically and refuses replacement.
ln -T -- "$partial" "$backups/$name"
printf '%s Backup saved: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$backups/$name"
