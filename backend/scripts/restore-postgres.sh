#!/bin/sh
set -eu
: "${DATABASE_URL:?Set DATABASE_URL to an empty recovery database}"
if [ "$#" -ne 2 ] || [ "$1" != '--confirm-empty-database' ]; then
  echo 'Usage: restore-postgres.sh --confirm-empty-database /secure/path/backup.dump' >&2
  exit 2
fi
tables=$(psql --dbname="$DATABASE_URL" --no-psqlrc --tuples-only --no-align --command="SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
if [ "$tables" != '0' ]; then
  echo 'Recovery target is not empty. Restore into a fresh database or branch.' >&2
  exit 1
fi
pg_restore --exit-on-error --no-owner --no-acl --dbname="$DATABASE_URL" "$2"
