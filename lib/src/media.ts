export type MemoryMediaKind = 'image' | 'audio';

export interface MemoryMediaType {
  kind: MemoryMediaKind;
  mimeType: string;
}

const mediaTypes: Record<string, MemoryMediaType> = {
  '.jpg': { kind: 'image', mimeType: 'image/jpeg' },
  '.jpeg': { kind: 'image', mimeType: 'image/jpeg' },
  '.png': { kind: 'image', mimeType: 'image/png' },
  '.gif': { kind: 'image', mimeType: 'image/gif' },
  '.webp': { kind: 'image', mimeType: 'image/webp' },
  '.flac': { kind: 'audio', mimeType: 'audio/flac' },
  '.mp3': { kind: 'audio', mimeType: 'audio/mpeg' },
  '.mpeg': { kind: 'audio', mimeType: 'audio/mpeg' },
  '.mpga': { kind: 'audio', mimeType: 'audio/mpeg' },
  '.m4a': { kind: 'audio', mimeType: 'audio/mp4' },
  '.ogg': { kind: 'audio', mimeType: 'audio/ogg' },
  '.wav': { kind: 'audio', mimeType: 'audio/wav' },
  '.webm': { kind: 'audio', mimeType: 'audio/webm' },
};

/** Returns the supported image/audio kind and MIME type for an upload name. */
export function memoryMediaType(filename: string): MemoryMediaType | null {
  const extension = `.${String(filename).split('.').pop()?.toLowerCase() ?? ''}`;
  return mediaTypes[extension] ?? null;
}

/** Labels provider-derived media text so agents can distinguish it from authored source text. */
export function formatMediaEvidence(kind: MemoryMediaKind, value: unknown): string {
  const text = String(value ?? '').trim().slice(0, 500_000);
  if (!text) throw new Error('Media analysis returned no readable text.');
  return `${kind === 'image' ? 'Image description' : 'Audio transcript'}:\n${text}`;
}
