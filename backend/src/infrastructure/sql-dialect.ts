export function postgresSql(sql: string): string {
  let parameter = 0;
  let query = sql.replace(/^\s*INSERT OR IGNORE INTO\b/i, 'INSERT INTO');
  const ignoreConflicts = /^\s*INSERT OR IGNORE INTO\b/i.test(sql);
  query = query.replace(/AVG\(\(julianday\((\w+)\)-julianday\((\w+)\)\)\*86400000\)/i, (_match, end: string, start: string) => `AVG(EXTRACT(EPOCH FROM (${end}::timestamptz - ${start}::timestamptz))*1000)`);
  query = query.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, (token) => {
    if (token === '?') return `$${++parameter}`;
    if (token.startsWith('"')) return `'${token.slice(1, -1).replaceAll('""', '"').replaceAll("'", "''")}'`;
    return token;
  });
  return ignoreConflicts ? `${query.trimEnd()} ON CONFLICT DO NOTHING` : query;
}

export function sqliteSql(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"/g, (token) => token.startsWith('"')
    ? `'${token.slice(1, -1).replaceAll('""', '"').replaceAll("'", "''")}'`
    : token);
}
