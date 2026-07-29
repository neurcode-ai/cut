import { createHash } from 'node:crypto';

export interface PinInput {
  origin: string;
  revision: string;
  path: string;
  range?: { start: number; end: number };
  bytes: Uint8Array;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function makePin(input: PinInput): string {
  if (!/^(?:[a-z0-9.-]+\/[^@\s]+|local\/[^@\s/]+)$/i.test(input.origin)) {
    throw new Error(`Unsafe pin origin: ${input.origin}`);
  }
  if (!/^(?:[0-9a-f]{40,64}|worktree|index)$/i.test(input.revision)) {
    throw new Error(`Unsafe pin revision: ${input.revision}`);
  }
  if (
    input.path.startsWith('/')
    || input.path.includes('\\')
    || input.path.includes('\0')
    || input.path.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new Error(`Unsafe pin path: ${input.path}`);
  }
  const encodedPath = input.path
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/!/g, '%21'))
    .join('/');
  const range = input.range
    ? `#L${input.range.start}${input.range.end === input.range.start ? '' : `-${input.range.end}`}`
    : '';
  return `${input.origin}@${input.revision}:${encodedPath}${range}!${sha256Bytes(input.bytes)}`;
}
