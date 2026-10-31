import assert from 'node:assert/strict';
import test from 'node:test';
import { postgresSql, sqliteSql } from '../backend/lib/sql-dialect.mjs';

test('PostgreSQL translation preserves quoted question marks and rewrites supported SQLite syntax', () => {
  assert.equal(
    postgresSql(`INSERT OR IGNORE INTO "events"("createdAt", label) VALUES(?, '?')`),
    "INSERT INTO 'events'('createdAt', label) VALUES($1, '?') ON CONFLICT DO NOTHING",
  );
  assert.equal(
    postgresSql('SELECT AVG((julianday(finished_at)-julianday(started_at))*86400000) FROM workflows WHERE org_id=?'),
    'SELECT AVG(EXTRACT(EPOCH FROM (finished_at::timestamptz - started_at::timestamptz))*1000) FROM workflows WHERE org_id=$1',
  );
});

test('SQLite translation rewrites double-quoted identifiers without changing string literals', () => {
  assert.equal(sqliteSql(`SELECT "createdAt", '?' AS marker FROM 'events'`), "SELECT 'createdAt', '?' AS marker FROM 'events'");
});
