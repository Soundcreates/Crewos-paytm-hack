export function getSecret(orgId: string, provider: string): Promise<string | null | undefined>;
export function encryptSecret(secret: string): string;
export function decryptSecret(value: string): string;
export function storeSecret(orgId: string, userId: string, provider: string, secret: string, config?: Record<string, unknown>): Promise<unknown>;
export function replaceSecret(orgId: string, provider: string, secret: string): Promise<void>;
export function removeSecret(orgId: string, provider: string): Promise<void>;
