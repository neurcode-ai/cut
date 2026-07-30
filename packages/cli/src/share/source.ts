import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SHARE_LIMITS,
  readShareArchive,
  type ShareBundle,
} from '@neurcode-ai/share-format';
import {
  browserCliToken,
  fetchHostedArchive,
  parseHostedShareLink,
} from './hosted';
import { DEFAULT_API_URL } from '../config';

export interface LoadedShareSource {
  bundle: ShareBundle;
  entirelyLocal: boolean;
  source: string;
  hostedUrl?: string;
  hostedShareId?: string;
  bearerToken?: string;
}

function isHostedSource(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      || ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.protocol === 'http:');
  } catch {
    return false;
  }
}

export async function loadShareSource(input: {
  source: string;
  apiUrl?: string;
  authenticateHosted?: boolean;
  shareOrigin?: string;
}): Promise<LoadedShareSource> {
  if (!isHostedSource(input.source)) {
    const path = resolve(input.source);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error('Local Share source must be a regular non-link archive file.');
    }
    if (info.size < 1 || info.size > SHARE_LIMITS.compressedPackBytes) {
      throw new Error('Local Share archive exceeds the bounded compressed size.');
    }
    const bundle = readShareArchive(readFileSync(path));
    return { bundle, entirelyLocal: true, source: path };
  }

  const parsed = parseHostedShareLink(input.source);
  const apiUrl = (input.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  try {
    const fetched = await fetchHostedArchive({ url: input.source, apiUrl });
    return {
      bundle: fetched.bundle,
      entirelyLocal: false,
      source: input.source,
      hostedUrl: input.source,
      hostedShareId: parsed.shareId,
    };
  } catch (firstError) {
    if (input.authenticateHosted === false || parsed.agentLinkId || parsed.capability) throw firstError;
    const shareOrigin = (
      input.shareOrigin
      || process.env.NEURCODE_SHARE_WEB_URL
      || new URL(input.source).origin
    ).replace(/\/+$/, '');
    const bearerToken = await browserCliToken(apiUrl, shareOrigin, 'verify');
    const fetched = await fetchHostedArchive({
      url: input.source,
      apiUrl,
      bearerToken,
    });
    return {
      bundle: fetched.bundle,
      entirelyLocal: false,
      source: input.source,
      hostedUrl: input.source,
      hostedShareId: parsed.shareId,
      bearerToken,
    };
  }
}
