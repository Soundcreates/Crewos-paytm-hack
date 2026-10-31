export type LlmPurpose = 'chat' | 'embedding' | 'transcription' | 'evaluator';

export function isLocalLlmProvider(): boolean;
export function getLlmBaseUrl(): string;
export function getLlmApiKey(integrationKey?: string | null): string | null;
export function getLlmProviderName(): string;
export function getLlmProviderLabel(): string;
export function getLlmModel(purpose?: LlmPurpose): string | undefined;
export function requestLlm(
  path: string,
  options?: {
    apiKey?: string | null;
    body?: unknown;
    formData?: FormData;
    method?: 'GET' | 'POST';
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<Response>;
