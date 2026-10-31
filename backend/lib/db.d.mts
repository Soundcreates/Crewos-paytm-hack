export function all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
export function get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined>;
export function id(prefix?: string): string;
export function now(): string;
export function run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
export function transaction<T>(fn: () => Promise<T> | T): Promise<T>;
