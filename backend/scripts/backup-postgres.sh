#!/bin/sh
set -eu
: "${DATABASE_URL:?Set DATABASE_URL}"
if [ "$#" -ne 1 ]; then
  echo 'Usage: backup-postgres.sh /secure/path/backup.dump' >&2
  exit 2
fi
umask 077
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-acl --file="$1"
