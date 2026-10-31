type RepositoryDatabase = {
  all: (sql: string, ...params: unknown[]) => Promise<any[]>;
  get: (sql: string, ...params: unknown[]) => Promise<any>;
  run: (sql: string, ...params: unknown[]) => Promise<any>;
};

type DomainRepository = Record<string, (...params: any[]) => any>;

export function createApplicationRepositories(database: RepositoryDatabase): Record<string, DomainRepository>;
export const repositories: Record<string, DomainRepository>;
