declare module 'node:path' {
  export function resolve(...paths: string[]): string;
}

declare module 'node:url' {
  export function pathToFileURL(path: string): URL;
}

declare module 'node:net' {
  export function isIP(input: string): 0 | 4 | 6;
}

declare module 'node:dns/promises' {
  interface LookupOptions {
    all: true;
    verbatim: true;
  }

  interface LookupAddress {
    address: string;
    family: number;
  }

  export function lookup(hostname: string, options: LookupOptions): Promise<LookupAddress[]>;
}

declare module 'node:buffer' {
  export interface Buffer extends Uint8Array {
    subarray(begin?: number, end?: number): Buffer;
    toString(encoding?: string): string;
  }

  export const Buffer: {
    concat(chunks: readonly Uint8Array[]): Buffer;
    from(value: string | Uint8Array, encoding?: string): Buffer;
  };
}

declare module 'node:http' {
  import type { Buffer } from 'node:buffer';

  export interface IncomingMessage extends AsyncIterable<Buffer> {
    statusCode?: number;
    headers: Record<string, string | string[] | undefined>;
  }

  export interface ClientRequest {
    on(event: 'error', listener: (error: Error) => void): ClientRequest;
    end(body?: string): void;
  }
}

declare module 'node:https' {
  import type { IncomingMessage, ClientRequest } from 'node:http';

  export function request(
    url: URL,
    options: Record<string, unknown>,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest;
}

declare module 'node:crypto' {
  import type { Buffer } from 'node:buffer';

  interface Cipher {
    update(value: string, inputEncoding: 'utf8'): Buffer;
    final(): Buffer;
    getAuthTag(): Buffer;
  }

  interface Decipher {
    update(value: Uint8Array): Buffer;
    final(): Buffer;
    setAuthTag(value: Uint8Array): void;
  }

  export function createCipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): Cipher;
  export function createDecipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): Decipher;
  export function randomBytes(size: number): Buffer;
  export function scryptSync(password: string, salt: string, keyLength: number): Buffer;
}
