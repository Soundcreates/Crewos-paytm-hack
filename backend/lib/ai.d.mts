export interface AIUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type AIUsageCallback = (usage: AIUsage) => Promise<unknown> | unknown;

export interface Base64Bytes extends Uint8Array {
  toString(encoding: 'base64'): string;
}

export function llmJson(
  system: string,
  input: string,
  fallback: unknown,
  apiKey?: string | null,
  onUsage?: AIUsageCallback,
  modelOverride?: string,
): Promise<unknown>;

export function embed(
  text: string,
  apiKey?: string | null,
  onUsage?: AIUsageCallback,
): Promise<number[] | null>;

export function describeImage(
  bytes: Base64Bytes,
  mimeType: string,
  apiKey?: string | null,
  onUsage?: AIUsageCallback,
): Promise<string>;

export function transcribeAudio(
  bytes: Uint8Array,
  filename: string,
  apiKey?: string | null,
): Promise<string>;
