#!/usr/bin/env sh
set -eu

backup_dir="${1:-./backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="${backup_dir}/amber-${timestamp}.dump"
mkdir -p "$backup_dir"
trap 'rm -f "$backup_file"' EXIT

docker compose exec -T postgres pg_dump \
  --username=amber --dbname=amber --format=custom --no-owner --no-acl \
  > "$backup_file"

test -s "$backup_file"
docker compose exec -T postgres pg_restore --list < "$backup_file" >/dev/null
trap - EXIT
printf '%s\n' "Backup created and archive structure verified: $backup_file"
